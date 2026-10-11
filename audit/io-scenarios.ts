import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { build } from 'esbuild';
import { ops, type AppState, type Store } from '../packages/core/src/index';
import { fixture, assert } from './harness';
import type { Scenario } from './scenarios';

const root = resolve(import.meta.dirname, '..');
function message(child: ChildProcess, type: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`IPC timeout: ${type}`)); }, 10_000);
    const onMessage = (m: { type: string }) => { if (m.type === type) { cleanup(); resolve(); } };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`worker exited before ${type}: ${code}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
}

export const fileWriters: Scenario = async () => {
  const home = mkdtempSync(join(tmpdir(), 'automedo-audit-writers-'));
  const workers: ChildProcess[] = [];
  try {
    writeFileSync(join(home, 'state.json'), JSON.stringify(fixture()));
    const spawn = async () => {
      const child = fork(join(root, 'audit/file-worker.ts'), { cwd: root, execArgv: ['--import', 'tsx'], env: { ...process.env, AUTOMEDO_HOME: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      workers.push(child);
      await message(child, 'loaded');
      return child;
    };
    const a = await spawn(); const b = await spawn();
    const save = async (c: ChildProcess, title: string) => {
      const saved = message(c, 'saved'); const exited = once(c, 'exit'); c.send({ title }); await saved; await exited;
    };
    await save(a, 'from A');
    assert.ok(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).plans[0].tasks.some((t: { title: string }) => t.title === 'from A'));
    await save(b, 'from B');
    const disk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    return { id: 'R03T', actual: disk.plans[0].tasks.map((t: { title: string }) => t.title).sort(), expected: ['from A', 'from B', 'original'] };
  } finally {
    for (const child of workers) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(home, { recursive: true, force: true });
  }
};

export const cliSaveFailure: Scenario = async () => {
  const home = mkdtempSync(join(tmpdir(), 'automedo-audit-enospc-'));
  try {
    writeFileSync(join(home, 'state.json'), JSON.stringify(fixture()));
    const result = spawnSync(process.execPath, ['--import', './audit/fault-preload.mjs', '--import', 'tsx', 'apps/tui/src/cli.tsx', 'add', 'not saved'], {
      cwd: root, env: { ...process.env, AUTOMEDO_HOME: home, AUDIT_INJECT_ENOSPC: '1' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).plans[0].tasks.some((t: { title: string }) => t.title === 'not saved');
    assert.equal(persisted, false);
    return { id: 'R08T', actual: { successfulExit: result.status === 0, errorReported: /ENOSPC|保存失败/.test(result.stdout + result.stderr) }, expected: { successfulExit: false, errorReported: true }, detail: { stdout: result.stdout.trim(), stderr: result.stderr.trim(), persisted } };
  } finally { rmSync(home, { recursive: true, force: true }); }
};

const bundleCache = new Map<string, string>();
async function bundle(entry: string): Promise<string> {
  const cached = bundleCache.get(entry); if (cached) return cached;
  const result = await build({ entryPoints: [join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const code = result.outputFiles[0].text; bundleCache.set(entry, code); return code;
}
export async function browserStoreContext(shared: Map<string, string>) {
  const window = new EventTarget();
  const context = createContext({ module: { exports: {} }, require: createRequire(import.meta.url), structuredClone, setTimeout, clearTimeout, console,
    window, localStorage: { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v); } },
  });
  runInContext(await bundle('apps/web/src/store.ts'), context);
  const api = context.module.exports as { createBrowserStore(s: AppState): Store; loadFromStorage(): { state: AppState }; };
  return { store: api.createBrowserStore(api.loadFromStorage().state), window };
}

export const browserWriters: Scenario = async () => {
  const shared = new Map([['automedo.v0', JSON.stringify(fixture())]]);
  const a = await browserStoreContext(shared); const b = await browserStoreContext(shared);
  try {
    a.store.mutate('A', d => ops.addTask(d, 'from A')); a.store.flush();
    b.window.dispatchEvent(new Event('storage')); // production code has no storage listener
    b.store.mutate('B', d => ops.addTask(d, 'from B')); b.store.flush();
    a.window.dispatchEvent(new Event('storage'));
    return { id: 'R03W', actual: JSON.parse(shared.get('automedo.v0')!).plans[0].tasks.map((t: { title: string }) => t.title).sort(), expected: ['from A', 'from B', 'original'] };
  } finally { a.store.flush(); b.store.flush(); }
};

export async function serviceWorker() {
  const handlers = new Map<string, (event: any) => void>();
  const cache = new Map<string, Response>([['./', new Response('<html>working shell</html>')]]);
  let mode: '503' | 'offline' = '503';
  const writes: Promise<void>[] = [];
  const context = createContext({ URL,
    self: { location: { origin: 'https://audit.invalid' }, addEventListener: (type: string, fn: (event: any) => void) => handlers.set(type, fn) },
    caches: { open: async () => ({ put: (key: string, r: Response) => { const write = Promise.resolve().then(() => { cache.set(key, r); }); writes.push(write); return write; } }), match: async (key: string) => cache.get(key)?.clone() },
    fetch: async () => { if (mode === 'offline') throw new TypeError('injected offline'); return new Response('temporary outage', { status: 503 }); },
  });
  const source = readFileSync(join(root, 'apps/web/sw-template.js'), 'utf8').replace('__VERSION__', 'audit').replace('__PRECACHE__', '[]');
  runInContext(source, context);
  const navigate = async () => {
    let response!: Promise<Response>;
    handlers.get('fetch')!({ request: { method: 'GET', url: 'https://audit.invalid/', mode: 'navigate' }, respondWith: (p: Promise<Response>) => { response = p; } });
    const result = await response;
    await Promise.all(writes);
    return result;
  };
  return { navigate, offline: () => { mode = 'offline'; } };
}

export const poisonedShell: Scenario = async () => {
  const sw = await serviceWorker();
  assert.equal((await sw.navigate()).status, 503);
  sw.offline(); const offline = await sw.navigate();
  return { id: 'R14', actual: { status: offline.status, body: await offline.text() }, expected: { status: 200, body: '<html>working shell</html>' } };
};

export const ioScenarios: Scenario[] = [fileWriters, browserWriters, cliSaveFailure, poisonedShell];
