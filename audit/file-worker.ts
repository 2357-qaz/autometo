// A second real TUI storage process, controlled with IPC rather than sleeps.
import { createStore, ops } from '../packages/core/src/index';
import { loadState, attachStore, filePersist } from '../apps/tui/src/storage';

if (!process.env.AUTOMEDO_HOME || !process.send) throw new Error('isolated audit home and IPC required');
const loaded = loadState();
if (loaded.error) throw new Error(loaded.error);
const store = createStore(loaded.state, filePersist, 60_000);
attachStore(store);
process.send({ type: 'loaded' });
process.once('message', (message: { title: string }) => {
  store.mutate('audit append', d => ops.addTask(d, message.title));
  store.flush();
  if (store.saveError()) throw new Error(store.saveError()!);
  process.send!({ type: 'saved' }, () => process.disconnect());
});
