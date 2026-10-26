# Tomo：原生 SwiftUI 版 AuTomeDo

和 `apps/mobile`（Capacitor 包装网页版）并存的第二个 iOS App。界面用 SwiftUI 原生绘制，业务逻辑仍然只有一份 TypeScript：`@automedo/core` 打包后在 iOS 自带的 JavaScriptCore 里运行。同步合并、Fable、HIE 计费、周回顾、所有斜杠命令，都和网页版、终端版是同一份代码。

## 有什么

- **计划 / 目标**
  - 按阶段分组的任务；子任务缩进显示，并显示「x/y 步」。
  - 任务行操作：右滑完成，左滑延期或删除；长按有开始、阻塞、跳过、拆分、编辑、上移下移。
  - 每个阶段下可以直接添加任务，下拉即同步。
- **底部栏（和终端一样固定在下方）**：浮在内容上的分块，iOS 26 上是液态玻璃（更早的系统用磨砂材质）。
  - 专注 Session 卡片：进度环、计时、Token，底色随档位着色。
  - 上一条命令的结果，可以撤销；出错时是红色块。
  - 命令补全和胶囊输入框（直接输入是添加任务，`/` 开头是命令，`#` 开头是记录）。
  - 输入框下面三个胶囊：plan / goal；模型和推理强度（点开一起选）；「+」里是常用命令（把输入框里的命令存进去，只存在这台设备上）和疲劳、同步、预算。疲劳偏高或同步有问题时「+」上有个小圆点。
- **顶栏**：今天的 Token 用量是一个圆环，点开看用量、HIE 建议，改每日预算。
- **图标**：界面里的状态用 SF Symbols；日志、周回顾等终端文本里的 ⏸ ⏺ 这类符号按文字画、跟随行的颜色，不会变成彩色 emoji。
- **表单**：新建计划 / 目标、Session、结束 Session、拆分（Fable 强制拆分也在这里）、修正、Checkpoint、Compact、编辑任务、同步设置。这些都是终端版的表单定义，画成原生表单。
- **日志时间线、周回顾、帮助**：复用终端版的彩色文本行；周回顾可以翻周、分享 Markdown。
- **其他**：
  - 导出 / 导入备份，走系统的文件面板；
  - 小组件和实时活动 / 灵动岛，和 Capacitor 版是同一份代码；
  - 本地通知。

和 Capacitor 版相比，数据直接存在 App 自己的文件里（`Application Support/AuTomeDo/state.json`），不再有 WebView 存储被系统清理的问题。
- 文件内容坏了（不是 JSON、不是 UTF-8 文本）：原样另存到 `aside/`，再从空白开始。
- 文件在但读不出来（比如没有权限、设备还没解锁）：不会从空白开始，这次的修改也不保存，以免盖掉原文件；稍后重新打开 App 即可。

需要 iOS 17 或更高版本。显示名是「Tomo」，图标是梅子色底，和 Capacitor 版的 AuTomeDo 区分开。

## 安装（Windows + 免费 Apple ID）

步骤和 Capacitor 版一样（见 [`apps/mobile/README.md`](../mobile/README.md)），只是安装包不同：

GitHub → **Actions** → **iOS native** → 最新一次成功的运行 → 底部 Artifacts：
- `Tomo-ipa-编号`：安装包，用 Sideloadly 签名安装；
- `Tomo-screenshots-编号`：模拟器里的截图，可以先看看样子。

注意：
- 两个 App 同时装着的话，免费账号会占 4 个 App ID（每个 App 加它的小组件各占 1 个）；同时签名的 App 最多 3 个。
- 两个 App 的数据互不相通：用同一个同步服务器（`/sync`），或者导出再导入。

## 怎么构建

```bash
npm ci
npm test -w @automedo/native          # 打包 engine.js，并在没有 Web API 的 V8 沙箱里测试
cd apps/native/ios
brew install xcodegen && xcodegen generate
open AuTomeDoNative.xcodeproj         # 有 Mac 时：选 Team 后运行；或 Cmd+U 跑模拟器测试
```

截图用的演示模式：启动参数 `-AutomedoDemo -AutomedoScreen home|fable|split|timeline|review|switcher|command`。它会在临时目录里载入示例数据，不碰真实数据。

## 结构

| 位置 | 内容 |
|---|---|
| `src/host.ts` | JavaScriptCore 缺的 Web API（计时器、fetch、AbortController、structuredClone、queueMicrotask、console），建立在 Swift 提供的 `host` 函数上 |
| `src/engine.ts` | 给 Swift 用的 JSON 接口：view、execute、act、submitForm、pick、confirm、undo、suggest… |
| `src/view.ts` | 界面需要的全部数据，一次性给出 |
| `tests/engine.test.ts` | 在 Node 的空白 `vm` 沙箱里加载**打包后的** engine.js 测试（包括连真实服务器同步） |
| `ios/AuTomeDo/Engine.swift` | JavaScriptCore 跑在一个串行队列上；GCD 计时器、URLSession、原子写文件 |
| `ios/AuTomeDo/AppModel.swift` | 界面状态：动作发给引擎，返回的表单 / 选择 / 确认弹出来 |
| `ios/AuTomeDo/Views/` | SwiftUI 界面 |
| `ios/Tests/` | 模拟器里的 XCTest：真实的 Swift ↔ JS 桥接 |
| `ios/project.yml` | XcodeGen 工程；小组件代码引用 `../../mobile/ios/App/{Widget,Shared}` |
| `.github/workflows/native.yml` | 云端：引擎测试 → 模拟器测试 → 截图 → 未签名 IPA |
