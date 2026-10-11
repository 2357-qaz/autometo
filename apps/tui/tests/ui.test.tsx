import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createStore, emptyState, seedDemo, SyncClient, type SyncStorage } from '@automedo/core';
import { App } from '../src/ui';
import { editLine, lineFrom } from '../src/lineedit';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const noSync: SyncStorage = { loadConfig: () => null, saveConfig: () => {}, loadMeta: () => null, updateMeta: () => {} };
// ANSI-stripped full output (static scrollback + live area).
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function setup(withDemo = false) {
  const state = emptyState();
  if (withDemo) seedDemo(state);
  const store = createStore(state);
  const sync = new SyncClient(store, noSync);
  const r = render(<App store={store} sync={sync} />);
  const all = () => plain(r.frames.join('\n'));
  const type = async (s: string) => {
    for (const ch of Array.from(s)) {
      r.stdin.write(ch);
      await wait(5);
    }
    await wait();
  };
  const key = async (seq: string) => {
    r.stdin.write(seq);
    await wait();
  };
  return { ...r, store, all, type, key, last: () => plain(r.lastFrame() ?? '') };
}

const ENTER = '\r';
const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';

describe('line editor', () => {
  it('inserts CJK, moves the cursor, deletes words', () => {
    let s = lineFrom('读文献');
    s = editLine(s, '', { leftArrow: true })!;
    s = editLine(s, '新', {})!;
    expect(s.value).toBe('读文新献');
    s = editLine(lineFrom('hello big world'), 'w', { ctrl: true })!;
    expect(s.value).toBe('hello big ');
    s = editLine(lineFrom('ab'), '', { backspace: true })!;
    expect(s.value).toBe('a');
    expect(editLine(lineFrom('x'), 'line1\nline2', {})!.value).toBe('xline1 line2');
  });
});

describe('interactive app', () => {
  it('starts with the welcome + status line, creates a plan by typing a title', async () => {
    const t = setup();
    await wait();
    expect(t.all()).toContain('Welcome to AuTomeDo');
    expect(t.last()).toContain('plan mode on');
    await t.type('学习 Rust');
    await t.key(ENTER);
    expect(t.store.get().plans[0].title).toBe('学习 Rust');
    await t.type('读文献');
    await t.key(ENTER);
    expect(t.store.get().plans[0].tasks[0].title).toBe('读文献');
    expect(t.all()).toContain('Write(Plan)');
    expect(t.last()).toContain('读文献  #1');
    t.unmount();
  });

  it('keeps the prompt and status line at the bottom: menus and forms open above them', async () => {
    const t = setup(true);
    await t.type('/');
    let rows = t.last().trimEnd().split('\n');
    const promptRow = rows.findIndex((l) => l.includes('> /'));
    expect(rows.findIndex((l) => l.includes('/phase'))).toBeLessThan(promptRow);
    expect(rows.at(-1)).toContain('Sonnet');
    await t.key(ESC);
    await t.type('/session');
    await t.key(ENTER);
    rows = t.last().trimEnd().split('\n');
    expect(rows.findIndex((l) => l.includes('开始专注 Session'))).toBeLessThan(rows.findIndex((l) => l.includes('正在填写上方的表单')));
    expect(rows.at(-1)).toContain('Sonnet');
    t.unmount();
  });

  it('/model opens a picker in the bottom bar: ← then enter switches Opus → Sonnet', async () => {
    const t = setup(true);
    t.store.mutate(null, (d) => void (d.hie.tier = 'opus'));
    await t.type('/model');
    await t.key(ENTER);
    let rows = t.last().trimEnd().split('\n');
    expect(rows.find((l) => l.includes('模型档位'))).toContain('‹ Opus ›');
    expect(rows.at(-1)).toContain('←→ 选择');
    await t.key(LEFT);
    rows = t.last().trimEnd().split('\n');
    expect(rows.find((l) => l.includes('模型档位'))).toContain('‹ Sonnet ›');
    expect(rows.at(-1)).toContain('Sonnet'); // status line previews the choice
    expect(t.store.get().hie.tier).toBe('opus'); // …but nothing changes before enter
    await t.key(ENTER);
    expect(t.store.get().hie.tier).toBe('sonnet');
    expect(t.last()).toContain('添加任务');
    t.unmount();
  });

  it('←→ on a highlighted /effort suggestion opens the picker one step over; esc cancels', async () => {
    const t = setup(true);
    await t.type('/effort');
    expect(t.last()).toContain('←→ 直接选择');
    await t.key(RIGHT);
    expect(t.last()).toContain('‹ high ›');
    await t.key(ESC);
    expect(t.store.get().hie.effort).toBe('medium');
    await t.type('/fatigue');
    await t.key(ENTER);
    await t.type('5');
    expect(t.store.get().fatigue.at(-1)?.level).toBe(5);
    t.unmount();
  });

  it('confirmations happen in the bottom bar: n keeps, y deletes', async () => {
    const t = setup(true);
    const n0 = t.store.get().plans.length + t.store.get().goals.length;
    await t.key('\x0f'); // ctrl+o
    await t.key('\x04'); // ctrl+d
    expect(t.last()).toContain('y 删除 · n 取消');
    await t.key('n');
    expect(t.store.get().plans.length + t.store.get().goals.length).toBe(n0);
    await t.key('\x0f');
    await t.key('\x04');
    await t.key(ENTER); // a dangerous confirm ignores enter: it needs y
    expect(t.store.get().plans.length + t.store.get().goals.length).toBe(n0);
    await t.key('\x0f');
    await t.key('\x04');
    await t.key('y');
    expect(t.store.get().plans.length + t.store.get().goals.length).toBe(n0 - 1);
    t.unmount();
  });

  it('suggests and runs slash commands, prints errors inline', async () => {
    const t = setup(true);
    await wait();
    await t.type('/nex');
    expect(t.last()).toContain('/next');
    await t.key(ENTER); // runs /next: completes current, starts next
    const plan = t.store.get().plans[0];
    expect(plan.tasks.find((x) => x.title === '确定字体与配色')?.status).toBe('done');
    await t.type('/done 99');
    await t.key(ENTER);
    expect(t.all()).toContain('没有编号为 #99 的任务');
    await t.type('/diff');
    await t.key(ENTER);
    await t.key(ENTER);
    expect(t.all()).toContain('Diff(v1 → 现在)');
    expect(t.all()).toContain('首次偏离');
    t.unmount();
  });

  it('shift+tab switches mode, ctrl+o picks a workspace', async () => {
    const t = setup(true);
    await wait();
    await t.key(SHIFT_TAB);
    expect(t.store.get().ui.mode).toBe('goal');
    expect(t.last()).toContain('goal mode on');
    await t.key('\x0f'); // ctrl+o
    expect(t.last()).toContain('切换 Plan / Goal');
    await t.type('网站');
    await t.key(ENTER);
    expect(t.store.get().ui.mode).toBe('plan');
    expect(t.all()).toContain('切换到「个人网站改版」');
    t.unmount();
  });

  it('runs a multi-step form (new goal) and can cancel one', async () => {
    const t = setup();
    await wait();
    await t.type('/go');
    await t.key(ENTER); // optional argument → runs /goal right away → opens the form (no goals yet)
    expect(t.last()).toContain('新建 Goal');
    await t.type('学吉他');
    await t.key(ENTER);
    for (let i = 0; i < 4; i++) await t.key(ENTER);
    expect(t.store.get().goals[0].title).toBe('学吉他');
    expect(t.store.get().goals[0].cadenceDays).toBe(7);
    await t.type('/checkpoint');
    await t.key(ENTER);
    expect(t.last()).toContain('主观进度');
    await t.key('\x1b[C'); // → +5%
    await t.key('\x1b[C');
    await t.key(ENTER);
    await t.key(DOWN); // verdict: drifting
    await t.key(ENTER);
    await t.type('练了 C 和弦');
    await t.key(ENTER);
    await t.key(ENTER);
    await t.key(ENTER);
    const cp = t.store.get().goals[0].checkpoints[0];
    expect(cp.progress).toBe(10);
    expect(cp.verdict).toBe('drifting');
    expect(cp.did).toBe('练了 C 和弦');
    await t.type('/session');
    await t.key(ENTER);
    await t.key(ESC);
    expect(t.all()).toContain('已取消');
    expect(t.store.get().sessions).toHaveLength(0);
    t.unmount();
  });

  it('ctrl+z undoes, ctrl+c clears then asks to confirm exit', async () => {
    const t = setup(true);
    await wait();
    await t.type('临时任务');
    await t.key(ENTER);
    expect(t.store.get().plans[0].tasks.some((x) => x.title === '临时任务')).toBe(true);
    await t.key('\x1a'); // ctrl+z
    expect(t.store.get().plans[0].tasks.some((x) => x.title === '临时任务')).toBe(false);
    await t.type('abc');
    await t.key('\x03');
    expect(t.last()).not.toContain('abc');
    await t.key('\x03');
    expect(t.last()).toContain('再按一次 ctrl+c 退出');
    t.unmount();
  });
});
