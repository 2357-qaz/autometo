# 审计范围、覆盖矩阵与复跑

## 阅读范围

逐文件完整阅读 49 个运行时代码文件、7867 行。每个文件的路径、行数和 SHA-256 见 [source-manifest.csv](evidence/source-manifest.csv)。
清单表示静态阅读覆盖，**不表示每行都经过动态测试**。

| 组件 | 文件 / 行数 | 阅读与追踪内容 |
|---|---|---|
| Core | 16 / 2779 | 所有 types/state/ops/commands/store/persistence/sync/sync-client；diff、compact、HIE、reminders、demo、util、intents、exports |
| Server | 4 / 490 | HTTP 校验与响应、SQLite 事务/guard/seq/LWW、进程启动/退出、推送记录与重试 |
| TUI | 8 / 1726 | CLI 子命令、交互 UI、表单提交、文件适配器/监听器、格式化和输入编辑 |
| Web/PWA | 21 / 2872 | 全部 TS/TSX 组件、入口/Store/同步/快速记录/推送、Service Worker 与构建插件 |

另读 README、V1 技术方案、server README、现有全部 11 个测试文件、package/tsconfig、CI/Pages workflow、Dockerfile、Web/TUI build 配置、manifest/index、样式与图标生成脚本。二进制图标未作为数据可靠性分析对象。
新增审计代码不计入该基线阅读统计；生产源码 SHA-256 未改变。

## 动态覆盖矩阵

| 主题 | 已执行 | 结论 / 边界 |
|---|---|---|
| 跨端增量同步 | 真实 SyncClient + loopback HTTP + SQLite | 现有正常用例通过；R01/R02/R04/R05/R07/R12/R13 失败 |
| 同步中断 | 请求未送达、提交后响应丢失、500、Promise 阻塞 | 提交前重试通过；提交后重试有 R01；应用级超时未实现 |
| 并发修改 | 固定 A/B 顺序、飞行中编辑、IPC 控制的双文件进程、两个 WebStore JS 上下文 | R03 等可确定性复现；未做全空间随机 interleaving 穷举 |
| 批量删除 | 实际 409 guard、无部分更新、restore、旧确认换集合 | 原子拒绝/restore 通过；R11 失败 |
| 撤销 / 回滚 | 本地 undo 后同步、连接过程期间编辑再返回500、同 URL恢复旧SQLite行快照 | R02/R06/R07 失败 |
| 崩溃恢复 | 真实进程 SIGKILL：rename 前/后、COMMIT 前/后 | 4 项通过；不是系统断电或文件系统损坏测试 |
| 持久化故障 | DocIO ENOSPC、真实 CLI fs.writeFileSync ENOSPC、SQL trigger abort | 旧原子快照/事务保持完整；R08 重试/反馈失败 |
| 数据校验 / 历史 | 重复 task ID 导入、并发 commit、首次 revise 基线内容 | R09/R04/R10 失败 |
| Web 多窗口 | esbuild 打包未修改 BrowserStore，在两个 Node VM 上下文共享 storage Map | R03W；不是完整浏览器的 StorageEvent/E2E 行为测试 |
| PWA 离线 | VM 执行原 sw-template fetch handler；缓存替身注入 503→断网 | R14；未模拟浏览器 Service Worker 终止/升级调度 |
| 推送 | 既有服务端 sender stub、加密载荷和退避测试 | 未发送真实通知、未连接 Apple/Google 推送服务 |
| 编译 / 构建 | Core/Server/TUI/Web 类型检查、audit 类型检查、Web/TUI build | 全部通过；使用 Node 24.19.0，未执行 Node 22 |

## 复跑方式

在独立 checkout、Node 24.19.0 中：

```sh
npm ci
npm test
npm run audit:reproduce
npm run audit:test
npm run audit:strict
npm run audit:typecheck
npm run typecheck
npm run build
npm run build -w @automedo/tui
```

- `audit:reproduce` 输出 16 个诊断 JSON；退出 0 仅表示复现脚本执行完成，应查看 `reproduced`。
- `audit:test` 是已知缺陷跟踪模式：13 个正向控制通过，16 个正确行为断言 expected fail。
- `audit:strict` 是修复验收模式：当前 **exit 1 / 16 failed**，不应拿来声称产品已通过可靠性验收。
- 原有 `npm test` 命令和 CI workflow 保持原样，审计测试单独运行，便于后续修复时逐项转为正式回归门禁。
- 原始日志：[基线 66 项](evidence/baseline-tests.txt)、[审计结果](evidence/audit-tests.txt)、[严格失败明细](evidence/strict-tests.txt)。

## 隔离与故障注入实现

`audit/harness.ts` 只创建新 loopback HTTP 服务和内存 SQLite。网络请求由测试传入地址，不读取用户 sync.json 或生产服务器配置。
文件/CLI/崩溃测试通过 mkdtemp 创建目录，显式传入 AUTOMEDO_HOME。ENOSPC 预加载只匹配该目录的 state 临时文件。
清理仅删除测试自己创建的临时目录，SIGKILL 仅用于测试自己启动并已报告检查点的进程。
时钟与随机 ID 在回归 setup 中固定；IPC/Promise 屏障定义顺序，计时器只作为错误超时兜底。每个场景单独数据库，finally 关闭连接/清理写定时器和子进程。

## 未覆盖的完整清单

- iOS Safari、安装后的 PWA、真实跨标签事件、触摸与 pointercancel、输入法 composition、系统挂起/终止/存储逐出。
- Service Worker 新旧资源混用、cache eviction、后台异步 cache.put 终止、跨部署回滚的真实生命周期。
- 真实 HTTP 代理、DNS/TLS、长时间半开连接、限流、多个服务端实例争用数据库。
- 物理掉电、内核崩溃、磁盘损坏、磁盘满的真实文件系统行为、目录 fsync、SQLite IOERR/恢复旧 WAL 的所有组合。
- 多用户、恶意客户端及鉴权边界的安全审计；本项目文档定位单用户，本次关注可靠性。
- 20MB / 100000 changes 上限、大记录量 O(n) 拆分/哈希/排序、内存与响应延迟、持久化配额。
- 所有版本/旧数据迁移组合、每种深层坏数据形状、正常随机 ID 的实际碰撞概率、时钟跳变与多时区。
- 操作序列的完整模型检查；本次模型为代码推导、动态检查为列出的确定性交错，非形式化证明。
- 真实生产数据恢复、真实推送以及 Node 22/macOS/Windows；测试不涉及用户真实数据。
