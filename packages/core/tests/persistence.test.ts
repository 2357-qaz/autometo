import { describe, expect, it } from 'vitest';
import { createDocPersistence } from '../src/persistence';
import { createStore } from '../src/store';
import { emptyState, normalize } from '../src/state';
import { newSyncMeta } from '../src/sync';
import * as ops from '../src/ops';

function disk(initial: string | null = null) {
  const d = { doc: initial, writes: 0 };
  return { d, io: { read: () => d.doc, write: (t: string) => void ((d.doc = t), d.writes++) } };
}

describe('single-document persistence', () => {
  it('saveMeta writes meta and the current state in one write', () => {
    const { d, io } = disk();
    const p = createDocPersistence(io);
    p.load();
    const store = createStore(emptyState(), p.persist, 10_000); // debounced save far away
    p.attach(store);
    store.mutate('x', (s) => void ops.createPlan(s, '同一次写入'));
    expect(d.writes).toBe(0); // state not written yet (debounce)
    p.saveMeta({ ...newSyncMeta('dev'), cursor: 42 });
    expect(d.writes).toBe(1);
    const doc = JSON.parse(d.doc!);
    expect(doc.syncMeta.cursor).toBe(42);
    expect(doc.plans[0].title).toBe('同一次写入');
    // Reloading yields the same pair.
    const p2 = createDocPersistence(io);
    expect(p2.load().state.plans[0].title).toBe('同一次写入');
    expect(p2.loadMeta()?.cursor).toBe(42);
  });

  it('adopts meta from the legacy location, and the meta never leaks into state', () => {
    const legacy = { ...newSyncMeta('old'), cursor: 7 };
    const { io } = disk(JSON.stringify(emptyState()));
    const p = createDocPersistence(io, () => legacy);
    const { state } = p.load();
    expect(p.loadMeta()?.cursor).toBe(7);
    expect('syncMeta' in state).toBe(false);
  });

  it("imported data never carries another device's sync meta", () => {
    const s = normalize({ ...emptyState(), syncMeta: { clientId: 'x', cursor: 99, base: {}, lastT: 0 } });
    expect('syncMeta' in s).toBe(false);
  });
});
