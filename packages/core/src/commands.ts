import type { Intent } from './intents';
import type { Store } from './store';
import { activeGoal, activePlan, currentWs } from './state';
import { activeSession, EFFORT_ORDER, TIER_ORDER } from './hie';
import * as ops from './ops';
import type { Effort, Tier } from './types';

export interface CmdCtx {
  store: Store;
  open: (d: Intent) => void;
  exportData: () => void;
  importData: () => void;
  showDiff: (planId: string, version?: number) => void;
}

export interface CmdResult {
  text: string;
  error?: boolean;
  undoable?: boolean;
}

export interface Command {
  name: string;
  args?: string;
  desc: string;
  /** Only show in autocomplete when this mode is active (undefined = always). */
  mode?: 'plan' | 'goal';
  run: (arg: string, ctx: CmdCtx) => CmdResult | void;
}

const ok = (text: string, undoable = true): CmdResult => ({ text, undoable });

function mut(ctx: CmdCtx, label: string, fn: Parameters<Store['mutate']>[1]): CmdResult {
  const r = ctx.store.mutate(label, fn);
  return ok(typeof r === 'string' ? r : label);
}

export const COMMANDS: Command[] = [
  { name: 'help', desc: '查看全部命令与快捷键', run: (_, c) => void c.open({ type: 'help' }) },
  {
    name: 'plan',
    args: '[标题]',
    desc: '切换到 Plan Mode；带标题则新建计划',
    run: (a, c) => {
      if (a.trim()) return mut(c, '新建计划', (d) => `已创建计划「${ops.createPlan(d, a).title}」· 用 /task 添加任务`);
      const s = c.store.get();
      if (!s.plans.length) return void c.open({ type: 'newPlan' });
      c.store.mutate(null, (d) => {
        d.ui.mode = 'plan';
        d.ui.activePlanId ??= d.plans[0].id;
      });
      return ok('⏸ plan mode on', false);
    },
  },
  {
    name: 'goal',
    args: '[标题]',
    desc: '切换到 Goal Mode；带标题则新建目标',
    run: (a, c) => {
      if (a.trim()) return mut(c, '新建目标', (d) => `已设定目标「${ops.createGoal(d, a).title}」· 先写下一步，然后动起来`);
      const s = c.store.get();
      if (!s.goals.length) return void c.open({ type: 'newGoal' });
      c.store.mutate(null, (d) => {
        d.ui.mode = 'goal';
        d.ui.activeGoalId ??= d.goals[0].id;
      });
      return ok('⏵ goal mode on', false);
    },
  },
  { name: 'switch', desc: '切换 / 管理 Plan 与 Goal（o）', run: (_, c) => void c.open({ type: 'switch' }) },
  {
    name: 'task',
    args: '<内容>',
    desc: '添加任务（Goal 中为行动）；直接输入文字也可以',
    run: (a, c) =>
      mut(c, '添加任务', (d) => {
        const t = ops.addTask(d, a);
        return `已添加 #${ops.orderedTasks(ops.requireWs(d)).findIndex((x) => x.id === t.id) + 1}：${t.title}`;
      }),
  },
  { name: 'start', args: '[#n]', desc: '开始执行任务（同时只有一个进行中）', run: (a, c) => mut(c, '开始任务', (d) => ops.setTaskStatus(d, ops.resolveTask(ops.requireWs(d), a || firstPending(d)).id, 'active')) },
  { name: 'done', args: '[#n]', desc: '完成任务（默认当前进行中）', run: (a, c) => mut(c, '完成任务', (d) => ops.setTaskStatus(d, ops.resolveTask(ops.requireWs(d), a).id, 'done')) },
  { name: 'next', desc: '完成当前任务并开始下一个', run: (_, c) => mut(c, '下一个任务', (d) => ops.nextTask(d)) },
  {
    name: 'block',
    args: '[#n] [原因]',
    desc: '标记任务阻塞',
    run: (a, c) => {
      const m = a.trim().match(/^#?(\d+)\s*(.*)$/);
      return mut(c, '标记阻塞', (d) => ops.setTaskStatus(d, ops.resolveTask(ops.requireWs(d), m ? m[1] : '').id, 'blocked', m ? m[2] : a));
    },
  },
  {
    name: 'defer',
    args: '[#n] [原因]',
    desc: '延期任务：推到下一阶段（Goal 中移到末尾）',
    run: (a, c) => {
      const m = a.trim().match(/^#?(\d+)\s*(.*)$/);
      return mut(c, '延期', (d) => ops.deferTask(d, ops.resolveTask(ops.requireWs(d), m ? m[1] : '').id, m ? m[2] : a));
    },
  },
  { name: 'skip', args: '[#n]', desc: '跳过任务', run: (a, c) => mut(c, '跳过任务', (d) => ops.setTaskStatus(d, ops.resolveTask(ops.requireWs(d), a).id, 'skipped')) },
  {
    name: 'phase',
    args: '<标题> | done',
    desc: '新增阶段；/phase done 完成当前阶段',
    mode: 'plan',
    run: (a, c) => {
      if (a.trim() === 'done') {
        return mut(c, '完成阶段', (d) => {
          const p = ops.requirePlan(d);
          const ph = ops.currentPhase(p);
          if (!ph) throw new ops.UserError('没有阶段');
          return ops.completePhase(d, ph.id);
        });
      }
      return mut(c, '新增阶段', (d) => ops.addPhase(d, a));
    },
  },
  {
    name: 'due',
    args: '<YYYY-MM-DD | MM-DD | +3d | ->',
    desc: '设置当前阶段的目标日期（- 清除）',
    mode: 'plan',
    run: (a, c) =>
      mut(c, '设置目标日期', (d) => {
        const ph = ops.currentPhase(ops.requirePlan(d)) ?? (() => { throw new ops.UserError('没有阶段'); })();
        return ops.updatePhase(d, ph.id, { due: a.trim() === '-' ? null : a.trim() || (() => { throw new ops.UserError('用法：/due 10-20 或 /due +3d，/due - 清除'); })() });
      }),
  },
  {
    name: 'commit',
    args: '[说明]',
    desc: '把当前计划提交为新版本（Plan Diff 的对比点）',
    mode: 'plan',
    run: (a, c) => mut(c, 'Commit', (d) => ops.commitPlan(d, a)),
  },
  {
    name: 'diff',
    args: '[v版本]',
    desc: 'Plan Diff：对比计划版本（默认 v1）和实际执行',
    mode: 'plan',
    run: (a, c) => {
      const p = activePlan(c.store.get());
      if (!p) return { text: '当前没有 Plan', error: true };
      if (!p.versions.length) return { text: '还没有计划版本。第一次开始任务（/start）时会自动建立基准 v1，也可以 /commit', error: true };
      const v = a.trim() ? Number(a.trim().replace(/^v/i, '')) : undefined;
      if (v != null && !p.versions.some((x) => x.v === v)) return { text: `没有版本 v${a.trim()}。现有：${p.versions.map((x) => 'v' + x.v).join(' ')}`, error: true };
      c.showDiff(p.id, v);
    },
  },
  {
    name: 'revise',
    desc: '修正当前阶段目标（记录原因）',
    mode: 'plan',
    run: (_, c) => {
      const p = activePlan(c.store.get());
      const ph = p && ops.currentPhase(p);
      if (!ph) return { text: '没有可修正的阶段', error: true };
      c.open({ type: 'revise', phaseId: ph.id });
    },
  },
  {
    name: 'checkpoint',
    desc: '为当前目标做一次 Checkpoint',
    mode: 'goal',
    run: (_, c) => {
      const g = activeGoal(c.store.get());
      if (!g) return { text: '当前没有 Goal', error: true };
      c.open({ type: 'checkpoint', goalId: g.id });
    },
  },
  {
    name: 'nextaction',
    args: '<下一步>',
    desc: '设置目标的下一步动作',
    mode: 'goal',
    run: (a, c) => mut(c, '设置下一步', (d) => ops.updateGoal(d, ops.requireGoal(d).id, { nextAction: a })),
  },
  { name: 'note', args: '<内容>', desc: '写一条日志（也可用 # 开头）', run: (a, c) => mut(c, '记录', (d) => ops.addNote(d, a)) },
  {
    name: 'session',
    args: '[分钟]',
    desc: '开始专注 Session（选择档位与强度）',
    run: (a, c) => {
      if (activeSession(c.store.get())) return { text: '已有进行中的 Session，先 /end', error: true };
      const n = parseInt(a, 10);
      c.open({ type: 'session', minutes: Number.isFinite(n) ? n : undefined });
    },
  },
  {
    name: 'end',
    desc: '结束 Session 并自评疲劳',
    run: (_, c) => {
      if (!activeSession(c.store.get())) return { text: '当前没有进行中的 Session', error: true };
      c.open({ type: 'endSession' });
    },
  },
  {
    name: 'model',
    args: '[haiku|sonnet|opus]',
    desc: '切换模型档位（不带参数则轮换）',
    run: (a, c) => {
      const s = c.store.get();
      const t = (a.trim().toLowerCase() || TIER_ORDER[(TIER_ORDER.indexOf(s.hie.tier) + 1) % 3]) as Tier;
      if (!TIER_ORDER.includes(t)) return { text: `未知档位「${a}」。可选：haiku / sonnet / opus`, error: true };
      return mut(c, '切换档位', (d) => ops.setTier(d, t));
    },
  },
  {
    name: 'effort',
    args: '[low|medium|high]',
    desc: '切换推理强度（不带参数则轮换）',
    run: (a, c) => {
      const s = c.store.get();
      const e = (a.trim().toLowerCase() || EFFORT_ORDER[(EFFORT_ORDER.indexOf(s.hie.effort) + 1) % 3]) as Effort;
      if (!EFFORT_ORDER.includes(e)) return { text: `未知强度「${a}」。可选：low / medium / high`, error: true };
      return mut(c, '切换强度', (d) => ops.setEffort(d, e));
    },
  },
  { name: 'fatigue', args: '<1-5>', desc: '疲劳自评（1 精力充沛 · 5 需要休息）', run: (a, c) => mut(c, '疲劳自评', (d) => ops.markFatigue(d, Number(a))) },
  { name: 'budget', args: '<数量>', desc: '设置每日 Token 预算，如 /budget 150k', run: (a, c) => mut(c, '设置预算', (d) => ops.setBudget(d, ops.parseTokenAmount(a))) },
  {
    name: 'compact',
    desc: '生成可编辑的工作快照',
    run: (_, c) => {
      const ws = currentWs(c.store.get());
      if (!ws) return { text: '当前没有打开的 Plan/Goal', error: true };
      c.open({ type: 'compact', wsId: ws.id });
    },
  },
  {
    name: 'resume',
    desc: '查看最近的快照，恢复上下文',
    run: (_, c) => {
      const s = c.store.get();
      const ws = currentWs(s);
      const list = s.compacts.filter((x) => !ws || x.wsId === ws.id);
      const last = list[list.length - 1] ?? s.compacts[s.compacts.length - 1];
      if (!last) return { text: '还没有快照。先 /compact 一次', error: true };
      c.open({ type: 'resume', compactId: last.id });
    },
  },
  { name: 'rename', args: '<新标题>', desc: '重命名当前 Plan/Goal', run: (a, c) => mut(c, '重命名', (d) => ops.renameWs(d, ops.requireWs(d).id, a)) },
  {
    name: 'status',
    args: '<active|paused|done|archived>',
    desc: '设置当前 Plan/Goal 状态',
    run: (a, c) => {
      const st = a.trim() as 'active' | 'paused' | 'done' | 'archived';
      if (!['active', 'paused', 'done', 'archived'].includes(st)) return { text: '可选：active / paused / done / archived', error: true };
      return mut(c, '设置状态', (d) => ops.setWsStatus(d, ops.requireWs(d).id, st));
    },
  },
  {
    name: 'delete',
    desc: '删除当前 Plan/Goal（可撤销）',
    run: (_, c) => {
      const ws = currentWs(c.store.get());
      if (!ws) return { text: '当前没有打开的 Plan/Goal', error: true };
      c.open({
        type: 'confirm',
        title: `删除「${ws.title}」？`,
        message: '其任务、日志与快照将一起删除。之后可以用 Ctrl+Z 撤销。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: () => c.store.mutate('删除', (d) => ops.deleteWs(d, ws.id)),
      });
    },
  },
  { name: 'undo', desc: '撤销上一步（Ctrl+Z）', run: (_, c) => { const l = c.store.undo(); return l ? ok(`已撤销：${l}`, false) : { text: '没有可撤销的操作', error: true }; } },
  { name: 'sync', desc: '连接自托管服务器，在多台设备间同步', run: (_, c) => void c.open({ type: 'sync' }) },
  { name: 'export', desc: '导出 JSON 备份', run: (_, c) => { c.exportData(); return ok('已导出备份文件', false); } },
  { name: 'import', desc: '从 JSON 备份导入（会覆盖当前数据）', run: (_, c) => void c.importData() },
];

function firstPending(d: Parameters<typeof ops.requireWs>[0]): string {
  const list = ops.orderedTasks(ops.requireWs(d));
  const i = list.findIndex((t) => t.status === 'pending');
  if (i < 0) throw new ops.UserError('没有待办任务');
  return String(i + 1);
}

/** True when the command can't run without an argument (`<…>`), so Enter should complete instead of run. */
export function needsArg(c: Command): boolean {
  return !!c.args && c.args.trim().startsWith('<');
}

export function matchCommands(input: string, mode: 'plan' | 'goal'): Command[] {
  if (!input.startsWith('/')) return [];
  const q = input.slice(1).split(/\s/)[0].toLowerCase();
  if (input.includes(' ')) return COMMANDS.filter((c) => c.name === q);
  return COMMANDS.filter((c) => c.name.startsWith(q) && (!c.mode || c.mode === mode || q.length > 0)).sort(
    (a, b) => Number(!!b.mode && b.mode === mode) - Number(!!a.mode && a.mode === mode),
  );
}

/** Execute raw prompt input. Plain text adds a task/move; `#` writes a note. */
export function execute(input: string, ctx: CmdCtx): CmdResult | void {
  const raw = input.trim();
  if (!raw) return;
  try {
    if (raw.startsWith('/')) {
      const [, name, arg = ''] = raw.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
      const cmd = COMMANDS.find((c) => c.name === name?.toLowerCase());
      if (!cmd) return { text: `未知命令 /${name}。输入 /help 查看全部命令`, error: true };
      return cmd.run(arg, ctx);
    }
    if (raw.startsWith('#')) return mut(ctx, '记录', (d) => ops.addNote(d, raw.slice(1)));
    const s = ctx.store.get();
    if (!currentWs(s)) {
      // No workspace yet: treat text as the title of a new plan/goal.
      return s.ui.mode === 'plan'
        ? mut(ctx, '新建计划', (d) => `已创建计划「${ops.createPlan(d, raw).title}」· 继续输入即可添加任务`)
        : mut(ctx, '新建目标', (d) => `已设定目标「${ops.createGoal(d, raw).title}」· 继续输入即可添加行动`);
    }
    return mut(ctx, '添加任务', (d) => {
      const t = ops.addTask(d, raw);
      return `已添加 #${ops.orderedTasks(ops.requireWs(d)).findIndex((x) => x.id === t.id) + 1}：${t.title}`;
    });
  } catch (e) {
    if (e instanceof ops.UserError) return { text: e.message, error: true };
    console.error(e);
    return { text: `出错了：${(e as Error).message}`, error: true };
  }
}
