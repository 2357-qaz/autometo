// HTTP layer: /v1/health, /v1/sync, /v1/export, and optional static hosting of the web app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { compose, emptyState, type RecordKind, type SyncRequest } from '@automedo/core';
import type { RecordDb } from './db';

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
    const isIndex = file.endsWith('index.html');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(opts: AppOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
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
        if (url.pathname === '/v1/stats' && req.method === 'GET') return send(res, 200, opts.db.stats());
        throw new HttpError(404, 'not found');
      }
      if (opts.webDir && (req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(opts.webDir, url.pathname, res))) return;
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  });
}
