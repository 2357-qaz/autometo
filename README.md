# AuTomeDo

> 像编写 Agent 计划一样组织自己的工作。一款借鉴 Claude Code 终端交互语言的个人任务与目标管理应用（V0）。

随时打开都能立刻知道：**我要做什么 · 我做到哪里 · 下一步怎么办**。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 核心逻辑单测（vitest）
npm run build      # 产物在 dist/，纯静态，可直接部署
```

数据只保存在浏览器 localStorage（键 `automedo.v0`），可通过 `/export`、`/import` 备份与恢复。

## 界面

借用 Claude Code 的对话结构：

| Claude Code | AuTomeDo |
|---|---|
| 一轮对话 | 一次专注 Session |
| 用户消息 `>` | Session 的意图 |
| 工具调用 `⏺ Read(…)` | 执行事件 `⏺ Start(…)` `⏺ Done(…)` `⏺ Block(…)` `⏺ Defer(…)` |
| `⏺ Update(file)` + 内联 diff | `⏺ Write/Update(Plan)` + 计划变更 diff |
| token 计数 | HIE 投入（专注时长 / tokens） |
| spinner 下的 Todo 列表 | 输入框上方的当前任务 + 接下来的 Todo |

主区域就是 **Execution Log**：按天分隔、按 Session 分组，早先的 Session 折叠成一行。顶部只有一行进度与「相对 v1：+2 −1 ~2」，任务 / 阶段 / 版本收在标签里。

## Execution Log 与 Plan Diff

- 每次开始、完成、阻塞、解除阻塞、跳过、延期（`/defer`）、新增、删除、修改、修正（`/revise`）都记录为结构化事件，并关联到当时的专注 Session；「完成」事件带专注用时与 tokens。
- **计划版本**：第一次开始任务时自动生成基准 **v1**；每次 `/revise`（必须写原因）或 `/commit` 生成新版本。
- **`/diff [v]`**：像 git diff 一样对比某个版本和实际执行——`+` 新增、`-` 移除/跳过、`~` 修改/移动、`!` 逾期/阻塞/延期，并指出**首次偏离**发生在哪一天、哪个阶段。
- 阶段可设可选的目标日期（`/due 10-20`、`/due +3d`），用于判断逾期。

## 两种模式（Shift+Tab 切换）

| | Plan Mode ⏸ | Goal Mode ⏵⏵ |
|---|---|---|
| 适用 | 路径相对明确：先想再做 | 路径不明确：先干起来再想 |
| 结构 | 计划 → 阶段（含阶段目标）→ 任务 | 目标 → 下一步 / 行动（Moves）→ Checkpoint |
| 推进 | 同一时间只有一个「进行中」任务；`/next` 完成并开始下一个 | 按周期（默认 7 天）提示 Checkpoint：做了什么 / 学到什么 / 下一步 |
| 修正 | `/revise` 修正阶段目标，**必须写原因**，记入执行日志 | Checkpoint 判断：顺利 / 偏航 / 受阻 / 转向 |

## Human Inference Engine（HIE）

两种模式共用的投入管理隐喻：

- **模型档位** `/model haiku|sonnet|opus` — 400 / 800 / 1500 tokens·min⁻¹
- **推理强度** `/effort low|medium|high` — ×0.6 / ×1 / ×1.5
- **专注 Session** `/session`、`/end` — 计时并按档位累计 Token；中途切档会分段计费
- **每日预算** `/budget 200k` — 顶栏额度条；剩余 40% / 15% 时变色并建议 `/compact`
- **疲劳自评** `/fatigue 1-5` — 结束 Session 时也可自评；结合预算给出温和建议

> “模型”“Token”只是交互隐喻，不代表真实 AI 推理，也不是对脑力或疲劳的生理测量。

## Compact / Resume

`/compact`（或结束 Session 时勾选）按规则生成 Markdown 工作快照：进度、当前阶段、进行中/阻塞/下一步、今日投入、最近动态，以及留给自己的「恢复时先做」。快照可编辑，不依赖 LLM。下次打开应用时，顶部会出现 Resume 提示。

## 键盘

`/` 命令行（带补全）· `Shift+Tab` 切换模式 · `o` 打开 Plan/Goal 列表 · `r` Resume · `j/k` 选择任务 · `Space` 切换状态 · `s/d/b` 开始/完成/阻塞 · `e` 编辑 · `x` 删除 · `J/K` 移动 · `[ ]` 切换 Plan/Goal · `n` 新建 · `f` Session · `c` Compact · `Ctrl+Z` 撤销 · `?` 帮助

命令行里直接输入文字 = 添加任务/行动；`#` 开头 = 写日志。所有操作也都可以用鼠标完成。

## 代码结构

```
src/
  types.ts      数据模型
  store.ts      状态容器：撤销栈、localStorage 持久化、导入校验
  ops.ts        纯领域操作（计划/阶段/任务/目标/Checkpoint/Session）
  hie.ts        Human Inference Engine 计算
  compact.ts    规则生成快照
  diff.ts       Plan Diff：版本 vs 实际执行、首次偏离
  commands.ts   斜杠命令注册与解析
  components/   终端风格 UI
tests/          核心逻辑单测
```
