import SwiftUI

/// Pinned to the bottom, like the terminal: session line, last answer, command input, status line.
struct BottomBar: View {
    @EnvironmentObject private var model: AppModel
    @State private var input = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let s = model.view?.session { SessionLine(session: s) }
            ForEach(model.view?.otherSessions ?? [], id: \.self) { o in
                Text("✻ 另一台设备专注中 · \(o.intent.isEmpty ? "未命名" : o.intent)")
                    .font(Theme.mono(12)).foregroundStyle(Theme.violet).lineLimit(1)
            }
            if let out = model.output { OutputLine(output: out) }
            if (focused || input.hasPrefix("/")) && !model.suggestions.isEmpty { suggestions }
            prompt
            StatusLine()
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .background(Theme.bg.opacity(0.97))
        .overlay(alignment: .top) { Rectangle().fill(Theme.panel).frame(height: 1) }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.suggestions.prefix(6)) { s in
                Button {
                    if s.needsArg {
                        input = "/\(s.name) "
                    } else {
                        input = ""
                        Task { await model.run("/\(s.name)") }
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("/\(s.name)").foregroundStyle(Theme.accent)
                        Text(s.args).foregroundStyle(Theme.faint)
                        Text(s.desc).foregroundStyle(Theme.dim).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .font(Theme.mono(12))
                    .padding(.vertical, 5)
                }
            }
        }
        .padding(.horizontal, 10)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 8))
    }

    /// Text put into the input from elsewhere (a status-line tap, the screenshot mode).
    private func takeDraft() {
        guard let draft = model.draft else { return }
        input = draft
        focused = true
        model.draft = nil
    }

    private var prompt: some View {
        HStack(spacing: 8) {
            Text(">").foregroundStyle(Theme.fg2)
            TextField(model.view?.ws == nil ? "输入计划标题，或 /help" : model.view?.mode == "goal" ? "添加行动…  / 命令  # 记录" : "添加任务…  / 命令  # 记录", text: $input)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit(send)
                .onChange(of: input) { _, now in Task { await model.suggest(now) } }
                .onChange(of: model.draft) { _, _ in takeDraft() }
                .onAppear(perform: takeDraft)
            if !input.isEmpty {
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title3) }
                    .foregroundStyle(Theme.accent)
            }
        }
        .font(Theme.mono(15))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(focused ? Theme.fg2 : Theme.faint, lineWidth: 1))
    }

    private func send() {
        let text = input
        input = ""
        Task { await model.run(text) }
    }
}

private struct SessionLine: View {
    let session: ViewModel.Session
    @EnvironmentObject private var model: AppModel
    private static let glyphs = ["·", "✢", "✳", "✶", "✻", "✽"]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let start = Date(ms: session.startedAt)
            let elapsed = ctx.date.timeIntervalSince(start)
            let tokens = session.tokens + session.rate * max(0, ctx.date.timeIntervalSince(model.viewAt)) / 60
            let over = elapsed > session.plannedMin * 60
            HStack(spacing: 6) {
                Text(Self.glyphs[Int(elapsed) % Self.glyphs.count]).foregroundStyle(Theme.accent)
                Text("\(Self.clock(elapsed)) / \(Int(session.plannedMin))m").foregroundStyle(over ? Theme.yellow : Theme.fg2)
                Text("↑ \(fmtTokens(tokens))").foregroundStyle(Theme.dim)
                Text(session.lanes > 1 ? "\(session.tierLabel) ×\(session.lanes)" : session.tierLabel).foregroundStyle(Theme.tier(session.tier))
                if !session.intent.isEmpty { Text(session.intent).foregroundStyle(Theme.dim).lineLimit(1) }
                Spacer(minLength: 4)
                Button("结束") { Task { await model.run("/end") } }.foregroundStyle(Theme.link)
            }
            .font(Theme.mono(12))
        }
    }

    static func clock(_ s: TimeInterval) -> String {
        let t = Int(max(0, s))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

private struct OutputLine: View {
    let output: Output
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("⎿").foregroundStyle(Theme.faint)
            Text(output.text).foregroundStyle(output.error ? Theme.red : Theme.dim).lineLimit(3)
            Spacer(minLength: 4)
            if output.undoable && model.view?.canUndo == true {
                Button("撤销") { Task { await model.undo() } }.foregroundStyle(Theme.link)
            }
            Button { model.clearOutput() } label: { Image(systemName: "xmark").font(.caption2) }.foregroundStyle(Theme.faint)
        }
        .font(Theme.mono(12))
    }
}

/// mode · model · effort · budget · fatigue · sync — each opens its picker or form.
private struct StatusLine: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let st = model.view?.status {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let goal = model.view?.mode == "goal"
                    Button(goal ? "⏵⏵ goal mode" : "⏸ plan mode") { Task { await model.setMode(goal ? "plan" : "goal") } }
                        .foregroundStyle(goal ? Theme.violet : Theme.teal)
                    Text("·").foregroundStyle(Theme.faint)
                    Button { Task { await model.run("/model") } } label: {
                        Text(st.lanes > 1 ? "\(st.tierLabel) ×\(st.lanes) 路" : st.tierLabel).fontWeight(.bold).foregroundStyle(Theme.tier(st.tier))
                    }
                    Button { Task { await model.run("/effort") } } label: { EffortText(effort: st.effort) }
                    Text("·").foregroundStyle(Theme.faint)
                    BudgetText(used: st.used, budget: st.budget, level: st.level)
                    Text("·").foregroundStyle(Theme.faint)
                    Button { Task { await model.run("/fatigue") } } label: {
                        Text(st.fatigue.map { "疲劳 \($0)/5" + (st.fatigueMult > 1 ? " ×\(Self.mult(st.fatigueMult))" : "") } ?? "疲劳 –")
                            .foregroundStyle((st.fatigue ?? 0) >= 4 ? Theme.yellow : Theme.dim)
                    }
                    Text("·").foregroundStyle(Theme.faint)
                    Button { Task { await model.run("/sync") } } label: {
                        Text(st.sync.text).foregroundStyle(st.sync.tone == "red" ? Theme.red : st.sync.tone == "yellow" ? Theme.yellow : st.sync.tone == "blue" ? Theme.blue : Theme.dim)
                    }
                }
                .font(Theme.mono(11))
                .buttonStyle(.plain)
            }
            if let advice = st.advice {
                Text(advice).font(.caption2).foregroundStyle(Theme.yellow)
            }
        }
    }

    static func mult(_ m: Double) -> String { m == m.rounded() ? String(Int(m)) : String(m) }
}

private struct EffortText: View {
    let effort: String
    var body: some View {
        let n = effort == "high" ? 3 : effort == "medium" ? 2 : 1
        let color = effort == "high" ? Theme.accent : effort == "medium" ? Theme.yellow : Theme.dim
        HStack(spacing: 3) {
            HStack(spacing: 0) {
                Text(String(repeating: "▰", count: n)).foregroundStyle(color)
                Text(String(repeating: "▱", count: 3 - n)).foregroundStyle(Theme.faint)
            }
            Text(effort).foregroundStyle(Theme.fg2)
        }
    }
}

private struct BudgetText: View {
    let used: Double
    let budget: Double
    let level: String
    var body: some View {
        let ratio = budget > 0 ? min(1, used / budget) : 0
        let filled = Int((ratio * 6).rounded())
        let color = level == "ok" ? Theme.dim : level == "warn" ? Theme.yellow : Theme.red
        Text(String(repeating: "█", count: filled) + String(repeating: "░", count: 6 - filled) + " \(fmtTokens(used))/\(fmtTokens(budget))")
            .foregroundStyle(color)
    }
}
