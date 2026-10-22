import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../src/state';
import * as ops from '../src/ops';
import { activeSession, estimateTokens, runSegmentsTokens, tierRate, TIER_ORDER } from '../src/hie';
import { createStore } from '../src/store';
import { execute, type CmdCtx } from '../src/commands';
import { compose, decompose } from '../src/sync';
import type { Intent } from '../src/intents';
import type { AppState } from '../src/types';

afterEach(() => vi.useRealTimers());

function plan(tier: AppState['hie']['tier'] = 'sonnet') {
  const s = emptyState();
  s.ui.deviceId = 'dev-a';
  s.hie.tier = tier;
  ops.createPlan(s, 'P');
  for (const t of ['写文章', '做首页', '部署']) ops.addTask(s, t);
  return s;
}
const task = (s: AppState, title: string) => s.plans[0].tasks.find((t) => t.title === title)!;
const statuses = (s: AppState) => Object.fromEntries(ops.orderedTasks(s.plans[0]).map((t) => [t.title, t.status]));
const answers = (steps: string, start = '') => ({ doneWhen: '能发出去', steps: ops.splitSteps(steps), risk: '配图没着落', start });

function ctx(s: AppState) {
  const store = createStore(s);
  const opened: Intent[] = [];
  const c: CmdCtx = { store, open: (i) => void opened.push(i), exportData: vi.fn(), importData: vi.fn(), showDiff: vi.fn() };
  return { store, c, opened };
}

describe('Fable tier', () => {
  it('is the fourth tier and is priced per parallel lane: 2000, +1000 for each extra lane', () => {
    expect(TIER_ORDER).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect([1, 2, 3].map((n) => tierRate('fable', n))).toEqual([2000, 3000, 4000]);
    expect(tierRate('opus', 3)).toBe(1500); // lanes only matter for Fable
    expect(estimateTokens('fable', 'high', 10, 4, 2)).toBe(3000 * 1.5 * 4 * 10);
  });

  it('refuses to start a task that is not split, and the command asks the split questions instead', () => {
    const s = plan('fable');
    expect(() => ops.setTaskStatus(s, task(s, '写文章').id, 'active')).toThrow(ops.SplitRequired);
    const { store, c, opened } = ctx(s);
    const r = execute('/start 1', c);
    expect(r).toMatchObject({ text: expect.stringContaining('Fable 档要先把「写文章」拆成子任务') });
    expect(statuses(store.get())['写文章']).toBe('pending'); // nothing happened yet
    const i = opened[0];
    expect(i).toMatchObject({ type: 'split', taskId: task(s, '写文章').id });
    if (i.type !== 'split') throw new Error();

    // Answering splits the task, reruns the start, and starts the chosen steps in parallel.
    const msg = store.mutate(i.label!, (d) => ops.submitSplit(d, i.taskId, answers('列提纲\n写初稿；找配图', '1 3'), i.retry));
    expect(msg).toContain('已拆分「写文章」→ 3 步');
    expect(statuses(store.get())).toEqual({ 写文章: 'active', 列提纲: 'active', 写初稿: 'pending', 找配图: 'active', 做首页: 'pending', 部署: 'pending' });
    const p = task(store.get(), '写文章');
    expect(p.note).toBe('完成标准：能发出去\n风险：配图没着落');
    expect(store.get().plans[0].log.some((e) => e.type === 'split' && e.reason === '能发出去' && e.diff?.length === 3)).toBe(true);
    expect(ops.laneCount(store.get())).toBe(2);
  });

  it('switching to Fable asks to split the task in progress first; cancelling leaves the tier alone', () => {
    const s = plan('opus');
    ops.setTaskStatus(s, task(s, '做首页').id, 'active');
    const { store, c, opened } = ctx(s);
    execute('/model fable', c);
    expect(store.get().hie.tier).toBe('opus');
    const i = opened[0];
    if (i?.type !== 'split') throw new Error('expected the split questions');
    store.mutate(i.label!, (d) => ops.submitSplit(d, i.taskId, answers('线框；配色', '全部'), i.retry));
    expect(store.get().hie.tier).toBe('fable');
    expect(ops.activeLanes(store.get().plans[0], store.get()).map((t) => t.title)).toEqual(['线框', '配色']);
    // A task already split, or no task in progress, switches straight away.
    expect(ops.setTier(plan('opus'), 'fable')).toBe('模型档位 → Fable');
  });

  it('runs subtasks of one task in parallel only in Fable; elsewhere one at a time', () => {
    const s = plan('sonnet');
    ops.splitTask(s, task(s, '写文章').id, answers('a；b；c'));
    ops.setTaskStatus(s, task(s, 'a').id, 'active');
    ops.setTaskStatus(s, task(s, 'b').id, 'active');
    expect(statuses(s)).toMatchObject({ 写文章: 'active', a: 'pending', b: 'active' });
    s.hie.tier = 'fable';
    ops.setTaskStatus(s, task(s, 'c').id, 'active');
    expect(statuses(s)).toMatchObject({ 写文章: 'active', b: 'active', c: 'active' });
    // Several lanes: a bare /done is ambiguous; a number picks one.
    expect(() => ops.resolveTask(s.plans[0], '', s)).toThrow(/正在并行推进 2 路（#3 #4）/);
    ops.setTaskStatus(s, task(s, 'b').id, 'done');
    expect(ops.resolveTask(s.plans[0], '', s).title).toBe('c');
    // Starting another top-level task stops the whole split task on this device.
    ops.splitTask(s, task(s, '做首页').id, answers('x；y'));
    ops.setTaskStatus(s, task(s, 'x').id, 'active');
    expect(statuses(s)).toMatchObject({ 写文章: 'pending', c: 'pending', 做首页: 'active', x: 'active' });
  });

  it('leaving Fable keeps one lane per split task and names the ones it paused', () => {
    const s = plan('fable');
    ops.submitSplit(s, task(s, '写文章').id, answers('a；b；c', '全部'));
    expect(ops.laneCount(s)).toBe(3);
    expect(ops.setTier(s, 'sonnet')).toBe('模型档位 → Sonnet　·　并行子任务只保留一路，已暂停：b、c');
    expect(statuses(s)).toMatchObject({ 写文章: 'active', a: 'active', b: 'pending', c: 'pending' });
  });

  it('a Fable session is priced by the lanes in progress over time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T09:00:00'));
    const store = createStore(plan('fable'));
    store.mutate('拆分', (d) => ops.submitSplit(d, task(d, '写文章').id, answers('a；b；c', '1')));
    store.mutate('Session', (d) => ops.startSession(d, { intent: '写文章', plannedMin: 30, tier: 'fable', effort: 'medium' }));
    expect(activeSession(store.get())?.lanes).toBe(1);
    vi.setSystemTime(new Date('2026-10-22T09:10:00'));
    store.mutate('开始', (d) => {
      ops.setTaskStatus(d, task(d, 'b').id, 'active');
      ops.setTaskStatus(d, task(d, 'c').id, 'active');
    });
    store.mutate('开始', (d) => ops.setTaskStatus(d, task(d, 'c').id, 'active')); // unchanged: no new segment
    vi.setSystemTime(new Date('2026-10-22T09:20:00'));
    const s = store.get();
    expect(s.sessions.map((x) => x.lanes)).toEqual([1, 3]);
    expect(runSegmentsTokens(s, activeSession(s)!.runId)).toBe(10 * 2000 + 10 * 4000);
    store.mutate('结束', (d) => ops.endSession(d, {}));
    expect(store.get().sessions.reduce((a, x) => a + (x.tokens ?? 0), 0)).toBe(60_000);
  });

  it('starting a Fable session also requires the task in progress to be split', () => {
    const s = plan('sonnet');
    ops.setTaskStatus(s, task(s, '部署').id, 'active');
    expect(() => ops.startSession(s, { intent: '', plannedMin: 25, tier: 'fable', effort: 'medium' })).toThrow(ops.SplitRequired);
    expect(s.sessions).toEqual([]);
  });
});

describe('subtasks', () => {
  it('are numbered right after their parent and validated when splitting', () => {
    const s = plan();
    expect(() => ops.splitTask(s, task(s, '做首页').id, answers('只有一步'))).toThrow(/至少拆成 2 步/);
    expect(() => ops.splitTask(s, task(s, '做首页').id, { doneWhen: ' ', steps: ['a', 'b'] })).toThrow(/做完是什么样/);
    ops.splitTask(s, task(s, '做首页').id, answers('线框；配色'));
    expect(ops.orderedTasks(s.plans[0]).map((t) => t.title)).toEqual(['写文章', '做首页', '线框', '配色', '部署']);
    expect(() => ops.splitTask(s, task(s, '线框').id, answers('1；2'))).toThrow(/子任务不再继续拆分/);
    ops.splitTask(s, task(s, '做首页').id, answers('响应式')); // one more step on top of the two
    expect(ops.childrenOf(s.plans[0], task(s, '做首页').id).map((t) => t.title)).toEqual(['线框', '配色', '响应式']);
  });

  it('/next goes through the subtasks, then suggests finishing the parent', () => {
    const s = plan();
    ops.splitTask(s, task(s, '写文章').id, answers('a；b'));
    ops.setTaskStatus(s, task(s, '写文章').id, 'active');
    ops.nextTask(s);
    expect(statuses(s)).toMatchObject({ 写文章: 'active', a: 'active', b: 'pending' });
    ops.nextTask(s);
    expect(statuses(s)).toMatchObject({ a: 'done', b: 'active' });
    expect(ops.setTaskStatus(s, task(s, 'b').id, 'done')).toContain('「写文章」的子任务都结束了，可 /done 1 完成它');
  });

  it('go along with their parent: delete, defer to the next phase, pausing', () => {
    const s = plan();
    ops.addPhase(s, '第二阶段');
    ops.splitTask(s, task(s, '写文章').id, answers('a；b'));
    ops.setTaskStatus(s, task(s, 'a').id, 'active');
    expect(ops.setTaskStatus(s, task(s, '写文章').id, 'blocked')).toContain('子任务已暂停：a');
    ops.deferTask(s, task(s, '写文章').id, '先做首页');
    const ph2 = s.plans[0].phases[1].id;
    expect([task(s, '写文章'), task(s, 'a'), task(s, 'b')].map((t) => t.phaseId)).toEqual([ph2, ph2, ph2]);
    expect(ops.deleteTask(s, task(s, '写文章').id)).toBe('已删除：写文章（连同 2 个子任务）');
    expect(s.plans[0].tasks.map((t) => t.title)).toEqual(['做首页', '部署']);
  });

  it('a subtask whose parent was deleted on another device stands on its own', () => {
    const s = plan();
    ops.splitTask(s, task(s, '写文章').id, answers('a；b'));
    s.plans[0].tasks = s.plans[0].tasks.filter((t) => t.title !== '写文章');
    expect(ops.orderedTasks(s.plans[0]).map((t) => t.title)).toEqual(['a', 'b', '做首页', '部署']);
    s.hie.tier = 'fable';
    expect(() => ops.setTaskStatus(s, task(s, 'a').id, 'active')).toThrow(ops.SplitRequired); // a top-level task now
  });

  it('survive a sync round trip (parent link, session lanes)', () => {
    const s = plan('fable');
    ops.submitSplit(s, task(s, '写文章').id, answers('a；b', '全部'));
    ops.startSession(s, { intent: '', plannedMin: 25, tier: 'fable', effort: 'medium' });
    const back = compose(decompose(s).values(), s.ui);
    expect(ops.orderedTasks(back.plans[0]).map((t) => [t.title, t.parentId ? 'sub' : 'top'])).toEqual([
      ['写文章', 'top'], ['a', 'sub'], ['b', 'sub'], ['做首页', 'top'], ['部署', 'top'],
    ]);
    expect(back.sessions[0].lanes).toBe(2);
  });

  it('parses which steps to start', () => {
    expect(ops.parseLanePick('', 3)).toEqual([]);
    expect(ops.parseLanePick('3 1,2', 3)).toEqual([0, 1, 2]);
    expect(ops.parseLanePick('2-3', 3)).toEqual([1, 2]);
    expect(ops.parseLanePick('全部', 2)).toEqual([0, 1]);
    expect(() => ops.parseLanePick('4', 3)).toThrow(/没有第 4 步/);
  });
});

describe('a Fable session follows the lanes whatever stops them', () => {
  // 3 lanes from 09:00; something happens at 09:10; priced up to 09:20.
  function running() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T09:00:00'));
    const s = plan('fable');
    ops.addPhase(s, '第二阶段');
    ops.submitSplit(s, task(s, '写文章').id, answers('a；b；c', '全部'));
    ops.startSession(s, { intent: '', plannedMin: 60, tier: 'fable', effort: 'medium' });
    const store = createStore(s);
    vi.setSystemTime(new Date('2026-10-22T09:10:00'));
    const priced = () => {
      vi.setSystemTime(new Date('2026-10-22T09:20:00'));
      const d = store.get();
      expect(activeSession(d)?.lanes).toBe(ops.laneCount(d));
      return runSegmentsTokens(d, activeSession(d)!.runId);
    };
    return { store, priced };
  }
  const T = (title: string, d: AppState) => task(d, title).id;

  it('deferring a running subtask', () => {
    const { store, priced } = running();
    store.mutate('延期', (d) => ops.deferTask(d, T('c', d)));
    expect(priced()).toBe(10 * 4000 + 10 * 3000);
  });

  it('deferring the parent (its subtasks stop)', () => {
    const { store, priced } = running();
    store.mutate('延期', (d) => ops.deferTask(d, T('写文章', d)));
    expect(priced()).toBe(10 * 4000 + 10 * 2000);
  });

  it('deleting the phase they are in', () => {
    const { store, priced } = running();
    store.mutate('删除阶段', (d) => ops.deletePhase(d, d.plans[0].phases[0].id));
    expect(priced()).toBe(10 * 4000 + 10 * 2000);
  });

  it('deleting the plan', () => {
    const { store, priced } = running();
    store.mutate('删除', (d) => ops.deleteWs(d, d.plans[0].id));
    expect(priced()).toBe(10 * 4000 + 10 * 2000);
  });

  it('another device finishing one of them (arrives by sync)', async () => {
    const { store, priced } = running();
    const remote = structuredClone(store.get());
    Object.assign(task(remote, 'b'), { status: 'done', doneAt: Date.now() });
    delete task(remote, 'b').activeBy;
    store.applyExternal(remote);
    await Promise.resolve();
    expect(priced()).toBe(10 * 4000 + 10 * 3000);
  });

  it('undoing the start of a lane', () => {
    const { store, priced } = running();
    store.mutate('暂停', (d) => ops.setTaskStatus(d, T('c', d), 'pending'));
    vi.setSystemTime(new Date('2026-10-22T09:15:00'));
    store.mutate('开始任务', (d) => ops.setTaskStatus(d, T('c', d), 'active'));
    store.undo();
    expect(priced()).toBe(10 * 4000 + 10 * 3000);
  });
});

describe('re-pricing after a remote change in two processes of one device', () => {
  it('creates the same segment in both, so merging keeps a single running session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T09:00:00'));
    const s = plan('fable');
    ops.submitSplit(s, task(s, '写文章').id, answers('a；b', '全部'));
    ops.startSession(s, { intent: '', plannedMin: 60, tier: 'fable', effort: 'medium' });
    vi.setSystemTime(new Date('2026-10-22T09:10:00'));
    const [p1, p2] = [structuredClone(s), structuredClone(s)];
    for (const d of [p1, p2]) {
      Object.assign(task(d, 'b'), { status: 'done' }); // the same remote edit reaches both
      ops.syncLanes(d);
    }
    expect(p1.sessions.map((x) => x.id)).toEqual(p2.sessions.map((x) => x.id));
    const merged = compose(new Map([...decompose(p1), ...decompose(p2)]).values(), s.ui);
    expect(merged.sessions.filter((x) => x.endedAt == null)).toHaveLength(1);
  });
});
