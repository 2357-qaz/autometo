// The bundled engine (dist/engine.js, the very file the iOS app loads) in a bare V8
// context: like JavaScriptCore it has no timers, fetch, AbortController, structuredClone,
// queueMicrotask or console — only what the host below provides, the way
// AuTomeDo/Engine.swift does.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../../packages/server/src/app';
import { openDb } from '../../../packages/server/src/db';

const BUNDLE = readFileSync(join(import.meta.dirname, '..', 'dist', 'engine.js'), 'utf8');

interface Phone {
  doc: string | null;
  items: Map<string, string>;
  aside: { label: string; text: string }[];
  logs: string[];
}

/** One app process: a fresh JS context over a "disk" that survives restarts. */
function launch(disk: Phone = { doc: null, items: new Map(), aside: [], logs: [] }, opts: { asideFails?: boolean } = {}) {
  const replies = new Map<number, (v: unknown) => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const requests = new Map<number, AbortController>();
  let changes = 0;
  let nextCall = 1;
  const ctx: Record<string, unknown> = {};
  const A = () => ctx.Automedo as { start(): string; call(id: number, n: string, a: string): void; timer(id: number): void; fetched(...a: unknown[]): void };
  ctx.host = {
    log: (level: string, m: string) => void disk.logs.push(`${level}: ${m}`),
    readDoc: () => disk.doc,
    writeDoc: (t: string) => void (disk.doc = t),
    saveAside: (label: string, text: string) => {
      if (opts.asideFails) throw new Error('disk full');
      disk.aside.push({ label, text });
    },
    getItem: (k: string) => disk.items.get(k) ?? null,
    setItem: (k: string, v: string | null) => void (v === null ? disk.items.delete(k) : disk.items.set(k, v)),
    setTimer: (id: number, ms: number) => timers.set(id, setTimeout(() => (timers.delete(id), A().timer(id)), ms)),
    clearTimer: (id: number) => (clearTimeout(timers.get(id)), timers.delete(id)),
    fetch: (id: number, url: string, method: string, headers: string, body: string | null) => {
      const ac = new AbortController();
      requests.set(id, ac);
      fetch(url, { method, headers: JSON.parse(headers), body: body ?? undefined, signal: ac.signal })
        .then(async (r) => A().fetched(id, r.status, JSON.stringify(Object.fromEntries(r.headers)), await r.text(), null))
        .catch((e: Error) => A().fetched(id, 0, '{}', null, e.message));
    },
    cancelFetch: (id: number) => requests.get(id)?.abort(),
    reply: (id: number, json: string) => {
      replies.get(id)?.(JSON.parse(json));
      replies.delete(id);
    },
    changed: () => void changes++,
  };
  vm.createContext(ctx);
  vm.runInContext(BUNDLE, ctx);
  const started = JSON.parse(A().start()) as { loadError: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (name: string, args: unknown = {}) => new Promise<any>((resolve) => {
    const id = nextCall++;
    replies.set(id, resolve);
    A().call(id, name, JSON.stringify(args));
  });
  const stop = () => timers.forEach((t) => clearTimeout(t));
  const idle = (ms = 250) => new Promise((r) => setTimeout(r, ms)); // store saves after 150 ms
  return { disk, call, started, stop, idle, ctx, changes: () => changes };
}

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe('engine in a JavaScriptCore-like context', () => {
  it('has none of the web APIs before it installs them', () => {
    const bare = vm.createContext({});
    const missing = 'JSON.stringify([typeof setTimeout, typeof fetch, typeof structuredClone, typeof AbortController, typeof queueMicrotask])';
    expect(vm.runInContext(missing, bare)).toBe(JSON.stringify(Array(5).fill('undefined')));
  });

  it('runs commands, keeps the view in step and saves through the host', async () => {
    const app = launch();
    expect(app.started.loadError).toBeNull();
    let v = await app.call('view');
    expect([v.ws, v.status.sync.text, v.status.tierLabel]).toEqual([null, '本地', 'Sonnet']);
    expect((await app.call('execute', { input: '/plan 个人网站' })).text).toContain('已创建计划「个人网站」');
    await app.call('execute', { input: '写文章' });
    await app.call('execute', { input: '做首页' });
    v = await app.call('view');
    expect(v.ws.title).toBe('个人网站');
    expect(v.ws.tasks.map((t: { num: number; title: string }) => [t.num, t.title])).toEqual([[1, '写文章'], [2, '做首页']]);
    expect(app.changes()).toBeGreaterThan(0);
    await app.idle();
    expect(JSON.parse(app.disk.doc!).plans[0].title).toBe('个人网站'); // saved after the store's debounce (a host timer)
    app.stop();
  });

  it('task actions, undo, and the coloured timeline', async () => {
    const app = launch();
    await app.call('execute', { input: '/plan P' });
    await app.call('execute', { input: '甲' });
    const id = (await app.call('view')).ws.tasks[0].id;
    expect((await app.call('act', { kind: 'start', taskId: id })).text).toBe('进行中：甲');
    let v = await app.call('view');
    expect(v.ws.tasks[0]).toMatchObject({ status: 'active', here: true });
    const lines = v.timeline.flatMap((b: { lines: { t: string; c?: string }[][] }) => b.lines).map((l: { t: string }[]) => l.map((s) => s.t).join(''));
    expect(lines.some((l: string) => l.includes('Start(甲)'))).toBe(true);
    expect((await app.call('undo')).text).toBe('已撤销：开始任务');
    v = await app.call('view');
    expect(v.ws.tasks[0].status).toBe('pending');
    app.stop();
  });

  it('forms from the terminal version: Fable asks to split, answering runs the refused action', async () => {
    const app = launch();
    await app.call('execute', { input: '/plan P' });
    await app.call('execute', { input: '配色' });
    const id = (await app.call('view')).ws.tasks[0].id;
    await app.call('act', { kind: 'start', taskId: id });
    const r = await app.call('execute', { input: '/model fable' });
    expect(r.text).toContain('Fable 档要先把「配色」拆成子任务');
    expect(r.intent).toMatchObject({ type: 'form', title: '拆分「配色」' });
    expect(r.intent.fields.map((f: { key: string; kind: string }) => `${f.kind}:${f.key}`)).toEqual(['text:doneWhen', 'text:steps', 'text:start', 'text:risk']);
    const bad = await app.call('submitForm', { id: r.intent.id, values: { doneWhen: '能用', steps: '只有一步', start: '1', risk: '' } });
    expect(bad).toMatchObject({ error: true, text: expect.stringContaining('至少拆成 2 步') }); // the form stays open
    const ok = await app.call('submitForm', { id: r.intent.id, values: { doneWhen: '能用', steps: '选字体；定主色', start: '1 2', risk: '' } });
    expect(ok.error).toBeFalsy();
    const v = await app.call('view');
    expect([v.status.tierLabel, v.status.lanes, v.ws.lanes]).toEqual(['Fable', 2, 2]);
    expect(v.ws.tasks.map((t: { title: string; sub: boolean; status: string }) => [t.title, t.sub, t.status])).toEqual([
      ['配色', false, 'active'],
      ['选字体', true, 'active'],
      ['定主色', true, 'active'],
    ]);
    app.stop();
  });

  it('picks, confirmations, sessions and the lines views', async () => {
    const app = launch();
    await app.call('execute', { input: '/plan P' });
    const pick = await app.call('execute', { input: '/model' });
    expect(pick.intent).toMatchObject({ type: 'pick', what: 'tier', title: '模型档位' });
    await app.call('pick', { what: 'tier', value: 'opus' });
    expect((await app.call('view')).status.tierLabel).toBe('Opus');
    const s = await app.call('execute', { input: '/session 30' });
    expect(s.intent.type).toBe('form');
    await app.call('submitForm', { id: s.intent.id, values: { intent: '写首页', tier: 'opus', effort: 'high', minutes: '30' } });
    expect((await app.call('view')).session).toMatchObject({ intent: '写首页', tierLabel: 'Opus', plannedMin: 30, rate: 2250 });
    expect((await app.call('execute', { input: '/help' })).intent.type).toBe('lines');
    expect((await app.call('review', { offset: -1 })).intent).toMatchObject({ type: 'review', offset: -1, markdown: expect.stringContaining('# 周回顾') });
    const planId = (await app.call('view')).ws.id;
    const del = await app.call('deleteWs', { id: planId });
    expect(del.intent).toMatchObject({ type: 'confirm', danger: true });
    await app.call('confirm', { id: del.intent.id, ok: true });
    expect((await app.call('view')).ws).toBeNull();
    expect(await app.call('suggest', { input: '/re' })).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review' }), expect.objectContaining({ name: 'revise' })]));
    app.stop();
  });

  it('a restart reads what was saved (same device); an unreadable document is kept aside', async () => {
    const first = launch();
    await first.call('execute', { input: '/plan 留下来' });
    await first.idle();
    first.stop();
    const device = JSON.parse(first.disk.doc!).ui.deviceId;
    const again = launch(first.disk);
    expect((await again.call('view')).ws.title).toBe('留下来');
    await again.call('execute', { input: 'x' });
    await again.idle();
    expect(JSON.parse(again.disk.doc!).ui.deviceId).toBe(device);
    again.stop();

    const broken = launch({ doc: '{"plans":[', items: new Map(), aside: [], logs: [] });
    expect(broken.started.loadError).toMatch(/数据读取失败/);
    expect(broken.disk.aside).toEqual([{ label: 'unreadable', text: '{"plans":[' }]);
    broken.stop();

    const stuck = launch({ doc: '{"plans":[', items: new Map(), aside: [], logs: [] }, { asideFails: true });
    expect(stuck.started.loadError).toMatch(/本次修改不会保存/);
    await stuck.call('execute', { input: '/plan 新的' });
    await stuck.idle();
    expect(stuck.disk.doc).toBe('{"plans":['); // never written over
    stuck.stop();
  });

  it('syncs with a real server through the host fetch', async () => {
    const server = createApp({ db: openDb(':memory:'), token: 'native-test-token-0123456789' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const a = launch();
    await a.call('execute', { input: '/plan 同步的计划' });
    const form = await a.call('execute', { input: '/sync' });
    expect(form.intent.title).toBe('同步');
    const done = await a.call('submitForm', { id: form.intent.id, values: { url, token: 'native-test-token-0123456789' } });
    expect(done).toMatchObject({ text: `已连接 ${url}，数据已同步` });
    await a.idle(500); // connecting is followed by one more round
    expect((await a.call('view')).status.sync.text).toMatch(/已同步/);
    expect(a.disk.logs.filter((l) => l.startsWith('error'))).toEqual([]);

    const b = launch();
    const f2 = await b.call('execute', { input: '/sync' });
    await b.call('submitForm', { id: f2.intent.id, values: { url, token: 'native-test-token-0123456789' } });
    await b.idle(500);
    expect((await b.call('view')).workspaces.map((w: { title: string }) => w.title)).toEqual(['同步的计划']);
    a.stop();
    b.stop();
  });

  it('a request can be aborted (the sync deadline relies on it)', async () => {
    const app = launch();
    let cancelled = 0;
    const host = app.ctx.host as Record<string, unknown>;
    host.fetch = () => {}; // never answers
    host.cancelFetch = () => void cancelled++;
    const outcome = await vm.runInContext(
      `(() => { const c = new AbortController(); const p = fetch('http://x/', { signal: c.signal }); c.abort(); return p.then(() => 'resolved', (e) => e.name); })()`,
      app.ctx,
    );
    expect([outcome, cancelled]).toEqual(['AbortError', 1]);
    app.stop();
  });

  it('demo data belongs to this device; the timeline fits a phone', async () => {
    const app = launch();
    await app.call('seedDemo');
    const v = await app.call('view');
    const active = v.ws.tasks.find((t: { status: string }) => t.status === 'active');
    expect(active).toMatchObject({ here: true, elsewhere: false });
    const width = (l: { t: string }[]) => [...l.map((x) => x.t).join('')].length;
    const rules = v.timeline.flatMap((b: { lines: { t: string }[][] }) => b.lines).filter((l: { t: string }[]) => l.some((x) => x.t.startsWith('── ')));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(width(r)).toBeLessThanOrEqual(40);
    // Fable on the demo's task in progress asks to split it.
    expect((await app.call('execute', { input: '/model fable' })).intent).toMatchObject({ type: 'form', title: '拆分「确定字体与配色」' });
    app.stop();
  });

  it('feeds the widget and the reminders', async () => {
    const app = launch();
    await app.call('execute', { input: '/plan P' });
    await app.call('execute', { input: '甲' });
    await app.call('execute', { input: '/start 1' });
    expect((await app.call('glance')).task).toMatchObject({ title: '甲', num: 1 });
    expect(await app.call('reminders')).toEqual([]);
    app.stop();
  });
});
