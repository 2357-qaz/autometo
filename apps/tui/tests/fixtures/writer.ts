// A second (third…) automedo process writing state.json as fast as it can.
import { createStore, ops } from '@automedo/core';
import { attachStore, filePersist, loadState } from '../../src/storage';

const [name, count] = [process.argv[2], Number(process.argv[3])];
const store = createStore(loadState().state, filePersist, 0);
attachStore(store);
for (let i = 0; i < count; i++) {
  store.mutate('add', (d) => void ops.addTask(d, `${name} ${i}`));
  if (!store.flush()) throw new Error(store.saveError() ?? 'save failed');
}
