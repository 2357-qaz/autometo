# AuTomeDo V1 技术方案

> 状态：草案 · 2026-10-10
> 已确定：**单人自用** · **iOS 先做 PWA** · **终端版用 TypeScript + Ink**

## 目标

V1 有三个客户端，共用一份数据：

| 客户端 | 定位 |
|---|---|
| **TUI**（终端） | 主工作台：写计划、执行、看 Diff、复盘 |
| **Web / PWA** | 现有 WebUI；在 iPhone 上「添加到主屏幕」后作为随身伴侣 |
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

- 包含 manifest、图标、Service Worker 离线缓存，以及适配刘海和底部横条的安全区域。
- 手机上只突出随身最常用的功能：当前任务和 Todo、完成或卡住、随手记录、专注计时、到期时填写 Checkpoint；记录和 Plan Diff 只读。
- 交互按触屏调整：模式切换改成点按，快捷键改成手势，在键盘上方显示一排常用命令。

## TUI

- Ink + React，组件结构对应 WebUI：Transcript、Dock、输入框和状态行。
- 命令行入口：`automedo`（交互界面）、`automedo add "…"`、`automedo done`、`automedo diff`（不进界面，直接执行）。
- 发布方式：`npm i -g automedo`。

## 阶段

1. **共用核心**（本次）：拆出 `packages/core`，Web 改为引用它；修复 Plan/Goal 无法从界面删除的问题。
2. **Server + 同步**：数据按记录存储、加上时钟和删除标记，实现 `/sync` 接口，Web 接入同步。
3. **TUI**：用 Ink 实现完整交互，接入同步。
4. **PWA**：manifest、Service Worker、手机端适配、推送。
