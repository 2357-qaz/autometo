# AuTomeDo V1：先行复现证据

审计基线：`d689f7209ede359ecd5639eee934fb18c4e64bd8`；独立分支：`audit/autometodo-v1-reliability`。
本文件及原始输出在编写回归测试之前生成。业务代码未修改，现有 66 项测试通过。
环境：Node 24.19.0 / npm 11.9.0 / Linux；时间和核心实体 ID 由复现驱动固定。
真实 HTTP 仅访问临时 loopback 服务，SQLite 使用内存库；文件测试仅使用新建临时目录。

执行：`node --import tsx audit/reproduce.ts`。
原始结果：[initial-reproduction.jsonl](evidence/initial-reproduction.jsonl)。
复现脚本：[scenarios.ts](../../audit/scenarios.ts)、[io-scenarios.ts](../../audit/io-scenarios.ts)。

| 编号 | 已复现的问题 | 实际证据 |
|---|---|---|
| R01 | 服务端提交后响应丢失，重试覆盖另一端之后确认的修改 | `B acknowledged` 被 `A stale retry` 覆盖 |
| R02 | 撤销本地操作删除随后同步来的数据 | 撤销重命名后，另一端新任务消失并传播；没有删除确认 |
| R03 | TUI 多进程 / Web 多页面整文档覆盖 | 两个写入者均成功添加，最终只保留 `from B` 和原任务 |
| R04 | 并发提交相同版本号导致快照丢失 | 两条 commit 日志，但只剩 `snapshot B` 一个版本 |
| R05 | 跨端合并不保持单 active 不变量 | 合并后 2 个 active 任务和 2 个未结束 Session |
| R06 | 连接失败回滚覆盖连接期间的新修改 | 已 flush 的 `must survive rollback` 从内存和磁盘消失 |
| R07 | 同地址服务端恢复旧备份后静默分叉 | A 保留新标题，B 读到旧标题，A 状态仍为 `idle` |
| R08 | 写入失败后 flush 不重试，CLI 仍以成功退出 | 写调用仅 1 次；真实 CLI 注入 ENOSPC 后 exit 0、无错误提示、任务未保存 |
| R09 | 导入接受重复实体 ID，同步时静默折叠 | normalize 成功；2 条不同内容任务经过拆分重组只剩 1 条 |
| R10 | 首次 revise 的“修正前”基线已含修改 | v1、v2 的目标都变成 `changed goal` |
| R11 | 删除授权只绑定数量，能确认另一组删除 | 提示删除 P/q 后改删 q/r，旧确认直接删除 q/r |
| R12 | 并发追加的相同排序值引起持续顺序不一致 | 额外 4 轮双向同步后，A 为 A/B，B 为 B/A |
| R13 | 飞行中修改未确认却显示 pending=0 | 实际仍有 2 条待上传，状态为 idle / pending=0 |
| R14 | PWA 将 HTTP 503 缓存为离线入口 | 随后断网，返回 503 `temporary outage` 而非原有正常 shell |

这些是已验证行为，不表示已经修复。回归测试将以正确行为为断言，显式标记已知失败，并提供严格失败模式。
风险解释、源码定位、状态模型、未覆盖场景和修复建议在最终报告补齐。
