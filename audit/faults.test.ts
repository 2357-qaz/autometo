import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDocPersistence, createStore, newSyncMeta, prepareSync, ops, makeRev } from '../packages/core/src/index';
import { openDb, MassDeleteError } from '../packages/server/src/db';
import { device, server, fixture, title, T0, assert, gate } from './harness';

afterEach(() => vi.restoreAllMocks());

describe('actual process crash boundaries (SIGKILL, not power loss)', () => {
  for (const kind of ['file', 'sqlite']) for (const boundary of ['before', 'after']) {
    it(`${kind}: kill ${boundary} commit leaves a coherent recoverable snapshot`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'automedo-audit-crash-'));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        if (kind === 'file') writeFileSync(join(home, 'state.json'), JSON.stringify({ ...fixture(), syncMeta: { ...newSyncMeta('seed'), cursor: 7 } }));
        else {
          const db = openDb(join(home, 'db.sqlite'));
          db.sync(prepareSync(fixture(), newSyncMeta('seed'), T0).request); db.close();
        }
        child = spawn(process.execPath, ['--import', 'tsx', 'audit/crash-worker.ts', kind, boundary], {
          cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, AUTOMEDO_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr!.on('data', b => { stderr += b; });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 10_000);
          let stdout = '';
          child!.once('exit', code => { clearTimeout(timer); reject(new Error(`unexpected early exit ${code}: ${stderr}`)); });
          child!.once('error', e => { clearTimeout(timer); reject(e); });
          child!.stdout!.on('data', b => {
            stdout += b;
            if (stdout.includes('AUDIT_CHECKPOINT')) { clearTimeout(timer); resolve(); }
          });
        });
        const exited = once(child, 'exit'); child.kill('SIGKILL');
        const [, signal] = await exited; expect(signal).toBe('SIGKILL');
        if (kind === 'file') {
          const doc = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
          expect([doc.plans[0].tasks[0].title, doc.syncMeta.cursor]).toEqual(boundary === 'before' ? ['original', 7] : ['committed', 42]);
        } else {
          const db = openDb(join(home, 'db.sqlite'));
          try {
            const records = db.all();
            expect((records.find(r => r.id === 'task:t')!.data as { title: string }).title).toBe(boundary === 'before' ? 'original' : 'committed');
            expect(records.filter(r => r.kind === 'log')).toHaveLength(boundary === 'before' ? 0 : 1);
            expect(db.raw.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
          } finally { db.close(); }
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

it('SQLite rolls the whole batch back when its second write aborts', () => {
  const db = openDb(':memory:');
  try {
    db.sync(prepareSync(fixture(), newSyncMeta('seed'), T0).request);
    const before = db.all(); const stats = db.stats();
    db.raw.exec("CREATE TRIGGER inject_abort BEFORE INSERT ON records WHEN NEW.id = 'task:bad' BEGIN SELECT RAISE(ABORT, 'injected IO failure'); END;");
    expect(() => db.sync({ clientId: 'writer', cursor: 0, changes: [
      { id: 'task:t', kind: 'task', parent: 'plan:p', rev: makeRev(T0 + 100, 'writer'), data: { ...fixture().plans[0].tasks[0], title: 'must rollback' } },
      { id: 'task:bad', kind: 'task', rev: makeRev(T0 + 101, 'writer'), data: {} },
    ] })).toThrow(/injected IO failure/);
    expect(db.all()).toEqual(before); expect(db.stats()).toEqual(stats);
  } finally { db.close(); }
});

it('mass-delete refusal is atomic even if an unrelated update precedes tombstones', () => {
  const db = openDb(':memory:');
  try {
    db.sync(prepareSync(fixture(), newSyncMeta('seed'), T0).request);
    const before = db.all(); const stats = db.stats();
    expect(() => db.sync({ clientId: 'writer', cursor: 0, changes: [
      { id: 'task:t', kind: 'task', parent: 'plan:p', rev: makeRev(T0 + 100, 'writer'), data: { ...fixture().plans[0].tasks[0], title: 'must rollback' } },
      { id: 'plan:p', kind: 'plan', rev: makeRev(T0 + 101, 'writer'), deleted: true },
    ] })).toThrow(MassDeleteError);
    expect(db.all()).toEqual(before); expect(db.stats()).toEqual(stats);
  } finally { db.close(); }
});

it('a failed atomic metadata write leaves the previous durable pair on restart', () => {
  const d = device('A', fixture());
  try {
    d.store.mutate('initial UI change', s => { s.ui.lastSeenAt++; }); d.store.flush();
    const before = d.disk.text;
    d.store.mutate('edit', s => ops.updateTask(s, 't', { title: 'not durable' }));
    d.disk.fail = true;
    expect(() => d.persistence.saveMeta({ ...newSyncMeta('A'), cursor: 42 })).toThrow(/ENOSPC/);
    expect(d.disk.text).toBe(before);
    const restarted = createDocPersistence({ read: () => d.disk.text, write() { throw new Error('read only recovery'); } });
    expect(restarted.load().state.plans[0].tasks[0].title).toBe('original');
    expect(restarted.loadMeta()!.cursor).toBe(0);
  } finally { d.close(); }
});

it('request rejected before server commit can be retried without duplicate records', async () => {
  const srv = await server(); let fail = false;
  const a = device('A', fixture(), srv.cfg, async (input, init) => {
    if (fail) { fail = false; throw new TypeError('injected before request'); }
    return fetch(input, init);
  });
  try {
    await a.sync();
    a.store.mutate('edit', d => ops.updateTask(d, 't', { title: 'retry succeeds' }));
    const stats = srv.db.stats(); fail = true;
    await expect(a.sync()).rejects.toThrow(/before request/); expect(srv.db.stats()).toEqual(stats);
    await a.sync(); const after = srv.db.stats(); await a.sync(); expect(srv.db.stats()).toEqual(after);
    expect(title(a)).toBe('retry succeeds');
  } finally { a.close(); await srv.close(); }
});

it('mid-flight deletion of a just-created record still sends a tombstone', async () => {
  const srv = await server(); let inject = false;
  const a = device('A', fixture(), srv.cfg, async (input, init) => {
    const response = await fetch(input, init);
    if (inject) { inject = false; a.store.mutate('delete new task', d => ops.deleteTask(d, 'new')); }
    return response;
  });
  try {
    await a.sync();
    a.store.mutate('add new', d => { d.plans[0].tasks.push({ ...d.plans[0].tasks[0], id: 'new' }); });
    inject = true; await a.sync();
    expect(prepareSync(a.store.get(), a.persistence.loadMeta()!).request.changes).toContainEqual(expect.objectContaining({ id: 'task:new', deleted: true }));
    await a.sync(); expect(srv.db.all().some(r => r.id === 'task:new')).toBe(false);
  } finally { a.close(); await srv.close(); }
});

it('bad auth leaves the local state and durable document intact', async () => {
  const srv = await server(); const a = device('A', fixture());
  try {
    const state = a.store.get(); const disk = a.disk.text;
    await expect(a.client.connect({ ...srv.cfg, token: 'invalid' })).rejects.toThrow(/令牌/);
    expect(a.store.get()).toBe(state); expect(a.disk.text).toBe(disk); expect(a.storage.loadConfig()).toBeNull();
  } finally { a.close(); await srv.close(); }
});

it('restore-from-server recovers a guarded deletion in an isolated database', async () => {
  const srv = await server(); const a = device('A', fixture(), srv.cfg);
  try {
    await a.sync(); const before = srv.db.all();
    a.store.mutate('delete', d => ops.deleteWs(d, 'p'));
    await expect(a.sync()).rejects.toThrow(/已暂停/);
    await a.client.restoreFromServer();
    expect(a.store.get().plans[0].id).toBe('p'); expect(srv.db.all()).toEqual(before);
  } finally { a.close(); await srv.close(); }
});

it('unsaved debounce-window crash loses only the uncommitted snapshot (documented boundary)', () => {
  vi.useFakeTimers();
  try {
    let disk = JSON.stringify(fixture());
    const store = createStore(fixture(), { save: s => { disk = JSON.stringify(s); } }, 150);
    store.mutate('edit', d => ops.updateTask(d, 't', { title: 'not flushed' }));
    expect(store.get().plans[0].tasks[0].title).toBe('not flushed');
    expect(JSON.parse(disk).plans[0].tasks[0].title).toBe('original');
    vi.advanceTimersByTime(150);
    expect(JSON.parse(disk).plans[0].tasks[0].title).toBe('not flushed');
  } finally { vi.useRealTimers(); }
});

it('a hung transport blocks queued syncs until it settles (no real sleeping)', async () => {
  const srv = await server(); const reached = gate(); const release = gate();
  let hang = false; let requests = 0;
  const a = device('A', fixture(), srv.cfg, async (input, init) => {
    requests++;
    if (hang) { hang = false; reached.release(); await release.promise; }
    return fetch(input, init);
  });
  try {
    await a.sync(); hang = true; const first = a.sync(); await reached.promise;
    const before = requests; const queued = a.client.syncNow();
    await Promise.resolve(); assert.equal(requests, before);
    expect(a.client.getStatus().phase).toBe('syncing');
    release.release(); await first; await queued;
    await a.sync(); // drain any coalesced follow-up before closing
  } finally { release.release(); a.close(); await srv.close(); }
});
