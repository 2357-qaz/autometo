import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/store';
import { createDocPersistence } from '../src/persistence';
import { SyncClient } from '../src/sync-client';
import * as ops from '../src/ops';

describe('retrying after a failed sync', () => {
  it('retries with backoff on its own, without waiting for the next interval', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        calls++;
        if (calls <= 2) throw new TypeError('offline'); // stats ok? no: everything fails twice
        if (String(input).endsWith('/v1/stats')) return new Response('{}');
        return new Response(JSON.stringify({ cursor: 1, cursorTag: 'e.1.x', records: [] }));
      };
      let doc: string | null = null;
      const p = createDocPersistence({ read: () => doc, write: (t) => void (doc = t) });
      const store = createStore(p.load().state, p.persist, 0);
      p.attach(store);
      const client = new SyncClient(store, { loadConfig: () => ({ url: 'http://x', token: 't' }), saveConfig() {}, loadMeta: p.loadMeta, updateMeta: p.updateMeta }, { fetchImpl, intervalMs: 3_600_000, debounceMs: 3_600_000 });
      store.mutate('x', (d) => void ops.createPlan(d, 'P'));
      client.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(client.getStatus().phase).toBe('offline');
      await vi.advanceTimersByTimeAsync(2_000); // 1st retry after 2 s: fails again
      expect(client.getStatus().phase).toBe('offline');
      await vi.advanceTimersByTimeAsync(4_000); // 2nd retry after 4 s: goes through
      expect(client.getStatus()).toMatchObject({ phase: 'idle', pending: 0 });
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
