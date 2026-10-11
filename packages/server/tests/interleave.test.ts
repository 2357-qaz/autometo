// Interleavings the happy paths don't reach: two windows of one device editing in the
// same millisecond, and a full reconciliation whose upload is partly refused because
// another device wrote between the pull and the push.
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDocPersistence, createStore, ops, SyncClient, type AppState, type SyncConfig } from '@automedo/core';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const TOKEN = 'interleave-token-0123456789';
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function server(): Promise<SyncConfig> {
  const s = createApp({ db: openDb(':memory:'), token: TOKEN });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: TOKEN };
}

/** A device; `doc` lets two "windows" share one document. */
function device(cfg: SyncConfig, opts: { doc?: { text: string | null }; fetchImpl?: typeof fetch } = {}) {
  const doc = opts.doc ?? { text: null };
  let c: SyncConfig | null = cfg;
  const p = createDocPersistence({ read: () => doc.text, write: (t) => void (doc.text = t) });
  const store = createStore(p.load().state, p.persist, 60_000);
  p.attach(store);
  const client = new SyncClient(store, { loadConfig: () => c, saveConfig: (x) => void (c = x), loadMeta: p.loadMeta, updateMeta: p.updateMeta }, { fetchImpl: opts.fetchImpl });
  return { store, p, client, doc, sync: () => client.syncNow(true), state: () => store.get() };
}
const titles = (s: AppState, plan?: string) => s.plans.filter((p) => !plan || p.title === plan).flatMap((p) => p.tasks.map((t) => t.title)).sort();

describe('two windows of one device, same millisecond', () => {
  it('never mint the same revision, so neither edit is mistaken for the other', async () => {
    const cfg = await server();
    const seed = device(cfg);
    seed.store.mutate('x', (d) => {
      ops.createPlan(d, 'P');
      ops.addTask(d, 'original');
    });
    await seed.sync();
    seed.store.flush();
    const shared = { text: seed.doc.text };
    const w1 = device(cfg, { doc: shared });
    const w2 = device(cfg, { doc: shared });
    const tid = w1.state().plans[0].tasks[0].id;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000); // both windows edit at exactly the same millisecond
    try {
      w1.store.mutate('w1', (d) => void ops.updateTask(d, tid, { title: 'window 1' }));
      w2.store.mutate('w2', (d) => void ops.updateTask(d, tid, { note: 'window 2 note' }));
      const r1 = w1.p.loadMeta()!.revs[`task:${tid}`];
      const r2 = w2.p.loadMeta()!.revs[`task:${tid}`];
      expect(r1).not.toBe(r2);
    } finally {
      vi.useRealTimers();
    }
    // Each window syncs its own edit (no file merge in between): both must reach the server.
    await w1.sync();
    await w2.sync();
    const other = device(cfg);
    await other.sync();
    const t = other.state().plans[0].tasks[0];
    expect([t.title, t.note]).toEqual(['window 1', 'window 2 note']);
  });

  it('the server never treats different content under one revision as a retry', async () => {
    const cfg = await server();
    const post = (changes: unknown[]) =>
      fetch(`${cfg.url}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ clientId: 'c', cursor: 0, changes }) }).then((r) => r.json() as Promise<{ rejected?: { id: string; reason: string }[]; records: { id: string; data: { t: string } }[] }>);
    const rev = '00000000a.c';
    await post([{ id: 'settings', kind: 'settings', rev, base: '', data: { t: 'first' } }]);
    const res = await post([{ id: 'settings', kind: 'settings', rev, base: '', data: { t: 'second, same rev' } }]);
    expect(res.rejected).toEqual([{ id: 'settings', reason: 'conflict' }]);
    expect(res.records.find((r) => r.id === 'settings')!.data.t).toBe('first');
  });
});

type When = 'before the pull' | 'between pull and push';

/** Run `between` once during B's next full reconcile: before its pull, or between pull and push. */
function interleaved(): { fetchImpl: typeof fetch; arm: (when: When, between: () => Promise<void>) => void; refused: () => string[] } {
  let posts = 0;
  let at = 0;
  let hook: (() => Promise<void>) | null = null;
  let refused: string[] = [];
  return {
    fetchImpl: async (input, init) => {
      let hooked = false;
      if (String(input).endsWith('/v1/sync') && hook && ++posts === at) {
        const h = hook;
        hook = null;
        hooked = true;
        await h();
      }
      const res = await fetch(input, init);
      // Record what the server refused in the request that followed the interleaved write.
      if (hooked) refused = (((await res.clone().json()) as { rejected?: { reason: string }[] }).rejected ?? []).map((r) => r.reason);
      return res;
    },
    refused: () => refused,
    arm: (when, between) => {
      posts = 0;
      at = when === 'before the pull' ? 1 : 2;
      hook = between;
    },
  };
}

/** A and B in sync on plans P (task "original") and Q. */
async function setup() {
  const cfg = await server();
  const a = device(cfg);
  a.store.mutate('x', (d) => {
    ops.createPlan(d, 'Q');
    ops.createPlan(d, 'P');
    ops.addTask(d, 'original');
  });
  await a.sync();
  const net = interleaved();
  const b = device(cfg, { fetchImpl: net.fetchImpl });
  await b.sync();
  return { a, b, arm: net.arm, refused: net.refused };
}
const WHEN: When[] = ['before the pull', 'between pull and push'];

describe('a full reconciliation whose upload is partly refused', () => {
  it.each(WHEN)('a record edited elsewhere (%s) is merged, not lost', async (when) => {
    const { a, b, arm, refused } = await setup();
    arm(when, async () => {
      a.store.mutate('a', (d) => void ops.updateTask(d, d.plans.find((p) => p.title === 'P')!.tasks[0].id, { note: 'note from A' }));
      await a.sync();
    });
    const tid = b.state().plans.find((p) => p.title === 'P')!.tasks[0].id;
    b.store.mutate('b', (d) => void ops.updateTask(d, tid, { title: 'title from B' }));
    await b.client.connect((b.client.config())!); // full reconcile; A writes in between
    if (when === 'between pull and push') expect(refused()).toContain('conflict'); // the refusal path was taken
    // Settled within the connect itself: nothing left waiting for a later sync.
    expect(b.client.getStatus().pending).toBe(0);
    await a.sync();
    for (const dev of [a, b]) {
      const t = dev.state().plans.find((p) => p.title === 'P')!.tasks[0];
      expect([t.title, t.note]).toEqual(['title from B', 'note from A']);
    }
  });

  it.each(WHEN)('new content in a plan deleted elsewhere (%s) keeps the plan (no orphan)', async (when) => {
    const { a, b, arm, refused } = await setup();
    arm(when, async () => {
      a.store.mutate('del', (d) => void ops.deleteWs(d, d.plans.find((p) => p.title === 'P')!.id));
      await a.sync();
    });
    b.store.mutate('b', (d) => {
      d.ui.activePlanId = d.plans.find((p) => p.title === 'P')!.id;
      ops.addTask(d, 'added on B');
    });
    await b.client.connect((b.client.config())!);
    if (when === 'between pull and push') expect(refused()).toContain('parent-deleted'); // the refusal path was taken
    // Settled within the connect itself: nothing left waiting for a later sync.
    expect(b.client.getStatus().pending).toBe(0);
    await a.sync();
    expect(titles(b.state(), 'P')).toContain('added on B');
    expect(titles(a.state(), 'P')).toContain('added on B'); // on the server too, not a local orphan
    expect(b.client.getStatus().conflicts.some((n) => n.what === 'kept-workspace')).toBe(true);
  });

  it.each(WHEN)('a plan deleted here while another device added to it (%s) is kept', async (when) => {
    const { a, b, arm, refused } = await setup();
    arm(when, async () => {
      a.store.mutate('add', (d) => {
        d.ui.activePlanId = d.plans.find((p) => p.title === 'P')!.id;
        ops.addTask(d, 'added on A');
      });
      await a.sync();
    });
    b.store.mutate('del', (d) => void ops.deleteWs(d, d.plans.find((p) => p.title === 'P')!.id));
    await b.client.connect((b.client.config())!);
    if (when === 'between pull and push') expect(refused()).toContain('has-children'); // the refusal path was taken
    // Settled within the connect itself: nothing left waiting for a later sync.
    expect(b.client.getStatus().pending).toBe(0);
    await a.sync();
    expect(titles(b.state(), 'P')).toEqual(['added on A']);
    expect(titles(a.state(), 'P')).toEqual(['added on A']);
    expect(b.client.getStatus().conflicts.some((n) => n.what === 'kept-workspace')).toBe(true);
  });

  it('if sending the merge right away fails, the connect still succeeds and it goes out later', async () => {
    const cfg = await server();
    const a = device(cfg);
    a.store.mutate('x', (d) => {
      ops.createPlan(d, 'P');
      ops.addTask(d, 'original');
    });
    await a.sync();
    let posts = 0;
    let armed = false;
    const b = device(cfg, {
      fetchImpl: async (input, init) => {
        if (armed && String(input).endsWith('/v1/sync')) {
          posts++;
          if (posts === 2) {
            // Between B's pull and push, A edits the same task.
            a.store.mutate('a', (d) => void ops.updateTask(d, d.plans[0].tasks[0].id, { note: 'note from A' }));
            await a.sync();
          }
          if (posts === 3) throw new TypeError('network dropped'); // the immediate resend
        }
        return fetch(input, init);
      },
    });
    await b.sync();
    b.store.mutate('b', (d) => void ops.updateTask(d, d.plans[0].tasks[0].id, { title: 'title from B' }));
    armed = true;
    await b.client.connect(cfg); // must not fail: the reconciliation was committed
    expect(b.client.config()).toEqual(cfg);
    expect(b.client.getStatus().pending).toBeGreaterThan(0);
    const t = b.state().plans[0].tasks[0];
    expect([t.title, t.note]).toEqual(['title from B', 'note from A']); // merged locally already
    armed = false;
    await b.sync();
    await a.sync();
    const ta = a.state().plans[0].tasks[0];
    expect([ta.title, ta.note]).toEqual(['title from B', 'note from A']);
    b.client.stop();
  });
});
