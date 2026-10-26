# AuTomeDo iOS App

网页版装进一个原生 iOS 外壳（[Capacitor](https://capacitorjs.com)）里，界面和逻辑与网页版、终端版完全相同。另外加了这些 PWA 做不到的能力：

- **实时活动 / 灵动岛**：专注 Session 进行时，锁屏和灵动岛显示：
  - 计时，以及计划时长进度条（这两项自己走，不需要打开 App）；
  - 档位、Fable 并行路数、当前速率和已用 tokens（App 打开时每分钟刷新）。
- **桌面 / 锁屏小组件**：当前任务、还剩几步、并行中的子任务、下一个任务、今日预算。午夜自动归零。
- **本地通知**：专注到点、Checkpoint 到期、阶段逾期（第二天早上 9 点）。不需要服务器。
- **数据备份**：数据同时存一份到 App 自己的文件里。如果 iOS 清理了网页存储，下次打开会自动恢复。

需要 iOS 17 或更高版本。

## 安装（Windows + 免费 Apple ID）

没有 Mac 也能装：GitHub Actions 在云端的 Mac 上编译出 `.ipa`，你在 Windows 上用 Sideloadly 签名后装到 iPhone。

### 1. 下载安装包

GitHub 仓库 → **Actions** → 左侧选 **iOS** → 打开最新一次成功的运行 → 页面底部 **Artifacts** 里下载 `AuTomeDo-ipa-编号`，解压得到 `AuTomeDo.ipa`。

- 只改了 `apps/mobile/` 时会自动构建。
- 改了网页版或 core 之后，要在 **Actions → iOS → Run workflow** 手动构建一次（macOS 构建消耗的免费额度比较多，所以不自动跑）。

### 2. 准备 Windows

1. 安装 [Sideloadly](https://sideloadly.io/)。
2. 安装**官网版本**的 iTunes 和 iCloud（Sideloadly 页面上有链接）。如果装的是微软商店版，要先卸载。
3. 用数据线连接 iPhone，在手机上点「信任此电脑」。

### 3. 签名安装

1. 把 `AuTomeDo.ipa` 拖进 Sideloadly，填你的 Apple ID，点 **Start**。
   - **不要**勾选移除扩展（Remove app extensions），小组件和实时活动都在扩展里。
2. iPhone 上第一次打开前：
   - **设置 → 隐私与安全性 → 开发者模式**：打开，手机会重启。这个选项要在装过一次后才会出现。
   - **设置 → 通用 → VPN 与设备管理**：在你的 Apple ID 下点「信任」。

### 4. 第一次打开

- App 是一台新「设备」，数据和 Safari 里的 PWA 不互通。要共享数据，用 `/sync` 连接你的同步服务器；或者在 PWA 里 `/export`，再到 App 里 `/import`。
- 第一次有提醒要安排时（比如开始一个 Session），会弹出通知权限，选「允许」。
- 实时活动默认开启。也可以在 **设置 → AuTomeDo → 实时活动** 里开关。
- 小组件：长按桌面 → 左上角「+」→ 搜索 AuTomeDo。有小、中两种尺寸，锁屏小组件里也有一种。

### 5. 每 7 天续签

免费 Apple ID 签名的 App 7 天后会打不开，数据不会丢。两种办法：

- 重新用 Sideloadly 装一次，App 里的数据会保留；
- 打开 Sideloadly 的自动续签（Auto-refresh）。电脑开着并且和手机在同一个 Wi-Fi 下时，它会自动重签。

免费账号同时最多只能有 3 个签名的 App。AuTomeDo 本体加小组件扩展占 2 个 App ID（每 7 天最多注册 10 个）。

## 常见问题

**小组件一直显示「打开一次 App 后显示」**

先打开一次 App。如果还是这样，说明 App 和小组件没拿到同一个 App Group。原因是免费账号签名时，App Group 会被改名：

- AltStore / SideStore 会把新名字写进 App，自动就能对上；
- Sideloadly 不写，App 会改从签名文件里读。

小组件下方的小字显示它实际用的 App Group 名字。如果显示的还是 `group.app.automedo.ios`，说明签名时没有拿到 App Group。可以改用 [AltStore](https://altstore.io) 安装试试。

**签名时报错 0xe8008024**

有报告说，部分免费 Apple ID 最近会被拒绝签名，几种工具都是同样的错误。可以换一个 Apple ID，或者改用付费开发者账号。

**能连上同步服务器吗？**

能。App 允许 http，局域网里的自建服务器也可以连。服务器的 CORS 本来就允许任意来源（用 Token 鉴权）。

## 有 Mac 的话

```bash
npm ci
npm run build -w @automedo/web
cd apps/mobile && npx cap sync ios
brew install xcodegen && (cd ios/App && xcodegen generate)
open ios/App/App.xcodeproj
```

在 Xcode 里给 App 和 AutomedoWidget 两个 target 选你的 Team，就可以直接装到手机或在模拟器里运行。`App.xcodeproj` 由 `ios/App/project.yml` 生成，不提交到仓库，改工程设置请改 `project.yml`。

## 代码在哪

| 位置 | 内容 |
|---|---|
| `apps/web/src/native.ts` | 网页这边的原生桥接：存储备份、小组件数据、实时活动、本地通知（只在 App 里加载） |
| `packages/core/src/glance.ts` | 小组件和实时活动用的快照 `glance()` |
| `packages/core/src/reminders.ts` | `reminderSchedule()`：未来的提醒；文案和服务器推送共用 |
| `ios/App/App/` | App 本体：Capacitor 外壳、原生插件 `AutomedoNativePlugin`、实时活动控制 |
| `ios/App/Widget/` | 小组件和实时活动的界面（SwiftUI） |
| `ios/App/Shared/` | 两边共用：快照模型、App Group 识别、实时活动属性、配色 |
| `scripts/assets.mjs` | 用 Tomo 的像素画生成 App 图标和启动图 |
| `.github/workflows/ios.yml` | 云端构建未签名 `.ipa` |
