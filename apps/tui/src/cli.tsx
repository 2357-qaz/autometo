// `automedo` — interactive TUI with no arguments, one-shot commands otherwise.
import { readFileSync } from 'node:fs';
import { render } from 'ink';
import {
  activeSession,
  COMMANDS,
  createStore,
  currentWs,
  execute,
  normalize,
  ops,
  SyncClient,
  type CmdCtx,
  type Store,
} from '@automedo/core';
import { toAnsi } from './ansi';
import { C, dockLines, eventLines, historyBlocks, planDiffLines, wsHeaderLines, type Line } from './format';
import { attachStore, filePersist, fileSyncStorage, homeDir, loadState, reloadState, watchState } from './storage';
import { App } from './ui';

const VERSION = '0.2.0';

const USAGE = `AuTomeDo ${VERSION} — 像编写 Agent 计划一样组织自己的工作

用法
  automedo                     打开交互界面
  automedo add <内容>          添加任务（当前 Plan）或行动（当前 Goal）
  automedo note <内容>         写一条记录
  automedo done [#n]           完成任务（默认当前进行中的）
  automedo next                完成当前任务并开始下一个
  automedo session [分钟] [意图]  开始专注 Session（用当前档位）
  automedo end [结果]          结束专注 Session
  automedo status              当前 Plan/Goal、当前任务与 Todo
  automedo log [-n 50]         Execution Log
  automedo diff [v]            Plan Diff
  automedo ls                  列出所有 Plan / Goal
  automedo use <名称或序号>     切换当前 Plan / Goal
  automedo sync                立即同步（需先在界面里 /sync 连接）
  automedo export              导出 JSON 到标准输出
  automedo import <文件>        从 JSON 导入（覆盖本地数据）
  automedo <命令> [参数]        执行任意斜杠命令，如 automedo defer 3 等配色

数据目录：${homeDir()}（可用 AUTOMEDO_HOME 修改）`;

const out = (lines: Line[]): void => void process.stdout.write(toAnsi(lines) + "\n");
const fail = (msg: string): never => {
  process.stderr.write(toAnsi([[{ t: '✗ ', c: C.red }, { t: msg, c: C.red }]]) + '\n');
  process.exit(1);
};

async function withSync(store: Store, fn: () => Promise<void> | void) {
  const sync = new SyncClient(store, fileSyncStorage);
  const configured = !!fileSyncStorage.loadConfig();
  if (configured) await sync.syncNow().catch(() => {});
  await fn();
  store.flush();
  if (configured) {
    await sync.syncNow();
    const st = sync.getStatus();
    if (st.phase === 'offline' || st.phase === 'error') process.stderr.write(toAnsi([[{ t: `⚠ ${st.error ?? '同步失败'}（已保存在本地，下次自动同步）`, c: C.yellow }]]) + '\n');
  }
  store.flush();
}

async function oneShot(argv: string[]) {
  const [cmd, ...rest] = argv;
  const arg = rest.join(' ');
  const loaded = loadState();
  if (loaded.error) fail(loaded.error);
  const store = createStore(loaded.state, filePersist, 0);
  attachStore(store);

  await withSync(store, () => {
    const s = store.get();
    const ws = currentWs(s);
    switch (cmd) {
      case 'status':
      case 'st': {
        if (!ws) return out([[{ t: '还没有打开的 Plan/Goal。运行 automedo 开始，或 automedo ls 查看。', c: C.dim }]]);
        return out([...wsHeaderLines(ws), ...dockLines(ws, 8)]);
      }
      case 'log': {
        if (!ws) fail('还没有打开的 Plan/Goal');
        const n = Number(rest[rest.indexOf('-n') + 1]) || 50;
        return out([...wsHeaderLines(ws!), ...historyBlocks(ws!, s.sessions, n).flatMap((b) => b.lines)]);
      }
      case 'diff': {
        if (ws?.kind !== 'plan') fail('Plan Diff 只适用于 Plan。用 automedo use 切换到一个 Plan');
        return out(planDiffLines(ws as never, arg ? Number(arg.replace(/^v/i, '')) : undefined));
      }
      case 'ls': {
        const all = [...s.plans, ...s.goals];
        if (!all.length) return out([[{ t: '还没有 Plan 或 Goal', c: C.dim }]]);
        return out(
          all.map((w, i) => [
            { t: `${String(i + 1).padStart(2)}  `, c: C.faint },
            { t: w.kind === 'plan' ? '⏸  ' : '⏵⏵ ', c: w.kind === 'plan' ? C.teal : C.violet },
            { t: w.title, c: w.status === 'active' ? C.fg : C.faint, b: w.id === ws?.id },
            { t: `${w.status !== 'active' ? `  [${w.status}]` : ''}${w.id === ws?.id ? '  ← 当前' : ''}`, c: C.faint },
          ]),
        );
      }
      case 'use': {
        const all = [...s.plans, ...s.goals];
        const n = Number(arg);
        const w = Number.isInteger(n) && n >= 1 ? all[n - 1] : all.find((x) => x.title === arg) ?? all.find((x) => x.title.includes(arg));
        if (!w) fail(`找不到「${arg}」。用 automedo ls 查看`);
        store.mutate(null, (d) => ops.selectWs(d, w!.id));
        return out(wsHeaderLines(w!));
      }
      case 'export':
        return void process.stdout.write(JSON.stringify(s, null, 2) + '\n');
      case 'import': {
        if (!arg) fail('用法：automedo import <文件>');
        let next;
        try {
          next = normalize(JSON.parse(readFileSync(arg, 'utf8')));
        } catch (e) {
          fail(`导入失败：${(e as Error).message}`);
        }
        store.replace(next!, '导入');
        return out([[{ t: `✓ 已导入 ${next!.plans.length} 个 Plan、${next!.goals.length} 个 Goal`, c: C.green }]]);
      }
      case 'sync':
        return; // withSync already synced
      case 'session': {
        // Non-interactive start with the current model/effort.
        const n0 = ws?.log.length ?? 0;
        try {
          const msg = store.mutate('开始 Session', (d) => ops.startSession(d, { intent: rest.filter((x) => !/^\d+$/.test(x)).join(' '), plannedMin: Number(rest.find((x) => /^\d+$/.test(x))) || 25, tier: d.hie.tier, effort: d.hie.effort }));
          const w = currentWs(store.get());
          return out(w ? w.log.slice(n0).flatMap((e) => eventLines(e, w, store.get().sessions)) : [[{ t: msg, c: C.fg2 }]]);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      case 'end': {
        const n0 = ws?.log.length ?? 0;
        try {
          const msg = store.mutate('结束 Session', (d) => ops.endSession(d, { outcome: arg }));
          const w = currentWs(store.get());
          return out(w && w.log.length > n0 ? w.log.slice(n0).flatMap((e) => eventLines(e, w, store.get().sessions)) : [[{ t: msg, c: C.fg2 }]]);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    }
    // Everything else maps to a slash command.
    const text = cmd === 'add' || cmd === 'a' ? arg : cmd === 'note' ? `#${arg}` : `/${cmd}${arg ? ' ' + arg : ''}`;
    if (!text.trim()) fail('内容为空');
    const n0 = ws?.log.length ?? 0;
    const ctx: CmdCtx = {
      store,
      open: (i) => fail(i.type === 'help' ? USAGE : `「${cmd}」需要交互输入，请在界面里使用：automedo`),
      exportData: () => process.stdout.write(JSON.stringify(store.get(), null, 2) + '\n'),
      importData: () => fail('用法：automedo import <文件>'),
      showDiff: (planId, v) => out(planDiffLines(store.get().plans.find((p) => p.id === planId)!, v)),
    };
    const r = execute(text, ctx);
    const after = currentWs(store.get());
    if (r?.error) fail(r.text);
    if (after && after.id === ws?.id && after.log.length > n0) out(after.log.slice(n0).flatMap((e) => eventLines(e, after, store.get().sessions)));
    else if (r?.text) out([[{ t: r.text, c: C.fg2 }]]);
    if (after) out(dockLines(after, 3));
  });
}

async function interactive() {
  if (!process.stdin.isTTY) fail('交互界面需要在终端里运行。脚本中请使用子命令，例如 automedo status');
  const loaded = loadState();
  const store = createStore(loaded.state, filePersist, 100);
  attachStore(store);
  const sync = new SyncClient(store, fileSyncStorage);
  sync.start();
  // Another `automedo …` process changed the data file: pick it up.
  const unwatch = watchState(() => {
    const fresh = reloadState(); // state + that process's sync meta
    if (fresh) store.mutate(null, (d) => void Object.assign(d, { ...fresh, ui: { ...d.ui, ...fresh.ui } }));
  });
  // Start at the bottom of the terminal (what was on screen scrolls up into history),
  // so the prompt and status line sit on the last rows from the first frame.
  process.stdout.write('\n'.repeat(Math.max(0, (process.stdout.rows ?? 0) - 1)));
  const ink = render(<App store={store} sync={sync} loadError={loaded.error} />, { exitOnCtrlC: false });
  await ink.waitUntilExit();
  unwatch();
  store.flush();
  sync.stop();
  if (activeSession(store.get())) out([[{ t: '✻ 专注 Session 仍在计时 · 回来继续，或 ', c: C.dim }, { t: 'automedo end', c: C.accent }, { t: ' 结束', c: C.dim }]]);
  if (fileSyncStorage.loadConfig()) await Promise.race([sync.syncNow(), new Promise((r) => setTimeout(r, 3000))]);
  store.flush();
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
  process.stdout.write(USAGE + '\n\n斜杠命令：' + COMMANDS.map((c) => c.name).join(' ') + '\n');
} else if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(VERSION + '\n');
} else if (!argv.length) {
  void interactive();
} else {
  oneShot(argv).catch((e) => fail((e as Error).message));
}
