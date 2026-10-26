import SwiftUI

/// Pinned to the bottom, like the terminal, as floating glass blocks: what is running and
/// the last answer, command suggestions, the prompt, and the status chips.
struct BottomBar: View {
    @EnvironmentObject private var model: AppModel
    @FocusState private var focused: Bool

    private var showSuggestions: Bool { (focused || model.input.hasPrefix("/")) && !model.suggestions.isEmpty }

    var body: some View {
        GlassGroup(spacing: 10) {
            VStack(alignment: .leading, spacing: 8) {
                if let s = model.view?.session { SessionCard(session: s) }
                if let others = model.view?.otherSessions, !others.isEmpty { OtherSessionsCard(others: others) }
                if let out = model.output { OutputCard(output: out) }
                if showSuggestions { suggestions.transition(.opacity.combined(with: .move(edge: .bottom))) }
                prompt
                StatusChips()
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 2)
        }
        .animation(.snappy(duration: 0.25), value: showSuggestions)
        .animation(.snappy(duration: 0.25), value: model.input.isEmpty)
        .animation(.snappy(duration: 0.25), value: model.output?.text)
        .onChange(of: model.promptFocus) { _, _ in focused = true }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.suggestions.prefix(6).enumerated()), id: \.element.id) { i, s in
                if i > 0 { Divider().overlay(Theme.faint.opacity(0.4)) }
                Button {
                    if s.needsArg {
                        model.input = "/\(s.name) "
                    } else {
                        model.input = ""
                        Task { await model.run("/\(s.name)") }
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("/\(s.name)").foregroundStyle(Theme.accent).fontWeight(.semibold)
                        if !s.args.isEmpty { Text(s.args).foregroundStyle(Theme.faint) }
                        Text(s.desc.textGlyphs).foregroundStyle(Theme.fg2).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .font(Theme.mono(12))
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .glass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var prompt: some View {
        HStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(focused ? Theme.accent : Theme.dim)
                TextField(placeholder, text: $model.input)
                    .font(Theme.mono(15))
                    .foregroundStyle(Theme.fg)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit(send)
                    .onChange(of: model.input) { _, now in Task { await model.suggest(now) } }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .contentShape(Capsule())
            .onTapGesture { focused = true }
            .glass(in: Capsule(), interactive: true)

            if !model.input.isEmpty {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glass(in: Circle(), tint: Theme.accent, interactive: true)
                .transition(.scale.combined(with: .opacity))
            }
        }
    }

    private var placeholder: String {
        if model.view?.ws == nil { return "输入计划标题，或 /help" }
        return model.view?.mode == "goal" ? "添加行动  / 命令  # 记录" : "添加任务  / 命令  # 记录"
    }

    private func send() {
        let text = model.input
        model.input = ""
        Task { await model.run(text) }
    }
}

/// The running focus session: its own block, tinted with the model's colour.
private struct SessionCard: View {
    let session: ViewModel.Session
    @EnvironmentObject private var model: AppModel
    private static let glyphs = ["·", "✢", "✲", "✶", "✻", "✽"]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let start = Date(ms: session.startedAt)
            let elapsed = ctx.date.timeIntervalSince(start)
            let tokens = session.tokens + session.rate * max(0, ctx.date.timeIntervalSince(model.viewAt)) / 60
            let over = elapsed > session.plannedMin * 60
            let progress = session.plannedMin > 0 ? min(1, elapsed / (session.plannedMin * 60)) : 0
            HStack(alignment: .center, spacing: 12) {
                ZStack {
                    Circle().stroke(Theme.faint.opacity(0.5), lineWidth: 3)
                    Circle().trim(from: 0, to: progress)
                        .stroke(over ? Theme.yellow : Theme.tier(session.tier), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text(Self.glyphs[Int(elapsed) % Self.glyphs.count]).font(Theme.mono(12)).foregroundStyle(Theme.accent)
                }
                .frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text("\(Self.clock(elapsed)) / \(Int(session.plannedMin))m")
                            .fontWeight(.semibold).monospacedDigit()
                            .foregroundStyle(over ? Theme.yellow : Theme.fg)
                        Text(session.lanes > 1 ? "\(session.tierLabel) ×\(session.lanes)" : session.tierLabel)
                            .foregroundStyle(Theme.tier(session.tier))
                        Text("↑ \(fmtTokens(tokens))").foregroundStyle(Theme.dim)
                    }
                    .font(Theme.mono(12))
                    if !session.intent.isEmpty {
                        Text(session.intent).font(.footnote).foregroundStyle(Theme.fg2).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Button { Task { await model.run("/end") } } label: {
                    Text("结束").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.link)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                }
                .buttonStyle(.plain)
                .glass(in: Capsule(), interactive: true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glass(in: RoundedRectangle(cornerRadius: 22, style: .continuous), tint: Theme.tier(session.tier).opacity(0.16))
        }
    }

    static func clock(_ s: TimeInterval) -> String {
        let t = Int(max(0, s))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

private struct OtherSessionsCard: View {
    let others: [ViewModel.OtherSession]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(others, id: \.self) { o in
                Label("另一台设备专注中 · \(o.intent.isEmpty ? "未命名" : o.intent)", systemImage: "ipad.and.iphone")
                    .lineLimit(1)
            }
        }
        .font(.footnote)
        .foregroundStyle(Theme.violet)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(in: RoundedRectangle(cornerRadius: 18, style: .continuous), tint: Theme.violet.opacity(0.12))
    }
}

/// The answer to the last command, with undo.
private struct OutputCard: View {
    let output: Output
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: output.error ? "exclamationmark.circle.fill" : "arrow.turn.down.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(output.error ? Theme.red : Theme.faint)
            Text(output.text.textGlyphs).font(Theme.mono(12)).foregroundStyle(output.error ? Theme.red : Theme.fg2).lineLimit(3)
            Spacer(minLength: 4)
            if output.undoable && model.view?.canUndo == true {
                Button("撤销") { Task { await model.undo() } }
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.link)
            }
            Button { model.clearOutput() } label: { Image(systemName: "xmark").font(.caption2.weight(.bold)) }
                .foregroundStyle(Theme.dim)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glass(in: RoundedRectangle(cornerRadius: 18, style: .continuous), tint: output.error ? Theme.red.opacity(0.14) : nil)
    }
}

/// Under the prompt: the mode, the model with its effort, and "+" for everything else.
private struct StatusChips: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let st = model.view?.status {
            HStack(spacing: 8) {
                let goal = model.view?.mode == "goal"
                Button { Task { await model.setMode(goal ? "plan" : "goal") } } label: {
                    HStack(spacing: 5) {
                        ModeIcon(goal: goal)
                        Text(goal ? "goal" : "plan").foregroundStyle(goal ? Theme.violet : Theme.teal)
                    }
                    .chipLabel()
                }
                .buttonStyle(.plain)
                .glass(in: Capsule(), tint: (goal ? Theme.violet : Theme.teal).opacity(0.18), interactive: true)
                ModelMenu(status: st)
                Spacer(minLength: 0)
                MoreMenu(status: st)
            }
        }
    }
}

private struct Choice: Hashable {
    let id: String
    let label: String
    let hint: String
}

/// Model tier and reasoning effort in one capsule; picking one runs /model or /effort
/// (so Fable still asks to split the task in progress).
private struct ModelMenu: View {
    let status: ViewModel.Status
    @EnvironmentObject private var model: AppModel

    private static let tiers = [
        Choice(id: "haiku", label: "Haiku", hint: "轻量：回复消息、整理、杂事"),
        Choice(id: "sonnet", label: "Sonnet", hint: "常规：日常推进、写作、编码"),
        Choice(id: "opus", label: "Opus", hint: "深度：难题、设计、需要整块专注"),
        Choice(id: "fable", label: "Fable", hint: "编排：先拆分任务，再并行推进子任务"),
    ]
    private static let efforts = [
        Choice(id: "low", label: "low", hint: "放松推进"),
        Choice(id: "medium", label: "medium", hint: "正常投入"),
        Choice(id: "high", label: "high", hint: "全力以赴"),
    ]

    var body: some View {
        Menu {
            Section("模型") {
                ForEach(Self.tiers, id: \.self) { t in
                    Button { Task { await model.run("/model \(t.id)") } } label: {
                        if t.id == status.tier { Label(t.label, systemImage: "checkmark") } else { Text(t.label) }
                        Text(t.hint)
                    }
                }
            }
            Section("推理强度") {
                ForEach(Self.efforts, id: \.self) { e in
                    Button { Task { await model.run("/effort \(e.id)") } } label: {
                        if e.id == status.effort { Label(e.label, systemImage: "checkmark") } else { Text(e.label) }
                        Text(e.hint)
                    }
                }
            }
        } label: {
            HStack(spacing: 7) {
                Text(status.lanes > 1 ? "\(status.tierLabel) ×\(status.lanes)" : status.tierLabel)
                    .fontWeight(.bold)
                    .foregroundStyle(Theme.tier(status.tier))
                EffortText(effort: status.effort)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.dim)
            }
            .chipLabel()
        }
        .menuOrder(.fixed)
        .glass(in: Capsule(), tint: Theme.tier(status.tier).opacity(0.14), interactive: true)
    }
}

/// "+": saved commands, and the status that used to sit in the chips (fatigue, sync,
/// budget). A dot on it when one of those needs a look.
private struct MoreMenu: View {
    let status: ViewModel.Status
    @EnvironmentObject private var model: AppModel

    private var attention: Color? {
        if status.sync.tone == "red" { return Theme.red }
        if status.sync.tone == "yellow" || (status.fatigue ?? 0) >= 4 { return Theme.yellow }
        return nil
    }

    var body: some View {
        Menu {
            Section("常用命令") {
                ForEach(model.savedCommands, id: \.self) { command in
                    Button(command) { Task { await model.run(command) } }
                }
                let draft = model.input.trimmingCharacters(in: .whitespaces)
                let savable = draft.hasPrefix("/") && draft.count > 1 && !model.savedCommands.contains(draft)
                Button { model.saveCommand(draft) } label: {
                    Label(savable ? "保存「\(draft)」" : "保存输入框里的命令", systemImage: "plus")
                    if model.savedCommands.isEmpty { Text("先在输入框写好 / 命令") }
                }
                .disabled(!savable)
                if !model.savedCommands.isEmpty {
                    Menu {
                        ForEach(model.savedCommands, id: \.self) { command in
                            Button(command, role: .destructive) { model.removeCommand(command) }
                        }
                    } label: {
                        Label("删除常用命令", systemImage: "trash")
                    }
                }
            }
            Section("状态") {
                Button { Task { await model.run("/fatigue") } } label: {
                    Label(status.fatigue.map { "疲劳 \($0)/5" + (status.fatigueMult > 1 ? "（Token ×\(Self.mult(status.fatigueMult))）" : "") } ?? "疲劳自评", systemImage: "battery.50percent")
                }
                Button { Task { await model.run("/sync") } } label: {
                    let sync = syncParts(status.sync.text)
                    Label(sync.text, systemImage: sync.symbol)
                }
                Button { model.prompt("/budget ") } label: {
                    Label("每日预算 \(fmtTokens(status.budget))", systemImage: "gauge.with.dots.needle.33percent")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.fg)
                .frame(width: 46, height: 32)
                .overlay(alignment: .topTrailing) {
                    if let attention { Circle().fill(attention).frame(width: 7, height: 7).offset(x: -9, y: 5) }
                }
                .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .glass(in: Capsule(), interactive: true)
    }

    static func mult(_ m: Double) -> String { m == m.rounded() ? String(Int(m)) : String(m) }
}

private extension View {
    func chipLabel() -> some View {
        font(Theme.mono(11))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .contentShape(Capsule())
    }
}

private struct EffortText: View {
    let effort: String
    var body: some View {
        let n = effort == "high" ? 3 : effort == "medium" ? 2 : 1
        let color = effort == "high" ? Theme.accent : effort == "medium" ? Theme.yellow : Theme.dim
        HStack(spacing: 4) {
            HStack(spacing: 0) {
                Text(String(repeating: "▰", count: n)).foregroundStyle(color)
                Text(String(repeating: "▱", count: 3 - n)).foregroundStyle(Theme.faint)
            }
            Text(effort).foregroundStyle(Theme.fg2)
        }
    }
}

/// The engine's sync line, its leading glyph as an SF Symbol.
func syncParts(_ text: String) -> (symbol: String, text: String) {
    let symbols: [Character: String] = ["⟳": "arrow.triangle.2.circlepath", "⚠": "exclamationmark.triangle.fill", "⏸": "pause.circle.fill", "✓": "checkmark.icloud", "✗": "xmark.icloud"]
    guard let first = text.first, let symbol = symbols[first] else { return ("iphone", text) }
    return (symbol, text.dropFirst().trimmingCharacters(in: .whitespaces))
}
