// HTTP layer: /v1/health, /v1/sync, /v1/export, and optional static hosting of the web app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { compose, emptyState, type RecordKind, type SyncRequest } from '@automedo/core';
import { MassDeleteError, type RecordDb } from './db';
import type { PushService } from './push';

export const VERSION = '0.2.0';
const MAX_BODY = 20 * 1024 * 1024;
const KINDS = new Set<RecordKind>(['plan', 'goal', 'phase', 'task', 'version', 'checkpoint', 'log', 'session', 'compact', 'fatigue', 'settings', 'hie']);
const REV = /^[0-9a-z]{9}\.[\w-]{1,64}$/;

export interface AppOptions {
  db: RecordDb;
  /** Bearer token. `null` disables auth (only for local development). */
  token: string | null;
  /** Serve this directory (the built web app) at `/`. */
  webDir?: string;
  push?: PushService;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function cors(res: ServerResponse, req: IncomingMessage) {
  // Auth is a bearer token (no cookies), so reflecting the origin is safe.
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-max-age', '600');
}

function checkAuth(req: IncomingMessage, token: string | null) {
  if (token === null) return;
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function validateSync(body: unknown): SyncRequest {
  const b = body as Partial<SyncRequest>;
  if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be an object');
  if (typeof b.clientId !== 'string' || !/^[\w-]{1,64}$/.test(b.clientId)) throw new HttpError(400, 'bad clientId');
  if (!Number.isInteger(b.cursor) || (b.cursor as number) < 0) throw new HttpError(400, 'bad cursor');
  if (!Array.isArray(b.changes) || b.changes.length > 100_000) throw new HttpError(400, 'bad changes');
  for (const c of b.changes) {
    if (!c || typeof c.id !== 'string' || c.id.length > 200) throw new HttpError(400, 'bad record id');
    if (!KINDS.has(c.kind)) throw new HttpError(400, `bad record kind: ${String(c.kind)}`);
    if (typeof c.rev !== 'string' || !REV.test(c.rev)) throw new HttpError(400, `bad rev for ${c.id}`);
    if (c.parent !== undefined && typeof c.parent !== 'string') throw new HttpError(400, `bad parent for ${c.id}`);
    if (!c.deleted && c.data === undefined) throw new HttpError(400, `missing data for ${c.id}`);
  }
  if (b.confirmDeleteIds !== undefined && (!Array.isArray(b.confirmDeleteIds) || b.confirmDeleteIds.length > 100_000 || !b.confirmDeleteIds.every((x) => typeof x === 'string'))) throw new HttpError(400, 'bad confirmDeleteIds');
  if (b.cursorTag !== undefined && (typeof b.cursorTag !== 'string' || b.cursorTag.length > 200)) throw new HttpError(400, 'bad cursorTag');
  return b as SyncRequest;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const base = resolve(root);
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  let file = resolve(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) return false; // path traversal
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(base, 'index.html'); // SPA fallback
  }
  try {
    const body = await readFile(file);
    // Only content-hashed build assets are immutable; the shell, service worker and manifest must revalidate.
    const immutable = /[\\/]assets[\\/]/.test(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(opts: AppOptions): Server {
  return createServer(async (req, res) => {
    try {
      // Never let a malformed request line (e.g. "//" or "//host") throw outside the handler.
      const raw = req.url ?? '/';
      const url = new URL('http://localhost' + (raw.startsWith('/') ? raw : '/' + raw));
      if (url.pathname.startsWith('/v1/')) {
        cors(res, req);
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        if (url.pathname === '/v1/health' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION, auth: opts.token !== null });
        checkAuth(req, opts.token);
        if (url.pathname === '/v1/sync' && req.method === 'POST') return send(res, 200, opts.db.sync(validateSync(await readJson(req))));
        if (url.pathname === '/v1/export' && req.method === 'GET') {
          return send(res, 200, compose(opts.db.all().map((r) => ({ id: r.id, kind: r.kind, parent: r.parent, data: r.data })), emptyState().ui));
        }
        if (url.pathname === '/v1/stats' && req.method === 'GET') return send(res, 200, { ...opts.db.stats(), pushSubscriptions: opts.push?.count() ?? 0 });
        if (url.pathname.startsWith('/v1/push/')) {
          const push = opts.push ?? (() => { throw new HttpError(404, 'push disabled'); })();
          if (url.pathname === '/v1/push/key' && req.method === 'GET') return send(res, 200, { publicKey: push.publicKey });
          if (url.pathname === '/v1/push/subscribe' && req.method === 'POST') {
            const b = (await readJson(req)) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; label?: unknown };
            const s = b?.subscription;
            if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') throw new HttpError(400, 'bad subscription');
            push.subscribe(s as never, typeof b.label === 'string' ? b.label.slice(0, 80) : undefined);
            return send(res, 200, { ok: true });
          }
          if (url.pathname === '/v1/push/unsubscribe' && req.method === 'POST') {
            const b = (await readJson(req)) as { endpoint?: unknown };
            if (typeof b?.endpoint !== 'string') throw new HttpError(400, 'bad endpoint');
            push.unsubscribe(b.endpoint);
            return send(res, 200, { ok: true });
          }
          if (url.pathname === '/v1/push/test' && req.method === 'POST') {
            return send(res, 200, await push.broadcast({ title: '✻ AuTomeDo', body: '提醒已开启。Checkpoint 到期、阶段逾期、专注超时时会通知你。', tag: 'test' }));
          }
        }
        throw new HttpError(404, 'not found');
      }
      if (opts.webDir && (req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(opts.webDir, url.pathname, res))) return;
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof MassDeleteError) return send(res, 409, e.guard);
      if (e instanceof URIError) return send(res, 400, { error: 'bad url' });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  });
}
