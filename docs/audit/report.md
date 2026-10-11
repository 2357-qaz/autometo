# AuTomeDo V1 独立可靠性审计

**结论：在并发操作、响应丢失及回滚场景下，V1 存在已复现的数据丢失与一致性缺陷。现有测试通过不足以支持这些场景的可靠性保证。**

审计对象：[2357-qaz/autometo](https://github.com/2357-qaz/autometo)，基线 `d689f7209ede359ecd5639eee934fb18c4e64bd8`，2026-10-11。
独立分支 `audit/autometodo-v1-reliability`。仅新增审计资料、测试和运行脚本；没有修改生产实现、执行用户数据库迁移、触碰用户真实数据或合并主分支。

先行证据已先于回归测试提交，见 [initial-findings.md](initial-findings.md) 和 [原始复现输出](evidence/initial-reproduction.jsonl)。
完整模型见 [state-model.md](state-model.md)；阅读清单、验证层级与未覆盖项见 [coverage.md](coverage.md)。

## 已验证缺陷

P1：可能丢失已保存/已确认内容、错误删除或导致静默数据分叉，建议在扩大多端使用前处理。
P2：领域不变量、历史证据、操作顺序、状态提示或离线可用性受损。优先级是本次审计判断，不是已发生线上事故的证明。

| 编号 | 优先级 | 问题 | 复现入口 |
|---|---|---|---|
| R01 | P1 | 丢失响应后的重试覆盖后来已确认修改 | `lostAcknowledgement` |
| R02 | P1 | 整状态撤销把远端新数据同步删除 | `undoRemote` |
| R03 | P1 | TUI 多进程与 Web 多窗口互相覆盖 | `fileWriters` / `browserWriters` |
| R04 | P1 | 并发版本编号碰撞，丢失计划快照 | `versionCollision` |
| R05 | P2 | 同步后出现多个 active 任务和 Session | `concurrentActive` |
| R06 | P1 | 连接失败回滚抹掉期间已保存编辑 | `rollbackDuringConnect` |
| R07 | P1 | 服务端同地址回滚后静默分叉 | `serverRollback` |
| R08 | P1 | 保存失败后不重试，TUI 仍报告成功 | `flushRetry` / `cliSaveFailure` |
| R09 | P1 | 接受重复 ID 导入，记录拆分时丢数据 | `duplicateImport` |
| R10 | P2 | 首次 revise 的基线已经包含修改 | `reviseBaseline` |
| R11 | P1 | 删除确认未绑定具体记录，可授权另一组删除 | `staleConfirmation` |
| R12 | P2 | 并发追加后任务顺序经多轮同步仍不一致 | `orderCollision` |
| R13 | P2 | 未上传修改被显示为 pending=0 / 已同步 | `inflightPending` |
| R14 | P2 | HTTP 503 污染 PWA 离线入口缓存 | `poisonedShell` |

复现入口均在 [scenarios.ts](../../audit/scenarios.ts) 或 [io-scenarios.ts](../../audit/io-scenarios.ts)。
统一运行 `npm run audit:reproduce`；每个场景输出 actual / expected / reproduced，使用同一份未经修改的业务实现。

### R01：丢响应重试改变同一操作的因果顺序

**步骤：** A/B 先同步；A 改任务为 `A stale retry`；放行请求到真实 HTTP 服务，在 SQLite COMMIT 后丢弃响应；B 拉取该修改，再改为 `B acknowledged` 并同步成功；A 重试，B 再同步。

**实际：** B 已确认的新内容被回写成 `A stale retry`。不是通常的“同时离线编辑选一个赢家”：B 明确见过 A 的第一次提交，其编辑发生在 A 原操作之后。

**原因/定位：** [sync.ts:271](../../packages/core/src/sync.ts#L271) prepareSync 每次按当前时间重新生成 rev；[sync-client.ts:292](../../packages/core/src/sync-client.ts#L292) 重试重新 prepare；[db.ts:108](../../packages/server/src/db.ts#L108) 按新 rev 接受同一旧内容。没有持久化待确认请求 / 稳定操作 revision。

**建议：** 保存含稳定 rev 的 outbox，请求丢失后幂等重放；同记录新本地编辑另建操作。修复验证须同时覆盖“请求未提交”和“已提交但未应答”。

### R02：撤销范围越过了本地原操作

**步骤：** A 重命名工作区并同步；B 新建任务、同步；A 拉取，确认该任务存在；A 撤销刚才的重命名，再双向同步。

**实际：** B 新任务从 A 消失，随后从 B/服务器 live 数据中消失，未触发批量删除 guard。

**原因/定位：** [store.ts:73](../../packages/core/src/store.ts#L73) undo 替换完整旧 AppState；[sync-client.ts:310](../../packages/core/src/sync-client.ts#L310) 远端合并不重定基 undo；[sync.ts:285](../../packages/core/src/sync.ts#L285) 把旧快照缺失项解释为用户删除。影响包括新任务、日志、Session 等，并不限于重命名字段。

**建议：** 使用带前置条件的操作级 inverse，或在远端合并后使不安全的历史撤销失效；不能把远端新增项当作本地删除意图。

### R03：原子替换文件不等于并发安全

**步骤：** 两个真实子进程通过 TUI `loadState/createStore/filePersist` 同时读同一临时 state.json；IPC 屏障保证都加载后，A 添加并 flush，再 B 添加并 flush。Web 用两个隔离 JS 上下文加载真实 BrowserStore，共享一个 localStorage Map，按相同顺序操作。

**实际：** 两次添加均成功，最终文档只含 `from B` 和原任务，`from A` 丢失。Web 测试验证的是真实适配器逻辑，浏览器存储 API 为测试替身，未宣称实际 Safari 多窗口 E2E。

**原因/定位：** [storage.ts:20](../../apps/tui/src/storage.ts#L20) rename 是整快照最后写入胜出，无锁/CAS；[cli.tsx:67](../../apps/tui/src/cli.tsx#L67) 子命令先 load 再执行；[storage.ts:83](../../apps/tui/src/storage.ts#L83) watcher 是事后 reload，不能保护并发读改写；[web/store.ts:50](../../apps/web/src/store.ts#L50) 无多窗口协调。

**建议：** TUI 对完整读改写和 meta 提交加跨进程锁/CAS；Web 使用单写者协议/Web Locks 并处理外部版本变化。仅补 storage 监听器仍不能解决同时编辑。

### R04：两个不同快照共用一个同步键

**步骤：** A/B 同步到无版本的相同计划后，各自 `/commit`，分别写 `snapshot A`、`snapshot B`，再双向同步。

**实际：** 两条 commit 日志都存在，但只剩一个计划版本 `snapshot B`，另一个快照消失。

**原因/定位：** [ops.ts:151](../../packages/core/src/ops.ts#L151) 编号由本地递增；[sync.ts:144](../../packages/core/src/sync.ts#L144) 版本键为 `ver:<planId>:<v>`。LWW 把两个独立历史快照误认为同一记录的更新。

**建议：** 为版本提供全局唯一身份，显示编号与存储键分离；迁移必须保留历史版本与日志引用。

### R05：跨记录合并破坏单 active 不变量

**步骤：** 两个设备从同一状态分别激活不同任务、开始各自 Session，然后同步。

**实际：** 同一计划有 2 个 active 任务，全局有 2 个未结束 Session。`activeSession` 只返回第一个，计费/投入函数遍历全部，因此界面选中的 Session 与累计投入可能不一致。

**原因/定位：** [ops.ts:383](../../packages/core/src/ops.ts#L383)、[ops.ts:645](../../packages/core/src/ops.ts#L645) 只检查本地状态；[sync.ts:171](../../packages/core/src/sync.ts#L171) compose 无领域协调；[hie.ts:54](../../packages/core/src/hie.ts#L54) 单项选择。

**建议：** 明确跨设备同时工作的语义；实现确定性的冲突解决或保留冲突并提示用户，不静默关闭而丢失有效时间段。

### R06：连接失败回滚吞掉用户期间编辑

**步骤：** 新连接第一次 pull 成功；第二个请求阻塞；此时通过 Store 添加 `must survive rollback` 并 flush，确认磁盘已含该任务；释放请求并返回 500。

**实际：** connect 回滚后该任务同时从内存和本地文档消失。

**原因/定位：** [sync-client.ts:161](../../packages/core/src/sync-client.ts#L161) await 前捕获 prevState；[sync-client.ts:182](../../packages/core/src/sync-client.ts#L182) 失败时无条件恢复完整快照；[sync-client.ts:187](../../packages/core/src/sync-client.ts#L187) 将回滚状态持久化。测试通过 Promise 屏障直接触发共享 Store，在 UI 关闭弹窗后继续编辑、快速记录等交错中同样存在该层面的窗口。

**建议：** 暂存连接事务的远端结果，失败只撤销自身引入的变更，或跟踪并保留期间本地变更。单纯恢复旧对象不满足并发回滚语义。

### R07：服务端历史回退无法被识别

**步骤：** 保存临时 SQLite 的旧行快照；A 修改任务并得到成功；在同一 loopback URL 恢复旧快照；A 同步两次，再让全新 B 首次同步。

**实际：** A 显示新标题，B 显示旧标题，A 为 `idle`。A 的 base 仍认为新内容已在服务端，因此不会补传；服务端按旧 cursor 过滤也不能送回历史。

**原因/定位：** [sync.ts:72](../../packages/core/src/sync.ts#L72) SyncMeta 只有 URL/cursor/base；[db.ts:117](../../packages/server/src/db.ts#L117) `seq > cursor`；[sync-client.ts:270](../../packages/core/src/sync-client.ts#L270) 只检测 URL 变化。

**建议：** 协议增加数据库 epoch / restore generation；检测 cursor 回退并进入可审查的重同步/冲突恢复。测试示例把保留最新已确认数据作为修复目标；若产品选择显式冲突提示，需把此测试改成验证该恢复协议，不能继续静默 idle。

### R08：保存失败后失去重试机会，CLI 未报告失败

**步骤一：** 注入首次 DocIO 保存 ENOSPC，之后存储恢复，调用 flush。
**实际一：** 总写入次数仍为 1，磁盘仍旧数据；saveTimer 在异常之前已被清除。

**步骤二：** 在隔离目录运行真实 `cli.tsx add`，通过预加载仅对该目录的 state 临时文件写入注入 ENOSPC。
**实际二：** exit 0、stdout 展示新增任务、stderr 空；磁盘没有该任务。

**定位：** [store.ts:34](../../packages/core/src/store.ts#L34)、[store.ts:85](../../packages/core/src/store.ts#L85)、[cli.tsx:51](../../apps/tui/src/cli.tsx#L51)。交互 TUI [ui.tsx](../../apps/tui/src/ui.tsx) 同样没有消费 saveError；Web 有错误提示。

**建议：** 独立 dirty 标记直到成功写入才清除；flush 可重试并提供结果；CLI 保存失败返回非零并提示导出/重试，交互 TUI 显示持久化错误。

### R09：导入成功不代表实体可以安全拆分

**步骤：** 使用合法外层 AppState，但同计划两条不同内容任务共用 ID；normalize 导入，再 decompose / compose。

**实际：** 导入被接受，任务从 2 条变 1 条。其余导入内容可以仍正常，难以从 UI 发现具体哪条丢失。

**定位：** [state.ts:28](../../packages/core/src/state.ts#L28) 未检查子实体身份唯一性；[sync.ts:137](../../packages/core/src/sync.ts#L137) Map.set 以记录 ID 静默覆盖。适用于手工修改/外部生成/合并的备份；未证明当前正常创建路径会稳定产生重复随机 ID。

**建议：** 在覆盖导入前验证所有实体 ID、类型、引用、合法状态和有限数值；遇到冲突明确拒绝或提供保留两份的修复流程。

### R10：修正前基线的写入顺序错误

**步骤：** 一个还没有版本、阶段目标为 `original goal` 的计划第一次 revise 为 `changed goal`。

**实际：** v1“基准（修正前）”和 v2 都是 `changed goal`，不能通过基线还原修正前计划；日志仍记有旧文本，所以不是旧字符串完全不可恢复。

**定位：** [ops.ts:234](../../packages/core/src/ops.ts#L234) 先 `ph.goal = g` 后 pushVersion。
**建议：** 在写新目标前创建基线，补验证基线内容而非仅版本数量。

### R11：删除确认绑定数量，不绑定用户见到的集合

**步骤：** 服务端有 P/q/r；客户端删 P/q 触发 guard，用户看到 P/q；在下一次后台同步前撤销并改删 q/r；调用 confirmDeletes。

**实际：** q/r 被直接删除，服务端只剩 P，原确认没有覆盖 r 的身份。测试中第二组删除记录数量更少，仍被旧数量阈值允许。

**定位：** [sync-client.ts:204](../../packages/core/src/sync-client.ts#L204) 捕获旧 `g.deletes` 后重新 prepare 当前集合；[db.ts:88](../../packages/server/src/db.ts#L88) 只比较数量。此场景通过真实客户端和 HTTP 复现，不依赖伪造请求。

**建议：** guard 返回待删除 ID 集合的摘要和版本/有效范围；客户端操作改变集合后使确认失效；服务端验证集合，而非只验证数量。

### R12：排序冲突没有确定性破局规则

**步骤：** A/B 离线分别在同一任务列表末尾追加；按 A→B→A 同步，再重复四轮 B→A 同步。

**实际：** A 顺序为 original/A/B，B 为 original/B/A。额外轮次后仍不一致，跨端编号不同。

**定位：** [sync.ts:143](../../packages/core/src/sync.ts#L143) 本地数组下标 `_o`；[sync.ts:163](../../packages/core/src/sync.ts#L163) 排序只有数值比较；compose 后重新 decompose 会把本地顺序重新编码。测试证明该固定交错四轮不收敛，并不声称穷举所有排序交错。

**建议：** 相同排序值使用稳定全局 ID 破局，避免把合并副产物误认为用户重排；必要时使用稳定排序位置标识。

### R13：成功响应后的状态未反映仍待上传的修改

**步骤：** 同步请求已准备，响应返回前新增任务；让当前同步成功结束。

**实际：** prepareSync 仍能找到 2 条变更（任务和日志），SyncStatus 却是 idle/pending=0，Web 显示“已同步”。内容暂存在本地，正常后台下一轮可上传；这里验证的是错误确认提示，不宣称必然丢失。

**定位：** [sync-client.ts:301](../../packages/core/src/sync-client.ts#L301) 无条件设置 pending=0；[Bottom.tsx:271](../../apps/web/src/components/Bottom.tsx#L271) idle 映射已同步。
**建议：** 成功后比较当前状态与刚确认的 base，重算 pending 并安排补传。

### R14：错误页覆盖离线 shell

**步骤：** 执行真实 sw-template 的 fetch handler，cache 中先有正常 HTML；导航 fetch 返回 HTTP 503；随后网络抛错，再次导航。

**实际：** 离线回退返回 503 `temporary outage`，正常 shell 已被替换。未修改 localStorage 业务数据，但用户离线无法进入应用访问它们。

**定位：** [sw-template.js:27](../../apps/web/sw-template.js#L27) 导航分支缓存所有已完成响应，没有检查 `res.ok` / HTML 类型。
**建议：** 只替换成功且适用的 shell；5xx 优先回退已知好缓存，并用 waitUntil 管理缓存写入生命周期。测试为 Node VM 中运行实际 worker 源码，非真实 Safari 离线 E2E。

## 正向验证与测试解释

新增测试执行真正的 Core、SyncClient、HTTP handler、SQLite 及 TUI 适配器。不是复制一个模拟同步算法来证明自身正确。
固定时钟/ID、IPC 与 Promise 屏障确定交错；没有靠 sleep 撞竞态。超时仅用于测试异常时及时失败。
失败注入包括：提交前断网、提交后丢响应、500、ENOSPC、事务中途 SQL abort、文件 rename 和 SQLite COMMIT 前后 SIGKILL、503→离线。

- 基线测试：66 项通过。
- 新增 `npm run audit:test`：13 项通过，16 项 expected fail，共 29 项。
- `npm run audit:strict`：同一断言按普通测试运行，16 项失败、13 项通过，退出码 1。这是未修复缺陷的预期结果。
- 各 workspace 和 audit 独立类型检查通过；Web 与 TUI 构建通过。Vite 仅提示未来 native config loader 兼容性警告，与本次缺陷无关。

`it.fails` 仅包围最终正确性断言；场景初始化与注入前置条件在 beforeAll 中执行，初始化出错不会算作已知缺陷成功复现。
缺陷修复后 expected-fail 测试会因“意外通过”报错，应审查后改为普通测试。**expected fail 不代表问题已修复。**

通过的故障控制：单文档提交在进程崩溃时保持 state/meta 成对；SQLite 事务错误无部分写入；mass-delete 拒绝整批无写入；坏令牌不改本地数据；guard 后从服务器恢复成功；请求未提交时重试幂等；新建记录在飞行中删除仍能补发 tombstone。

## 潜在风险（未作为新增已验证缺陷计数）

1. **断电耐久性：** TUI temp/rename 没有文件/目录 fsync；SQLite 为 WAL + synchronous=NORMAL。SIGKILL 测试未模拟内核 page cache 丢失、掉电、存储控制器行为，不能据此保证所有已确认写入抗断电。
2. **重试活性：** callSync/checkServer 无应用级超时、AbortSignal、指数退避；connect 等待 running。控制测试证明一个未完成 fetch 会阻塞排队同步，尚未测各浏览器/代理真实超时和恢复时限。
3. **离线编辑时序：** 普通记录的 rev 在准备同步时生成，不是用户编辑时生成；同记录不同字段也会整记录 LWW。时钟偏移/长离线设备覆盖较新内容是现行策略的风险，未将所有 LWW 丢更新都算 bug。
4. **未保存窗口与移动生命周期：** Web 150ms debounce，仅 beforeunload flush，hidden/pagehide 没有持久化钩子。控制测试证明未 flush 时只剩旧磁盘快照，真实 iOS 后台终止/浏览器逐出未测。`?add` 会先清 URL 参数，重启未必能重放请求。
5. **坏数据恢复：** normalize 深层校验较弱；HTTP validateSync 也不检查 data 的业务 schema、record id 与 data.id 一致性、重复 request IDs。R09 仅验证重复任务 ID；其他形状的跨端崩溃/污染未穷举。
6. **失败备份提示：** Web loadFromStorage 的 corrupt 备份失败被 catch 忽略，仍声称已备份；之后继续使用空状态可能覆盖原 document。尚未用真实配额满或存储拒绝的浏览器验证该链路。
7. **历史保留与恢复边界：** 日志 2000/工作区、Compact 20/工作区、markFatigue 1000 的裁剪最终传播；服务端 tombstone 不保存旧 payload。日志“只增不改”的文档说法不等于无限历史保留，删除/裁剪后的恢复依赖外部备份。
8. **连接切换的部分提交：** connect 不是跨服务端与客户端的分布式事务；目标服务端提交后的应答失败、回滚期间第二次 IO 失败、并发 connect/disconnect 尚未组合穷举。
9. **孤儿与延迟表单：** compose 丢弃无 workspace 的子记录；远端删除父对象时的本地新增内容可能不再出现在 UI。编辑弹窗提交旧字段还可能覆盖同期远端修改；需明确冲突提示与恢复要求。

## 未覆盖场景

真实 iPhone Safari/PWA 多标签、触摸取消、系统强杀、存储逐出、通知到达；真实推送服务；掉电/磁盘损坏/文件系统或 SQLite 硬件 IO 错误；大数据集、20MB 边界和性能；随机长序列模型检查、所有操作组合；生产反向代理/CORS/HTTPS 和部署回滚；真实数据备份恢复演练。
测试 OS 为 Linux、Node 24；CI/Docker 的 Node 22 未执行。本审计是可靠性审计，不是安全渗透或网络暴露审计。

## 后续建议

优先修复稳定重试身份、撤销/连接回滚的数据范围、跨进程多写入者保护、删除授权身份，以及保存失败反馈。随后处理版本身份、服务端 epoch 和输入一致性校验，再处理领域不变量、稳定排序、状态提示和 PWA 缓存。
修复应逐项进入独立变更、保持可检查的旧数据备份和迁移策略；本分支保留审计证据与失败测试，未自行实施上述业务改造。
