import { ops, activeSession, otherSessions, compose, decompose, createStore, createDocPersistence, emptyState, parseImport, prepareSync } from '../packages/core/src/index';
import { server, device, fixture, gate, title, titles, assert, T0 } from './harness';

export interface Evidence { id: string; actual: unknown; expected: unknown; detail?: unknown }
export type Scenario = () => Promise<Evidence>;

export const lostAcknowledgement: Scenario = async () => {
  const srv = await server();
  let drop = false;
  const a = device('A', fixture(), srv.cfg, async (input, init) => {
    const response = await fetch(input, init);
    if (drop) { drop = false; await response.text(); throw new TypeError('injected response lost AFTER COMMIT'); }
    return response;
  });
  const b = device('B', emptyState(T0), srv.cfg);
  try {
    await a.sync(); await b.sync();
    a.store.mutate('A edit', d => ops.updateTask(d, 't', { title: 'A stale retry' }));
    drop = true;
    await assert.rejects(a.sync(), /AFTER COMMIT/);
    await b.sync(); assert.equal(title(b), 'A stale retry');
    b.store.mutate('B later edit', d => ops.updateTask(d, 't', { title: 'B acknowledged' }));
    await b.sync(); assert.equal(title(b), 'B acknowledged');
    await a.sync(); await b.sync();
    return { id: 'R01', actual: title(b), expected: 'B acknowledged' };
  } finally { a.close(); b.close(); await srv.close(); }
};

export const undoRemote: Scenario = async () => {
  const srv = await server(); const a = device('A', fixture(), srv.cfg); const b = device('B', emptyState(T0), srv.cfg);
  try {
    await a.sync(); await b.sync();
    a.store.mutate('rename locally', d => ops.renameWs(d, 'p', 'renamed'));
    await a.sync(); await b.sync();
    b.store.mutate('remote addition', d => ops.addTask(d, 'remote task'));
    await b.sync(); await a.sync(); assert.ok(titles(a).includes('remote task'));
    assert.equal(a.store.undo()?.label, 'rename locally'); // undo() returns { label, undone, skipped } since the fix
    await a.sync(); await b.sync();
    return { id: 'R02', actual: titles(b).includes('remote task'), expected: true, detail: { serverTitles: titles(b), guard: a.client.getStatus().confirm } };
  } finally { a.close(); b.close(); await srv.close(); }
};

export const versionCollision: Scenario = async () => {
  const srv = await server(); const a = device('A', fixture(), srv.cfg); const b = device('B', emptyState(T0), srv.cfg);
  try {
    await a.sync(); await b.sync();
    a.store.mutate('commit A', d => ops.commitPlan(d, 'snapshot A'));
    b.store.mutate('commit B', d => ops.commitPlan(d, 'snapshot B'));
    await a.sync(); await b.sync(); await a.sync();
    return { id: 'R04', actual: a.store.get().plans[0].versions.map(v => v.message).sort(), expected: ['snapshot A', 'snapshot B'],
      detail: { commitLogs: a.store.get().plans[0].log.filter(e => e.type === 'commit').length } };
  } finally { a.close(); b.close(); await srv.close(); }
};

// Rewritten for the decided semantics (owner's call): sessions on different devices run
// in PARALLEL, each device keeps its own current task, and the other device's work is
// shown — never silently closed or overwritten. The original expectation (1 active task,
// 1 open session after sync) is exactly the silent overwrite the owner ruled out.
export const concurrentActive: Scenario = async () => {
  const srv = await server(); const s = fixture();
  s.plans[0].tasks.push({ ...s.plans[0].tasks[0], id: 't2', title: 'second' });
  const a = device('A', s, srv.cfg); const b = device('B', emptyState(T0), srv.cfg);
  try {
    await a.sync(); await b.sync();
    a.store.mutate('start A', d => { ops.setTaskStatus(d, 't', 'active'); ops.startSession(d, { intent: 'A', plannedMin: 25, tier: 'sonnet', effort: 'medium' }); });
    b.store.mutate('start B', d => { ops.setTaskStatus(d, 't2', 'active'); ops.startSession(d, { intent: 'B', plannedMin: 25, tier: 'sonnet', effort: 'medium' }); });
    await a.sync(); await b.sync(); await a.sync();
    const view = (x: typeof a) => {
      const st = x.store.get(); const ws = st.plans[0];
      return { mine: ops.currentTask(ws, st)?.title, session: activeSession(st)?.intent, elsewhere: ops.otherActiveTasks(ws, st).map(t => t.title), others: otherSessions(st).map(o => o.intent) };
    };
    return { id: 'R05', actual: { a: view(a), b: view(b), openSessions: a.store.get().sessions.filter(x => x.endedAt == null).length },
      expected: { a: { mine: 'original', session: 'A', elsewhere: ['second'], others: ['B'] }, b: { mine: 'second', session: 'B', elsewhere: ['original'], others: ['A'] }, openSessions: 2 } };
  } finally { a.close(); b.close(); await srv.close(); }
};

export const rollbackDuringConnect: Scenario = async () => {
  const srv = await server(); const reached = gate(); const resume = gate();
  let posts = 0;
  const a = device('A', fixture(), null, async (input, init) => {
    if (String(input).endsWith('/v1/sync') && ++posts === 2) {
      reached.release(); await resume.promise; return new Response('injected push failure', { status: 500 });
    }
    return fetch(input, init);
  });
  try {
    const connecting = a.client.connect(srv.cfg);
    const rejected = assert.rejects(connecting, /500/);
    await reached.promise;
    a.store.mutate('edit while connecting', d => ops.addTask(d, 'must survive rollback'));
    a.store.flush(); assert.ok(JSON.parse(a.disk.text).plans[0].tasks.some((t: { title: string }) => t.title === 'must survive rollback'));
    resume.release(); await rejected;
    return { id: 'R06', actual: titles(a).includes('must survive rollback'), expected: true, detail: { config: a.storage.loadConfig(), diskTitles: JSON.parse(a.disk.text).plans[0].tasks.map((t: { title: string }) => t.title) } };
  } finally { resume.release(); a.close(); await srv.close(); }
};

export const serverRollback: Scenario = async () => {
  const srv = await server(); const a = device('A', fixture(), srv.cfg);
  try {
    await a.sync();
    // Save a real SQLite row snapshot before the acknowledged edit (synthetic DB only).
    const old = srv.db.raw.prepare('SELECT * FROM records').all();
    a.store.mutate('edit', d => ops.updateTask(d, 't', { title: 'acknowledged new value' }));
    await a.sync();
    // Simulate administrator restoring an older DB at exactly the same URL.
    srv.db.raw.exec('DELETE FROM records');
    const insert = srv.db.raw.prepare('INSERT INTO records(id,kind,parent,rev,seq,deleted,data,client) VALUES(?,?,?,?,?,?,?,?)');
    for (const r of old) insert.run(r.id, r.kind, r.parent, r.rev, r.seq, r.deleted, r.data, r.client);
    await a.sync(); await a.sync();
    const b = device('B', emptyState(T0), srv.cfg);
    try {
      await b.sync();
      return { id: 'R07', actual: { a: title(a), b: title(b), status: a.client.getStatus().phase }, expected: { a: 'acknowledged new value', b: 'acknowledged new value', status: 'idle' } };
    } finally { b.close(); }
  } finally { a.close(); await srv.close(); }
};

export const flushRetry: Scenario = async () => {
  let writes = 0; let fail = true; let disk = JSON.stringify(fixture());
  const store = createStore(fixture(), { save(s) { writes++; if (fail) throw new Error('injected ENOSPC'); disk = JSON.stringify(s); } }, 60_000);
  store.mutate('edit', d => ops.updateTask(d, 't', { title: 'must persist' }));
  store.flush(); assert.match(store.saveError()!, /ENOSPC/);
  fail = false; store.flush();
  return { id: 'R08', actual: JSON.parse(disk).plans[0].tasks[0].title, expected: 'must persist', detail: { writes, error: store.saveError() } };
};

// Adapted after the fix: importing goes through parseImport (normalize is also the
// load path of the device's own data, which must not lock the user out). Stricter than
// before: import must reject AND loading such data must keep both entities.
export const duplicateImport: Scenario = async () => {
  const s = fixture(); s.plans[0].tasks.push({ ...s.plans[0].tasks[0], title: 'different content, same id' });
  let rejected = false;
  try { parseImport(s); } catch { rejected = true; }
  const loaded = createDocPersistence({ read: () => JSON.stringify(s), write() {} }).load().state;
  return { id: 'R09', actual: { rejected, keptOnLoad: compose(decompose(loaded).values(), s.ui).plans[0].tasks.length }, expected: { rejected: true, keptOnLoad: 2 }, detail: { before: s.plans[0].tasks.length } };
};

export const reviseBaseline: Scenario = async () => {
  const s = fixture(); ops.revisePhase(s, 'ph', 'changed goal', 'new information');
  return { id: 'R10', actual: s.plans[0].versions[0].phases[0].goal, expected: 'original goal', detail: s.plans[0].versions.map(v => ({ v: v.v, goal: v.phases[0].goal })) };
};

export const staleConfirmation: Scenario = async () => {
  const srv = await server(); const s = fixture();
  for (const id of ['q', 'r']) s.plans.push({ ...structuredClone(s.plans[0]), id, title: id, phases: [], tasks: [] });
  const a = device('A', s, srv.cfg);
  try {
    await a.sync();
    a.store.mutate('delete p q', d => { ops.deleteWs(d, 'p'); ops.deleteWs(d, 'q'); });
    await assert.rejects(a.sync(), /已暂停/);
    const shown = a.client.getStatus().confirm!;
    assert.deepEqual(shown.workspaces.map(w => w.title).sort(), ['P', 'q']);
    a.store.undo();
    a.store.mutate('different deletion', d => { ops.deleteWs(d, 'q'); ops.deleteWs(d, 'r'); });
    await a.client.confirmDeletes();
    return { id: 'R11', actual: srv.db.all().filter(r => r.kind === 'plan').map(r => (r.data as { title: string }).title).sort(), expected: ['P', 'q', 'r'], detail: { approvedNames: shown.workspaces.map(w => w.title), newGuard: a.client.getStatus().confirm } };
  } finally { a.close(); await srv.close(); }
};

export const orderCollision: Scenario = async () => {
  const srv = await server(); const a = device('A', fixture(), srv.cfg); const b = device('B', emptyState(T0), srv.cfg);
  try {
    await a.sync(); await b.sync();
    a.store.mutate('append A', d => ops.addTask(d, 'A appended'));
    b.store.mutate('append B', d => ops.addTask(d, 'B appended'));
    await a.sync(); await b.sync(); await a.sync();
    const initial = { a: titles(a), b: titles(b) };
    for (let i = 0; i < 4; i++) { await b.sync(); await a.sync(); }
    return { id: 'R12', actual: titles(a), expected: titles(b), detail: { initial, finalA: titles(a), finalB: titles(b) } };
  } finally { a.close(); b.close(); await srv.close(); }
};

export const inflightPending: Scenario = async () => {
  const srv = await server(); let inject = false;
  const a = device('A', fixture(), srv.cfg, async (input, init) => {
    const r = await fetch(input, init);
    if (inject) { inject = false; a.store.mutate('midflight', d => ops.addTask(d, 'not on server')); }
    return r;
  });
  try {
    await a.sync(); inject = true; await a.sync();
    const pending = prepareSync(a.store.get(), a.persistence.loadMeta()!).request.changes.length;
    assert.ok(pending > 0);
    return { id: 'R13', actual: a.client.getStatus().pending, expected: pending, detail: { phase: a.client.getStatus().phase } };
  } finally { a.close(); await srv.close(); }
};

export const scenarios: Scenario[] = [lostAcknowledgement, undoRemote, versionCollision, concurrentActive, rollbackDuringConnect, serverRollback, flushRetry, duplicateImport, reviseBaseline, staleConfirmation, orderCollision, inflightPending];
