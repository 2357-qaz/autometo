# 审计修复对照

对应 [report.md](report.md) 的 14 项缺陷。审计场景全部以普通测试运行（`audit/regression.test.ts` 的 `FIXED`），CI 每次推送都会跑 `npm run audit:test`。

| 编号 | 修复 | 提交 | 主要测试 |
|---|---|---|---|
| R01 | 编辑时打固定版本号，重试原样重发 | b39b209 | `lostAcknowledgement`；core `recording local edits` |
| R02 | 撤销改为记录级逆操作，带前置检查 | b39b209 | `undoRemote`；core `undo` |
| R03 | 写入序号 + 三方合并；TUI 锁文件；网页 storage 事件合并 | b50b6d0 | `fileWriters`、`browserWriters`；tui `writers.test.ts`（3 进程竞争） |
| R04 | 新版本带全局唯一 ID；撞号确定性重新编号 | cf22b57 | `versionCollision`；core `integrity.test.ts` |
| R05 | 多设备并行任务与 Session，显示他端工作 | a59d678 | `concurrentActive`（按新语义重写）；core `parallel.test.ts` |
| R06 | 连接在副本上完成，成功后才合并 | b39b209 | `rollbackDuringConnect`；server `switch.test.ts` |
| R07 | 服务器同步日志 + 数据库代号，位置指纹校验 | b39b209 | `serverRollback`；server `history.test.ts`（整库恢复、恢复后有新写入） |
| R08 | 保存失败保留脏标记并重试；CLI 非零退出；TUI 报错 | cf22b57 | `flushRetry`、`cliSaveFailure` |
| R09 | 导入走 `parseImport` 拒绝；加载时修复重复 ID 保留两份 | cf22b57 | `duplicateImport`（加强）；core `integrity.test.ts` |
| R10 | 先建基线再改目标 | cf22b57 | `reviseBaseline` |
| R11 | 删除确认绑定具体记录 ID | b39b209 | `staleConfirmation`；server `guard.test.ts` |
| R12 | 排序值相同时按 ID 决定先后 | cf22b57 | `orderCollision` |
| R13 | pending 取自待发送队列；途中新编辑会再安排一轮 | b39b209 | `inflightPending` |
| R14 | 只缓存成功的 HTML；5xx 时回退到上次正常的页面 | cf22b57 | `poisonedShell`（加强） |

## 对审计场景的改动

只在接口变化或产品决定改变语义时修改，均在代码里注明原因：

- **R02**：`store.undo()` 现在返回 `{ label, undone, skipped }`，场景里的比较改为 `.label`。
- **R05**：按所有者决定的「多设备并行、不静默覆盖」语义重写判定标准（原标准「同步后只剩 1 个」正是被否定的静默覆盖）。
- **R09**：导入入口改为 `parseImport`；判定标准加强为「导入拒绝 **且** 加载时两份都保留」。
- **R14**：原前置断言要求 503 直接呈现给用户；修复后服务器出错时也显示上次正常的页面，并入判定标准。
- harness：`saveMeta` 改为 `updateMeta`（函数式更新，避免覆盖并发记录的编辑）。

## 顺带处理的潜在风险

- 网页在 `pagehide` / 页面隐藏时也写盘（iOS 后台被杀）。
- 本地数据损坏且备份失败时停用保存，不覆盖原数据，并如实提示。
- 服务器专注超时提醒覆盖所有设备上进行中的 Session。
