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
                StatusChips(prompt: { text in
                    model.input = text
                    focused = true
                })
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 2)
        }
        .animation(.snappy(duration: 0.25), value: showSuggestions)
        .animation(.snappy(duration: 0.25), value: model.input.isEmpty)
        .animation(.snappy(duration: 0.25), value: model.output?.text)
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

/// mode · model · effort · budget · fatigue · sync — one chip each; a tap opens its picker or form.
private struct StatusChips: View {
    /// Puts a command that needs an argument into the prompt.
    let prompt: (String) -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let st = model.view?.status {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        let goal = model.view?.mode == "goal"
                        Chip(tint: (goal ? Theme.violet : Theme.teal).opacity(0.18)) {
                            Task { await model.setMode(goal ? "plan" : "goal") }
                        } label: {
                            HStack(spacing: 5) {
                                ModeIcon(goal: goal)
                                Text(goal ? "goal" : "plan").foregroundStyle(goal ? Theme.violet : Theme.teal)
                            }
                        }
                        Chip(tint: Theme.tier(st.tier).opacity(0.14)) { Task { await model.run("/model") } } label: {
                            Text(st.lanes > 1 ? "\(st.tierLabel) ×\(st.lanes) 路" : st.tierLabel).fontWeight(.bold).foregroundStyle(Theme.tier(st.tier))
                        }
                        Chip { Task { await model.run("/effort") } } label: {
                            EffortText(effort: st.effort)
                        }
                        Chip { prompt("/budget ") } label: {
                            BudgetView(used: st.used, budget: st.budget, level: st.level)
                        }
                        Chip(tint: (st.fatigue ?? 0) >= 4 ? Theme.yellow.opacity(0.16) : nil) { Task { await model.run("/fatigue") } } label: {
                            Text(st.fatigue.map { "疲劳 \($0)/5" + (st.fatigueMult > 1 ? " ×\(Self.mult(st.fatigueMult))" : "") } ?? "疲劳 –")
                                .foregroundStyle((st.fatigue ?? 0) >= 4 ? Theme.yellow : Theme.fg2)
                        }
                        Chip(tint: syncTint(st.sync.tone)) { Task { await model.run("/sync") } } label: {
                            SyncLabel(sync: st.sync)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollClipDisabled()
                if let advice = st.advice {
                    Text(advice.textGlyphs).font(.caption2).foregroundStyle(Theme.yellow).padding(.leading, 4)
                }
            }
        }
    }

    private func syncTint(_ tone: String) -> Color? {
        switch tone {
        case "red": return Theme.red.opacity(0.16)
        case "yellow": return Theme.yellow.opacity(0.14)
        default: return nil
        }
    }

    static func mult(_ m: Double) -> String { m == m.rounded() ? String(Int(m)) : String(m) }
}

private struct Chip<Content: View>: View {
    var tint: Color? = nil
    let action: () -> Void
    @ViewBuilder let label: Content

    var body: some View {
        Button(action: action) {
            label
                .font(Theme.mono(11))
                .lineLimit(1)
                .padding(.horizontal, 11)
                .frame(height: 30)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glass(in: Capsule(), tint: tint, interactive: true)
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

/// Today's tokens against the daily budget, as a small meter.
private struct BudgetView: View {
    let used: Double
    let budget: Double
    let level: String
    var body: some View {
        let ratio = budget > 0 ? min(1, used / budget) : 0
        let color = level == "ok" ? Theme.teal : level == "warn" ? Theme.yellow : Theme.red
        HStack(spacing: 6) {
            Capsule().fill(Theme.faint.opacity(0.45))
                .frame(width: 34, height: 5)
                .overlay(alignment: .leading) { Capsule().fill(color).frame(width: max(ratio > 0 ? 5 : 0, 34 * ratio), height: 5) }
            Text("\(fmtTokens(used))/\(fmtTokens(budget))").foregroundStyle(level == "ok" ? Theme.fg2 : color)
        }
    }
}

/// The engine's sync line with an SF Symbol in place of its leading glyph.
private struct SyncLabel: View {
    let sync: ViewModel.Status.Sync

    var body: some View {
        let parts = Self.split(sync.text)
        HStack(spacing: 4) {
            Image(systemName: parts.symbol)
            Text(parts.text)
        }
        .foregroundStyle(sync.tone == "red" ? Theme.red : sync.tone == "yellow" ? Theme.yellow : sync.tone == "blue" ? Theme.blue : Theme.fg2)
    }

    static func split(_ text: String) -> (symbol: String, text: String) {
        let symbols: [Character: String] = ["⟳": "arrow.triangle.2.circlepath", "⚠": "exclamationmark.triangle.fill", "⏸": "pause.circle.fill", "✓": "checkmark.icloud", "✗": "xmark.icloud"]
        guard let first = text.first, let symbol = symbols[first] else { return ("iphone", text) }
        return (symbol, text.dropFirst().trimmingCharacters(in: .whitespaces))
    }
}
