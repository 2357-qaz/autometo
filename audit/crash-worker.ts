// Deliberately stops at a real persistence boundary; the parent SIGKILLs this
// disposable process after reading the checkpoint, then opens the same file/DB.
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fixture, T0 } from './harness';
import { createStore, newSyncMeta, ops, prepareSync } from '../packages/core/src/index';
import { openDb } from '../packages/server/src/db';

const home = process.env.AUTOMEDO_HOME;
const [kind, boundary] = process.argv.slice(2);
if (!home || !['file', 'sqlite'].includes(kind) || !['before', 'after'].includes(boundary)) throw new Error('isolated audit arguments required');
function checkpoint(): never {
  fs.writeSync(1, 'AUDIT_CHECKPOINT\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('checkpoint unexpectedly resumed');
}
if (kind === 'file') {
  const rename = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    if (String(newPath) === join(home, 'state.json') && boundary === 'before') checkpoint();
    rename(oldPath, newPath);
    if (String(newPath) === join(home, 'state.json') && boundary === 'after') checkpoint();
  };
  syncBuiltinESMExports();
  const { loadState, filePersist, attachStore, fileSyncStorage } = await import('../apps/tui/src/storage');
  const loaded = loadState();
  if (loaded.error) throw new Error(loaded.error);
  const store = createStore(loaded.state, filePersist, 60_000);
  attachStore(store);
  store.mutate('edit', d => { d.plans[0].tasks[0].title = 'committed'; });
  fileSyncStorage.updateMeta(() => ({ ...newSyncMeta('crash'), cursor: 42 }));
} else {
  const db = openDb(join(home, 'db.sqlite'));
  const s = fixture(); ops.updateTask(s, 't', { title: 'committed' });
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) {
    if (sql === 'COMMIT' && boundary === 'before') checkpoint();
    exec.call(this, sql);
    if (sql === 'COMMIT' && boundary === 'after') checkpoint();
  };
  db.sync(prepareSync(s, newSyncMeta('crash'), T0 + 1000).request);
}
throw new Error('worker did not reach expected checkpoint');
