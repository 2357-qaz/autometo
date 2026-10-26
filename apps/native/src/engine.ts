// The app's logic, running inside JavaScriptCore: @automedo/core (state, commands, sync,
// HIE…) plus the terminal version's forms and coloured lines. The SwiftUI side only
// draws what `view` returns and sends user actions through `call` (see main.ts).
import {
  COMMANDS,
  SyncClient,
  createDocPersistence,
  createStore,
  currentWs,
  describeUndo,
  emptyState,
  execute,
  fmtAgo,
  generateReview,
  glance,
  matchCommands,
  needsArg,
  ops,
  parseImport,
  pickSpec,
  reminderSchedule,
  reviewMarkdown,
  reviewTitle,
  seedDemo,
  splitIntent,
  type AppState,
  type CmdCtx,
  type CmdResult,
  type Intent,
  type PickKind,
  type SyncConfig,
  type SyncStorage,
} from '@automedo/core';
import { C, helpLines, planDiffLines, reviewLines, type Line } from '../../tui/src/format';
import { formFor, type Field, type FormSpec, type Values } from '../../tui/src/forms';
import { buildView } from './view';
import type { Host } from './host';

/** Something the screens should show after an action. */
export type IntentView =
  | { type: 'form'; id: string; title: string; color: string; desc: string | null; fields: Field[] }
  | { type: 'pick'; what: PickKind; title: string; options: { value: string; label: string; hint: string }[]; current: number }
  | { type: 'confirm'; id: string; title: string; message: string; confirmLabel: string; danger: boolean }
  | { type: 'lines'; title: string; lines: Line[] }
  | { type: 'review'; offset: number; title: string; lines: Line[]; markdown: string }
  | { type: 'switch' }
  | { type: 'export'; text: string; filename: string }
  | { type: 'import' };

export interface Result {
  text?: string;
  error?: boolean;
  undoable?: boolean;
  intent?: IntentView;
}

export type TaskAction = 'start' | 'done' | 'block' | 'skip' | 'reopen' | 'defer' | 'delete' | 'cycle' | 'up' | 'down' | 'split' | 'edit';

const SYNC_KEY = 'sync';
let seq = 0;
const newId = (p: string) => `${p}${++seq}`;

export function createEngine(host: Host) {
  let blocked: string | null = null;
  const persistence = createDocPersistence({
    read: () => host.readDoc(),
    write: (t) => {
      if (blocked) throw new Error(blocked);
      host.writeDoc(t);
    },
  });
  let loadError: string | null = null;
  let loaded: ReturnType<typeof persistence.load>;
  try {
    loaded = persistence.load();
  } catch (e) {
    // The file is there but could not be read (locked before the first unlock, no
    // permission, not text…): never start blank over it.
    const err = e as Error & { keptAside?: boolean };
    loaded = { state: emptyState(), error: null, raw: null };
    if (err.keptAside) {
      loadError = `数据文件读取失败：${err.message}。原文件已原样移到 App 的 aside 文件夹，这次从空白开始。`;
    } else {
      blocked = '数据文件读取失败，为避免覆盖原文件，已停用保存';
      loadError = `数据文件读取失败：${err.message}。为避免覆盖原文件，本次修改不会保存；请稍后重新打开 App。`;
    }
  }
  if (loaded.error) {
    // Keep the unreadable document: nothing may be written before it is safe somewhere.
    try {
      host.saveAside('unreadable', loaded.raw ?? '');
      loadError = `数据读取失败：${loaded.error}。原文件已另存到 App 的 aside 文件夹，这次从空白开始。`;
    } catch (e) {
      blocked = '数据读取失败且无法另存原文件，为避免覆盖，已停用保存';
      loadError = `数据读取失败：${loaded.error}。另存原文件也失败了（${(e as Error).message}），本次修改不会保存。`;
    }
  }
  const store = createStore(loaded.state, persistence.persist);
  persistence.attach(store);
  const syncStorage: SyncStorage = {
    loadConfig: () => JSON.parse(host.getItem(SYNC_KEY) ?? 'null') as SyncConfig | null,
    saveConfig: (c) => host.setItem(SYNC_KEY, c ? JSON.stringify(c) : null),
    loadMeta: persistence.loadMeta,
    updateMeta: persistence.updateMeta,
  };
  const sync = new SyncClient(store, syncStorage);
  const openedAt = Date.now();

  let notifyQueued = false;
  const notify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      host.changed();
    });
  };
  store.subscribe(notify);
  sync.subscribe(notify);
  sync.start();

  const forms = new Map<string, FormSpec>();
  const confirms = new Map<string, () => unknown>();

  /** What an intent (from a command, a form, a refused Fable start…) looks like on screen. */
  function present(i: Intent): IntentView | undefined {
    switch (i.type) {
      case 'help':
        return { type: 'lines', title: '命令', lines: helpLines(COMMANDS) };
      case 'review': {
        const r = generateReview(store.get(), i.offset);
        return { type: 'review', offset: i.offset, title: `周回顾 · ${reviewTitle(r)}`, lines: reviewLines(r), markdown: reviewMarkdown(r) };
      }
      case 'resume': {
        const c = store.get().compacts.find((x) => x.id === i.compactId);
        if (!c) return { type: 'lines', title: 'Resume', lines: [[{ t: '快照不存在', c: C.red }]] };
        store.mutate(null, (d) => {
          ops.selectWs(d, c.wsId);
          d.ui.dismissedCompactId = c.id;
        });
        return { type: 'lines', title: `Resume · ${fmtAgo(c.at)}`, lines: c.text.split('\n').map((t) => [{ t, c: C.fg2 }]) };
      }
      case 'pick': {
        const spec = pickSpec(i.what, store.get());
        return { type: 'pick', what: i.what, title: spec.title, options: spec.options, current: spec.current };
      }
      case 'confirm': {
        const id = newId('c');
        confirms.set(id, i.onConfirm);
        return { type: 'confirm', id, title: i.title, message: i.message, confirmLabel: i.confirmLabel ?? '确认', danger: !!i.danger };
      }
      case 'switch':
        return { type: 'switch' };
      default: {
        const spec = formFor(i, store, sync);
        if (!spec) return { type: 'lines', title: '无法打开', lines: [[{ t: '这个表单打不开（内容可能已被删除）', c: C.dim }]] };
        const id = newId('f');
        forms.set(id, spec);
        return { type: 'form', id, title: spec.title, color: spec.color, desc: spec.desc ?? null, fields: spec.fields };
      }
    }
  }

  /** Run something that may open intents (commands, forms); the last one opened is shown. */
  function collect(fn: (ctx: CmdCtx) => CmdResult | void | Result): Result {
    const opened: IntentView[] = [];
    const ctx: CmdCtx = {
      store,
      open: (i) => {
        const v = present(i);
        if (v) opened.push(v);
      },
      exportData: () => opened.push(exportIntent()),
      importData: () => opened.push({ type: 'import' }),
      showDiff: (planId, v) => {
        const p = store.get().plans.find((x) => x.id === planId);
        if (p) opened.push({ type: 'lines', title: `Plan Diff · ${p.title}`, lines: planDiffLines(p, v) });
      },
    };
    const r = (fn(ctx) ?? {}) as Result;
    return { ...r, intent: r.intent ?? opened[opened.length - 1] };
  }

  /** An edit; when Fable refuses it until a task is split, the split questions open instead. */
  function edit(label: string, fn: (d: AppState) => unknown): Result {
    try {
      const r = store.mutate(label, fn);
      return { text: typeof r === 'string' ? r : label, undoable: true };
    } catch (e) {
      if (e instanceof ops.SplitRequired) return { text: `${e.message}：先回答几个问题`, intent: present(splitIntent(e, label, fn)) };
      if (e instanceof ops.UserError) return { text: e.message, error: true };
      throw e;
    }
  }

  function exportIntent(): IntentView {
    const day = new Date().toISOString().slice(0, 10);
    return { type: 'export', text: JSON.stringify(store.get(), null, 2), filename: `automedo-backup-${day}.json` };
  }

  function taskAction(kind: TaskAction, taskId: string): Result {
    const set = (status: Parameters<typeof ops.setTaskStatus>[2], label: string) => edit(label, (d) => ops.setTaskStatus(d, taskId, status));
    switch (kind) {
      case 'start':
        return set('active', '开始任务');
      case 'done':
        return set('done', '完成任务');
      case 'block':
        return set('blocked', '标记阻塞');
      case 'skip':
        return set('skipped', '跳过任务');
      case 'reopen':
        return set('pending', '重新打开');
      case 'defer':
        return edit('延期', (d) => ops.deferTask(d, taskId));
      case 'delete':
        return edit('删除任务', (d) => ops.deleteTask(d, taskId));
      case 'cycle':
        return edit('切换任务状态', (d) => ops.cycleTask(d, taskId));
      case 'up':
      case 'down':
        store.mutate('移动任务', (d) => ops.moveTask(d, taskId, kind === 'up' ? -1 : 1));
        return {};
      case 'split':
        return { intent: present({ type: 'split', taskId }) };
      case 'edit':
        return { intent: present({ type: 'editTask', taskId }) };
    }
  }

  const api = {
    view: () => buildView(store.get(), sync.getStatus(), { openedAt, canUndo: store.canUndo() }),
    loadError: () => loadError,
    execute: ({ input }: { input: string }) => collect((ctx) => execute(input, ctx)),
    act: ({ kind, taskId }: { kind: TaskAction; taskId: string }) => taskAction(kind, taskId),
    /** Add a task as typed (no command parsing), to a given phase or the current one. */
    addTask: ({ title, phaseId }: { title: string; phaseId?: string | null }) =>
      edit('添加任务', (d) => {
        const t = ops.addTask(d, title, phaseId ?? undefined);
        return `已添加 #${ops.orderedTasks(ops.requireWs(d)).indexOf(t) + 1}：${t.title}`;
      }),
    open: ({ intent }: { intent: Intent }) => ({ intent: present(intent) }),
    async submitForm({ id, values }: { id: string; values: Values }): Promise<Result> {
      const spec = forms.get(id);
      if (!spec) return { text: '这个表单已经关闭了', error: true };
      const r = await spec.submit(values);
      if (r.error) return { text: r.error, error: true };
      forms.delete(id);
      return { text: r.text, undoable: true, intent: r.next ? present(r.next) : undefined };
    },
    cancelForm: ({ id }: { id: string }) => void forms.delete(id),
    pick({ what, value }: { what: PickKind; value: string }): Result {
      const spec = pickSpec(what, store.get());
      return edit(spec.label, (d) => spec.apply(d, value));
    },
    confirm({ id, ok }: { id: string; ok: boolean }): Result {
      const fn = confirms.get(id);
      confirms.delete(id);
      if (!fn || !ok) return { text: '已取消' };
      try {
        const r = fn();
        return { text: typeof r === 'string' ? r : '完成', undoable: true };
      } catch (e) {
        return { text: (e as Error).message, error: true };
      }
    },
    selectWs({ id }: { id: string }): Result {
      store.mutate(null, (d) => ops.selectWs(d, id));
      return {};
    },
    setMode({ mode }: { mode: 'plan' | 'goal' }): Result {
      store.mutate(null, (d) => {
        d.ui.mode = mode;
        if (mode === 'plan') d.ui.activePlanId ??= d.plans[0]?.id ?? null;
        else d.ui.activeGoalId ??= d.goals[0]?.id ?? null;
      });
      return {};
    },
    deleteWs({ id }: { id: string }): Result {
      const w = [...store.get().plans, ...store.get().goals].find((x) => x.id === id);
      if (!w) return {};
      return {
        intent: present({
          type: 'confirm',
          title: `删除「${w.title}」？`,
          message: '其任务、日志与快照将一起删除。之后可以撤销。',
          confirmLabel: '删除',
          danger: true,
          onConfirm: () => store.mutate('删除', (d) => ops.deleteWs(d, id)),
        }),
      };
    },
    dismissResume: ({ compactId }: { compactId: string }) => void store.mutate(null, (d) => void (d.ui.dismissedCompactId = compactId)),
    undo(): Result {
      const r = describeUndo(store.undo());
      return { text: r.text, error: r.error };
    },
    suggest: ({ input }: { input: string }) =>
      matchCommands(input, store.get().ui.mode)
        .slice(0, 12)
        .map((c) => ({ name: c.name, args: c.args ?? '', desc: c.desc, needsArg: needsArg(c) })),
    review: ({ offset }: { offset: number }) => ({ intent: present({ type: 'review', offset }) }),
    exportDoc: () => ({ intent: exportIntent() }),
    importDoc({ text }: { text: string }): Result {
      let next: AppState;
      try {
        next = parseImport(JSON.parse(text));
      } catch (e) {
        return { text: `导入失败：${(e as Error).message}`, error: true };
      }
      return {
        intent: present({
          type: 'confirm',
          title: '导入备份？',
          message: `将用备份中的 ${next.plans.length} 个 Plan、${next.goals.length} 个 Goal 覆盖当前数据。之后可以撤销；建议先导出当前数据。`,
          confirmLabel: '覆盖导入',
          danger: true,
          // The backup may come from another device: this one keeps its own identity.
          onConfirm: () => store.replace({ ...next, ui: { ...next.ui, deviceId: store.get().ui.deviceId } }, '导入备份'),
        }),
      };
    },
    glance: () => glance(store.get()),
    reminders: () => reminderSchedule(store.get()),
    flush: () => store.flush(),
    async syncNow(): Promise<Result> {
      if (!sync.config()) return { text: '还没有连接服务器：输入 /sync 连接', error: true };
      try {
        await sync.syncNow(true);
        return { text: '已同步' };
      } catch (e) {
        return { text: (e as Error).message, error: true };
      }
    },
    /** Demo data (for screenshots / a first look), keeping this device's identity. */
    seedDemo(): Result {
      const s = emptyState();
      s.ui.deviceId = store.get().ui.deviceId; // before seeding: its tasks in progress are this device's
      seedDemo(s);
      store.replace(s, '载入示例数据');
      return { text: '已载入示例数据', undoable: true };
    },
    currentWsId: () => currentWs(store.get())?.id ?? null,
  };

  return { api, store, sync };
}

export type Engine = ReturnType<typeof createEngine>;
