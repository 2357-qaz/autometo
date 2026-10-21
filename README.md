# AuTomeDo

> 像编写 Agent 计划一样组织自己的工作。一款借鉴 Claude Code 终端交互语言的个人任务与目标管理应用（V0）。

随时打开都能立刻知道：**我要做什么 · 我做到哪里 · 下一步怎么办**。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 核心逻辑单测（vitest）
npm run build      # 产物在 apps/web/dist/，纯静态，可直接部署
```

数据默认保存在浏览器 localStorage（键 `automedo.v0`），可通过 `/export`、`/import` 备份与恢复。

### 终端版（TUI）

```bash
npm run tui                          # 开发时直接运行（数据在 ~/.automedo）
npm run build -w @automedo/tui       # 打包成 apps/tui/dist/cli.js
npm install -g ./apps/tui            # 全局安装 automedo 命令
```

- `automedo`：交互界面。历史写进终端自己的滚动区，底部是当前任务 + 编号 Todo、输入框和状态行；
  `shift+tab` 切换模式，`ctrl+o` 切换/删除 Plan 与 Goal，`ctrl+f` 专注，`ctrl+n` 完成并下一个，`ctrl+z` 撤销，`?` 帮助。
- 子命令适合脚本和快速记录：`automedo add 买咖啡豆`、`automedo done 3`、`automedo next`、`automedo status`、`automedo diff`、`automedo log`、`automedo session 45 写文章页`、`automedo end`、`automedo review --md`（周回顾输出为 Markdown，可以存进笔记）；也可以执行任意斜杠命令，如 `automedo defer 3 等配色`。
- Compact 快照可以在表单里按 `e` 用 `$EDITOR` 编辑。
- 交互界面开着时用子命令改数据，界面会自动刷新；配置了同步时，子命令执行前后都会同步。

### 手机（PWA）

用服务器托管网页版（`AUTOMEDO_WEB_DIR`，并加上 HTTPS），在 iPhone 的 Safari 里打开 → 分享 → **添加到主屏幕**。

- 功能和电脑上一样完整；离线也能打开，联网后自动同步。
- 点一下任务展开操作栏；左滑完成、右滑延期；点输入框后键盘上方有常用命令。
- 快速记录：打开 `…/?add=买咖啡豆` 即添加任务（可配合 iOS 快捷指令），`?note=` 写一条记录。
- 提醒：`/sync` 里点「开启提醒」，Checkpoint 到期、阶段逾期、专注超时时会推送通知（iOS 16.4+，需从主屏幕打开）。

### 多设备同步（可选）

```bash
AUTOMEDO_TOKEN=$(openssl rand -base64 32) AUTOMEDO_WEB_DIR=apps/web/dist npm run server   # http://127.0.0.1:8787
```

然后在网页里输入 `/sync`，填服务器地址和令牌。离线照常使用，联网后自动合并。部署、Docker、HTTPS 见 [`packages/server/README.md`](packages/server/README.md)。

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

- **模型档位** `/model haiku|sonnet|opus` — 400 / 800 / 1500 tokens·min⁻¹；`/model`、`/effort`、`/fatigue` 不带参数时弹出选择（终端里在底栏原地 ←→ 选择、回车确认）
- **推理强度** `/effort low|medium|high` — ×0.6 / ×1 / ×1.5
- **专注 Session** `/session`、`/end` — 计时并按档位累计 Token；中途切档会分段计费
- **每日预算** `/budget 200k` — 顶栏额度条；剩余 40% / 15% 时变色并建议 `/compact`
- **疲劳自评** `/fatigue 1-5` — 越累 Token 越贵：疲劳 1–5 对应 ×1 / ×1.25 / ×2 / ×4 / ×8。进行中的 Session 按底栏当前的疲劳计；结束 Session 时可重新自评，用它给整个 Session 定价，不选则沿用底栏的值；已结束的 Session 不再变动

> “模型”“Token”只是交互隐喻，不代表真实 AI 推理，也不是对脑力或疲劳的生理测量。

## Compact / Resume

`/compact`（或结束 Session 时勾选）按规则生成 Markdown 工作快照：进度、当前阶段、进行中/阻塞/下一步、今日投入、最近动态，以及留给自己的「恢复时先做」。快照可编辑，不依赖 LLM。下次打开应用时，顶部会出现 Resume 提示。

## 周回顾

`/review` 回顾本周（周一 00:00 起），`/review last` 看上周，`/review -2` 再往前。全部按规则从日志与 Session 统计，不依赖 LLM：

- **概览**：完成数、专注时长、Token、有投入的天数，并和前一周比较
- **值得注意**：反复延期的任务、范围扩大（新增远多于完成）、累的时候仍用掉大部分预算、超预算的天数、Session 普遍超时、Checkpoint 偏离等
- **每天**：专注、Token 条（竖线为每日预算，超出标红）、当天最高疲劳、完成数
- **计划与目标**：各自的投入与完成项
- **偏离与修正**：本周的延期 / 修订 / 阻塞 / 跳过及其原因
- **投入方式**：各档位时长，Session 实际用时 / 计划

网页版可以用 ‹ › 翻周，「复制 Markdown」放进笔记。

## 键盘

`/` 命令行（带补全）· `Shift+Tab` 切换模式 · `o` 打开 Plan/Goal 列表 · `r` Resume · `j/k` 选择任务 · `Space` 切换状态 · `s/d/b` 开始/完成/阻塞 · `e` 编辑 · `x` 删除 · `J/K` 移动 · `[ ]` 切换 Plan/Goal · `n` 新建 · `f` Session · `c` Compact · `Ctrl+Z` 撤销 · `?` 帮助

命令行里直接输入文字 = 添加任务/行动；`#` 开头 = 写日志。所有操作也都可以用鼠标完成。

## 代码结构

npm workspaces 单仓库：

```
packages/core/    业务核心（不依赖 UI 与存储，供 Web / TUI / Server 共用）
  src/types.ts      数据模型
  src/state.ts      空状态、导入校验与旧数据迁移、选择器
  src/store.ts      状态容器：撤销栈 + 可注入的持久化适配器
  src/ops.ts        领域操作（计划/阶段/任务/目标/Checkpoint/Session），每次变更写入结构化事件
  src/diff.ts       Plan Diff：版本 vs 实际执行、首次偏离
  src/compact.ts    规则生成快照
  src/review.ts     规则生成周回顾
  src/hie.ts        Human Inference Engine 计算
  src/commands.ts   斜杠命令；需要表单时发出 Intent，由各客户端呈现
  src/sync.ts       记录级同步：拆分/重组、变更检测、合并
  src/sync-client.ts 同步客户端（Web 与 TUI 共用）
  tests/            单元测试
packages/server/  自托管同步服务器（node:sqlite），可同时托管网页版
apps/web/         WebUI（React + Vite），localStorage 持久化 + 同步客户端
apps/tui/         终端版（Ink），~/.automedo 文件持久化 + 同步客户端
docs/v1-plan.md   V1（TUI + 后端 + PWA）技术方案
```
