# AuTomeDo V1 技术方案

> 状态：第 1–4 阶段已完成 · 2026-10-10
> 已确定：**单人自用** · **iOS 先做 PWA** · **终端版用 TypeScript + Ink**

## 目标

V1 有三个客户端，共用一份数据：

| 客户端 | 定位 |
|---|---|
| **TUI**（终端） | 主工作台：写计划、执行、看 Diff、复盘 |
| **Web / PWA** | 现有 WebUI，功能完整；在 iPhone 上「添加到主屏幕」使用，界面针对触屏调整 |
| **Server** | 自托管的同步中心，并负责提醒推送 |

## 仓库结构（npm workspaces）

```
packages/core     业务核心：类型、计划/任务操作、Plan Diff、Compact、HIE、斜杠命令
packages/server   自托管同步服务（第 2 阶段）
apps/web          WebUI / PWA（现有代码）
apps/tui          终端版，Ink（第 3 阶段）
```

`core` 不依赖任何 UI 框架和存储方式：
- 状态容器 `createStore` 提供撤销栈，持久化通过注入的适配器完成（Web 用 localStorage，TUI 用本地文件或 SQLite）。
- 斜杠命令需要弹出表单时（新建、Checkpoint、Compact 等），只发出一个「意图」（Intent），由各个客户端自己决定怎么呈现：Web 弹窗口，TUI 显示行内表单。

## 同步设计：本地优先

- 每个客户端在本地保存完整数据，离线照常可用。
- 同步时，数据按「记录」拆开：计划元信息、阶段、任务、计划版本、Checkpoint、Session、Compact、日志事件，每条记录都有 `id` 和 `rev`（混合逻辑时钟）。
- 合并规则：
  - 日志事件只增不改，各端取并集。
  - 其他记录按 `rev` 保留最新的一份。
  - 删除操作留一个删除标记（tombstone），避免同步后被删的数据又回来。
- 接口：`POST /sync`，客户端上传上次同步后改过的记录（带游标），服务器返回其他端改过的记录。
- 单人使用，同一时刻通常只在一台设备上操作，所以按记录保留最新的已经足够，不需要复杂的协同算法（CRDT）。

## Server

- Node 22 + 轻量 HTTP 框架 + SQLite，可以跑在你自己的 Mac、NAS 或 VPS 上，也可以用 Docker 部署。
- 鉴权：单个访问令牌（`AUTOMEDO_TOKEN`），客户端第一次连接时填一次。
- 提醒：Checkpoint 到期、阶段逾期、专注超时，通过 Web Push 推送。iOS 16.4 及以上，添加到主屏幕的 PWA 可以收到推送。

## PWA（iOS）

**功能与终端版、网页版完整对等**：新建和删除 Plan/Goal，编辑阶段、任务、目标详情，修正（revise）、延期（defer）、Checkpoint、Compact、查看 Plan Diff，全都能在手机上完成。随手记一件事、临时调整计划时，不需要回到电脑前。

手机上调整的是界面的轻重和操作方式，不砍功能：

- **默认界面**：打开后先看到当前任务和 Todo，底部是输入框，打开即可直接输入，随手记录最快。其他内容（阶段、版本、Checkpoint、目标详情）放在可展开的标签里，点开就能编辑。
- **不依赖悬停和快捷键**：桌面上靠鼠标悬停才出现的操作（任务的开始/完成/延期/编辑/删除，阶段的修正/完成/排序，标题行的归档/删除），在触屏上一直显示，或者点一下任务就展开操作行。shift+tab、j/k 这类快捷键都有对应的可点按入口。
- **快速记录**：
  - 输入 `/` 时，键盘上方显示一排常用命令（task、done、next、defer、note、checkpoint）供点选；
  - 支持带参数打开，例如 `?add=买咖啡豆`，可以配合 iOS 快捷指令，一步加任务。
- **手势**：在任务上左滑显示「完成」，右滑显示「延期 / 删除」，作为按钮之外的快捷方式。
- **基础设施**：manifest、图标、Service Worker 离线缓存、适配刘海和底部横条的安全区域、软键盘弹出时输入框不被遮挡。
- **推送**：Checkpoint 到期、阶段逾期、专注超时（需要第 2 阶段的服务器）。

## TUI

- Ink + React，组件结构对应 WebUI：Transcript、Dock、输入框和状态行。
- 命令行入口：`automedo`（交互界面）、`automedo add "…"`、`automedo done`、`automedo diff`（不进界面，直接执行）。
- 发布方式：`npm i -g automedo`。

## 阶段

1. ✅ **共用核心**：拆出 `packages/core`，Web 改为引用它；修复 Plan/Goal 无法从界面删除的问题。
2. ✅ **Server + 同步**：`packages/server`（node:http + node:sqlite），`/v1/sync`、`/v1/export`，可托管网页版；同步逻辑在 `packages/core/src/sync.ts`，Web 通过 `/sync` 连接。
3. ✅ **TUI**：`apps/tui`（Ink 8）：Static 滚动历史 + 底部 Dock/输入/状态行、行内表单、切换器、`$EDITOR` 编辑快照、子命令、文件持久化与外部修改监听、同步。
4. ✅ **PWA**：manifest + Tomo 图标、Service Worker（离线可用）、iOS 安全区域与键盘适配、点按任务展开操作栏、左滑完成 / 右滑延期、键盘上方命令条、`?add=` / `?note=` 快速记录、Web Push 提醒（Checkpoint 到期、阶段逾期、专注超时）。
