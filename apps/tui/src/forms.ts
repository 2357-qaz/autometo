// Intent → inline form spec. Pure logic; the Ink layer only renders and collects input.
import {
  activePlan,
  activeSession,
  currentWs,
  EFFORT_ORDER,
  EFFORTS,
  FATIGUE_LABELS,
  findWs,
  generateCompact,
  ops,
  runSegmentsTokens,
  TIER_ORDER,
  TIERS,
  type Effort,
  type Intent,
  type Store,
  type SyncClient,
  type Tier,
  type Verdict,
} from '@automedo/core';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export type Field =
  | { kind: 'text'; key: string; label: string; initial?: string; placeholder?: string; required?: boolean; secret?: boolean }
  | { kind: 'select'; key: string; label: string; options: Option[]; initial?: string }
  | { kind: 'slider'; key: string; label: string; initial: number; step: number }
  | { kind: 'confirm'; key: string; label: string; initial: boolean }
  | { kind: 'editor'; key: string; label: string; initial: string };

export type Values = Record<string, string | number | boolean>;

export interface SubmitResult {
  text?: string;
  error?: string;
  /** Open another form afterwards (e.g. compact after ending a session). */
  next?: Intent;
}

export interface FormSpec {
  title: string;
  color: string;
  desc?: string;
  fields: Field[];
  submit: (v: Values) => SubmitResult | Promise<SubmitResult>;
}

const str = (v: Values, k: string) => String(v[k] ?? '').trim();

/** Run a store mutation, turning thrown UserErrors into a form error. */
function mutate(store: Store, label: string, fn: Parameters<Store['mutate']>[1]): SubmitResult {
  try {
    const r = store.mutate(label, fn);
    return { text: typeof r === 'string' ? r : label };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function formFor(intent: Intent, store: Store, sync: SyncClient): FormSpec | null {
  const s = store.get();
  switch (intent.type) {
    case 'newPlan':
      return {
        title: '新建 Plan',
        color: '#4fb3a6',
        desc: '路径相对明确：先写计划、划分阶段，再执行。',
        fields: [
          { kind: 'text', key: 'title', label: '标题', initial: intent.title, required: true },
          { kind: 'text', key: 'objective', label: '目标 / 完成定义' },
          { kind: 'text', key: 'phases', label: '阶段', placeholder: '用逗号分隔，例如：调研, 设计, 实现（可留空）' },
        ],
        submit: (v) =>
          mutate(store, '新建计划', (d) => {
            const p = ops.createPlan(d, str(v, 'title'), str(v, 'objective'));
            const names = str(v, 'phases').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
            if (names.length) {
              p.phases = [];
              names.forEach((n) => ops.addPhase(d, n));
            }
            return `已创建计划「${p.title}」`;
          }),
      };
    case 'newGoal':
      return {
        title: '新建 Goal',
        color: '#a68cf2',
        desc: '路径不明确：先设目标、开始行动，用 Checkpoint 逐步找方向。',
        fields: [
          { kind: 'text', key: 'title', label: '目标', initial: intent.title, required: true },
          { kind: 'text', key: 'why', label: '为什么重要' },
          { kind: 'text', key: 'doneWhen', label: '怎样算达成', placeholder: '可以先模糊' },
          { kind: 'text', key: 'next', label: '第一步动作', placeholder: '30 分钟内能开始的事' },
          { kind: 'text', key: 'cadence', label: 'Checkpoint 周期（天）', initial: '7' },
        ],
        submit: (v) =>
          mutate(store, '新建目标', (d) => {
            const g = ops.createGoal(d, str(v, 'title'), { why: str(v, 'why'), doneWhen: str(v, 'doneWhen'), nextAction: str(v, 'next'), cadenceDays: Number(str(v, 'cadence')) || 7 });
            return `已设定目标「${g.title}」`;
          }),
      };
    case 'session': {
      const ws = currentWs(s);
      const active = ws ? ops.orderedTasks(ws).find((t) => t.status === 'active') : undefined;
      return {
        title: '开始专注 Session',
        color: '#d97757',
        desc: `今天以什么档位工作？${ws ? `关联「${ws.title}」` : ''}`,
        fields: [
          { kind: 'text', key: 'intent', label: '这次要做什么', initial: active?.title ?? (ws?.kind === 'goal' ? ws.nextAction : '') },
          { kind: 'select', key: 'tier', label: '模型档位', initial: s.hie.tier, options: TIER_ORDER.map((t) => ({ value: t, label: `${TIERS[t].label} · ${TIERS[t].rate}/min`, hint: TIERS[t].hint })) },
          { kind: 'select', key: 'effort', label: '推理强度', initial: s.hie.effort, options: EFFORT_ORDER.map((e) => ({ value: e, label: `${e} ×${EFFORTS[e].mult}`, hint: EFFORTS[e].hint })) },
          { kind: 'text', key: 'minutes', label: '计划时长（分钟）', initial: String(intent.minutes ?? 25) },
        ],
        submit: (v) =>
          mutate(store, '开始 Session', (d) => ops.startSession(d, { intent: str(v, 'intent'), plannedMin: Number(str(v, 'minutes')) || 25, tier: str(v, 'tier') as Tier, effort: str(v, 'effort') as Effort })),
      };
    }
    case 'endSession': {
      const cur = activeSession(s);
      if (!cur) return null;
      return {
        title: '结束 Session',
        color: '#6fbf73',
        desc: `已专注 · ↑ ${runSegmentsTokens(s, cur.runId).toLocaleString()} tokens`,
        fields: [
          { kind: 'text', key: 'outcome', label: '这次推进了什么', placeholder: '一句话结果（可选）' },
          { kind: 'select', key: 'fatigue', label: '疲劳自评', initial: '0', options: [{ value: '0', label: '跳过' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} ${FATIGUE_LABELS[n]}` }))] },
          ...(cur.wsId ? [{ kind: 'confirm' as const, key: 'compact', label: '结束后生成 Compact 快照', initial: true }] : []),
        ],
        submit: (v) => {
          const r = mutate(store, '结束 Session', (d) => ops.endSession(d, { fatigue: Number(v.fatigue) || null, outcome: str(v, 'outcome') }));
          if (!r.error && v.compact && cur.wsId) r.next = { type: 'compact', wsId: cur.wsId };
          return r;
        },
      };
    }
    case 'revise': {
      const ph = activePlan(s)?.phases.find((x) => x.id === intent.phaseId);
      if (!ph) return null;
      return {
        title: `修正阶段「${ph.title}」`,
        color: '#e5b85c',
        desc: `原目标：${ph.goal || '（未设定）'}`,
        fields: [
          { kind: 'text', key: 'goal', label: '修正后的阶段目标', initial: ph.goal, required: true },
          { kind: 'text', key: 'reason', label: '修正原因', placeholder: '发现了什么？哪个假设不成立？', required: true },
        ],
        submit: (v) => mutate(store, '修正阶段', (d) => ops.revisePhase(d, ph.id, str(v, 'goal'), str(v, 'reason'))),
      };
    }
    case 'checkpoint': {
      const g = s.goals.find((x) => x.id === intent.goalId);
      if (!g) return null;
      const last = g.checkpoints[g.checkpoints.length - 1];
      const did = g.moves.filter((m) => m.status === 'done' && (m.doneAt ?? 0) > (last?.at ?? 0)).map((m) => m.title).join('；');
      const V: [Verdict, string, string][] = [
        ['on-track', '顺利', '方向对，继续'],
        ['drifting', '偏航', '在做，但不太对'],
        ['blocked', '受阻', '卡住了'],
        ['pivot', '转向', '要换方向'],
      ];
      return {
        title: `Checkpoint #${g.checkpoints.length + 1} · ${g.title}`,
        color: '#a68cf2',
        desc: last ? `上次 ${last.progress}%` : '第一次 Checkpoint：看看行动带来了什么。',
        fields: [
          { kind: 'slider', key: 'progress', label: '主观进度', initial: last?.progress ?? 0, step: 5 },
          { kind: 'select', key: 'verdict', label: '判断', initial: 'on-track', options: V.map(([value, label, hint]) => ({ value, label, hint })) },
          { kind: 'text', key: 'did', label: '做了什么', initial: did },
          { kind: 'text', key: 'learned', label: '学到 / 发现了什么' },
          { kind: 'text', key: 'next', label: '下一步方向', initial: g.nextAction },
        ],
        submit: (v) =>
          mutate(store, 'Checkpoint', (d) =>
            ops.addCheckpoint(d, g.id, { progress: Number(v.progress), verdict: str(v, 'verdict') as Verdict, did: str(v, 'did'), learned: str(v, 'learned'), next: str(v, 'next') }),
          ),
      };
    }
    case 'compact': {
      const ws = findWs(s, intent.wsId);
      if (!ws) return null;
      return {
        title: `/compact · ${ws.title}`,
        color: '#7aa7e0',
        desc: '按当前状态生成的工作快照（不使用 AI）。',
        fields: [{ kind: 'editor', key: 'text', label: '快照', initial: generateCompact(s, ws) }],
        submit: (v) => mutate(store, 'Compact', (d) => ops.saveCompact(d, ws.id, str(v, 'text'))),
      };
    }
    case 'editTask': {
      const ws = currentWs(s);
      const t = ws && (ws.kind === 'plan' ? ws.tasks : ws.moves).find((x) => x.id === intent.taskId);
      if (!ws || !t) return null;
      return {
        title: '编辑任务',
        color: '#e8e6dc',
        fields: [
          { kind: 'text', key: 'title', label: '标题', initial: t.title, required: true },
          { kind: 'text', key: 'note', label: '备注', initial: t.note ?? '' },
          ...(ws.kind === 'plan' ? [{ kind: 'select' as const, key: 'phase', label: '所属阶段', initial: t.phaseId ?? '', options: ws.phases.map((p) => ({ value: p.id, label: p.title })) }] : []),
        ],
        submit: (v) => mutate(store, '编辑任务', (d) => ops.updateTask(d, t.id, { title: str(v, 'title'), note: str(v, 'note'), phaseId: ws.kind === 'plan' ? str(v, 'phase') || null : undefined })),
      };
    }
    case 'confirm':
      return {
        title: intent.title,
        color: intent.danger ? '#ef6f6c' : '#e8e6dc',
        desc: intent.message,
        fields: [{ kind: 'confirm', key: 'ok', label: intent.confirmLabel ?? '确认', initial: false }],
        submit: (v) => {
          if (!v.ok) return { text: '已取消' };
          try {
            const r = intent.onConfirm() as unknown;
            return { text: typeof r === 'string' ? r : `${intent.confirmLabel ?? '确认'}完成` };
          } catch (e) {
            return { error: (e as Error).message };
          }
        },
      };
    case 'sync': {
      const cfg = sync.config();
      return {
        title: '同步',
        color: '#7aa7e0',
        desc: cfg ? `当前：${cfg.url}（留空令牌则保持不变；输入 - 断开）` : '连接自托管的 AuTomeDo 服务器，在终端、网页和手机间共用数据。',
        fields: [
          { kind: 'text', key: 'url', label: '服务器地址', initial: cfg?.url ?? 'http://localhost:8787', required: true },
          { kind: 'text', key: 'token', label: '访问令牌', secret: true, required: !cfg },
        ],
        submit: async (v) => {
          if (str(v, 'url') === '-') {
            sync.disconnect();
            return { text: '已断开同步，本地数据保留' };
          }
          if (!/^https?:\/\/./.test(str(v, 'url'))) return { error: '服务器地址需要以 http:// 或 https:// 开头' };
          try {
            await sync.connect({ url: str(v, 'url').replace(/\/+$/, ''), token: str(v, 'token') || cfg!.token });
            return { text: `已连接 ${str(v, 'url')}，数据已同步` };
          } catch (e) {
            return { error: (e as Error).message };
          }
        },
      };
    }
    default:
      return null; // help / resume / switch are handled by the UI directly
  }
}
