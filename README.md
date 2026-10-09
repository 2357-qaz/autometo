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

单栏、终端式，只突出两件事：

1. **当前任务**（顶部高亮块）——正在做什么、做完之后是什么，以及「完成并继续 / 专注 / 卡住了」。Goal 模式下是「下一步」。
2. **接下来的 Todo**——当前阶段的待办；后续阶段变暗显示，已完成项折叠成一行。

阶段管理、日志、Checkpoint 历史、目标详情都收在底部的折叠区里。Plan/Goal 列表用 `o`（或点标题）打开；HIE 档位、强度、预算和疲劳都在底部状态行。

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
  commands.ts   斜杠命令注册与解析
  components/   终端风格 UI
tests/          核心逻辑单测
```
