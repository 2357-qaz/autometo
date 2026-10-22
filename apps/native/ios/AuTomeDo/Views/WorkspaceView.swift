import SwiftUI

struct WorkspaceView: View {
    let ws: ViewModel.Workspace
    @EnvironmentObject private var model: AppModel
    @State private var showDone = false

    private var open: [ViewModel.TaskItem] { ws.tasks.filter { $0.status != "done" && $0.status != "skipped" } }
    private var finished: [ViewModel.TaskItem] { ws.tasks.filter { $0.status == "done" || $0.status == "skipped" } }

    var body: some View {
        List {
            Section {
                header
            }
            .listRowBackground(Theme.bg)

            if let resume = model.view?.resume {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "clock.arrow.circlepath").foregroundStyle(Theme.blue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("上次的快照（\(resume.ago)）").font(.subheadline)
                            Text("从上次停下的地方继续").font(.caption).foregroundStyle(Theme.dim)
                        }
                        Spacer()
                        Button("Resume") { Task { await model.resume(resume) } }.buttonStyle(.bordered)
                        Button { Task { await model.dismissResume(resume) } } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless).foregroundStyle(Theme.dim)
                    }
                }
                .listRowBackground(Theme.panel)
            }

            if ws.kind == "plan" {
                ForEach(ws.phases) { phase in
                    let tasks = open.filter { $0.phaseId == phase.id }
                    if phase.status != "done" || !tasks.isEmpty {
                        Section {
                            ForEach(tasks) { TaskRow(task: $0) }
                            AddTaskRow(placeholder: "添加到「\(phase.title)」", phaseId: phase.id)
                        } header: {
                            PhaseHeader(phase: phase)
                        }
                    }
                }
            } else {
                Section("行动") {
                    ForEach(open) { TaskRow(task: $0) }
                    AddTaskRow(placeholder: "添加行动", phaseId: nil)
                }
            }

            if !finished.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $showDone) {
                        ForEach(finished) { TaskRow(task: $0) }
                    } label: {
                        Label("已完成 \(finished.count) 项", systemImage: "checkmark.circle").font(Theme.mono(13)).foregroundStyle(Theme.dim)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .refreshable { await model.syncNow() }
    }

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(ws.title).font(.title3.weight(.bold)).foregroundStyle(Theme.fg)
                if ws.status != "active" {
                    Text(ws.status).font(.caption).padding(.horizontal, 6).overlay(Capsule().stroke(Theme.dim))
                }
            }
            Text(ws.meta.attributed).font(Theme.mono(12))
            if let goal = ws.goal {
                if !goal.why.isEmpty { Text("为什么：\(goal.why)").font(.footnote).foregroundStyle(Theme.fg2) }
                if !goal.nextAction.isEmpty {
                    HStack(alignment: .firstTextBaseline) {
                        Text("下一步：").foregroundStyle(Theme.dim)
                        Text(goal.nextAction).foregroundStyle(Theme.fg)
                    }
                    .font(.subheadline)
                }
                Button {
                    Task { await model.run("/checkpoint") }
                } label: {
                    Label(goal.checkpointDue ? "Checkpoint 到期" : "做一次 Checkpoint", systemImage: goal.checkpointDue ? "flag.fill" : "flag")
                }
                .font(.footnote)
                .foregroundStyle(goal.checkpointDue ? Theme.yellow : Theme.link)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct PhaseHeader: View {
    let phase: ViewModel.Phase
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("## \(phase.title)").foregroundStyle(phase.status == "active" ? Theme.teal : phase.status == "done" ? Theme.faint : Theme.dim)
            if let due = phase.due {
                Text("目标 \(String(due.dropFirst(5)))").foregroundStyle(phase.overdue ? Theme.yellow : Theme.faint)
            }
            Spacer()
            if phase.status == "active" {
                Menu {
                    Button("修正阶段目标") { Task { await model.open(["type": "revise", "phaseId": phase.id]) } }
                    Button("完成本阶段") { Task { await model.run("/phase done") } }
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(Theme.dim)
                }
            }
        }
        .font(Theme.mono(12))
        .textCase(nil)
    }
}

struct TaskRow: View {
    let task: ViewModel.TaskItem
    @EnvironmentObject private var model: AppModel

    private var symbol: String {
        switch task.status {
        case "active": return "circle.inset.filled"
        case "done": return "checkmark.circle.fill"
        case "blocked": return "exclamationmark.circle"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }

    private var color: Color {
        if task.elsewhere { return Theme.violet }
        switch task.status {
        case "active": return Theme.accent
        case "done", "skipped": return Theme.faint
        case "blocked": return Theme.red
        default: return Theme.fg
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if task.sub { Text("↳").foregroundStyle(Theme.faint) }
            Button { Task { await model.act("cycle", task) } } label: {
                Text(Image(systemName: symbol)).font(.body).foregroundStyle(color)
            }
            .buttonStyle(.borderless)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .foregroundStyle(color)
                    .fontWeight(task.status == "active" ? .semibold : .regular)
                    .strikethrough(task.status == "done" || task.status == "skipped")
                HStack(spacing: 6) {
                    if let steps = task.steps { Text("\(steps.done)/\(steps.total) 步").foregroundStyle(Theme.dim) }
                    if task.elsewhere { Text("另一台设备进行中").foregroundStyle(Theme.violet) }
                    if let note = task.note, !note.isEmpty {
                        Text(note.replacingOccurrences(of: "\n", with: "；")).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                }
                .font(.caption)
            }
            Spacer(minLength: 4)
            Text("#\(task.num)").font(Theme.mono(11)).foregroundStyle(Theme.faint)
        }
        .padding(.leading, task.sub ? 14 : 0)
        .contentShape(Rectangle())
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if task.status == "done" || task.status == "skipped" {
                Button { Task { await model.act("reopen", task) } } label: { Label("重新打开", systemImage: "arrow.uturn.backward") }.tint(Theme.dim)
            } else {
                Button { Task { await model.act("done", task) } } label: { Label("完成", systemImage: "checkmark") }.tint(Theme.green)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { Task { await model.act("delete", task) } } label: { Label("删除", systemImage: "trash") }
            if task.status != "done" {
                Button { Task { await model.act("defer", task) } } label: { Label("延期", systemImage: "arrow.uturn.forward") }.tint(Theme.yellow)
            }
        }
        .contextMenu {
            if task.status != "active" && task.status != "done" {
                Button { Task { await model.act("start", task) } } label: { Label("开始", systemImage: "play") }
            }
            if task.status != "done" {
                Button { Task { await model.act("done", task) } } label: { Label("完成", systemImage: "checkmark") }
                Button { Task { await model.act("block", task) } } label: { Label("卡住了", systemImage: "xmark.octagon") }
                Button { Task { await model.act("skip", task) } } label: { Label("跳过", systemImage: "forward") }
            }
            if !task.sub && task.status != "done" && task.status != "skipped" {
                Button { Task { await model.act("split", task) } } label: { Label("拆成子任务", systemImage: "scissors") }
            }
            Button { Task { await model.act("edit", task) } } label: { Label("编辑 / 备注", systemImage: "pencil") }
            Button { Task { await model.act("up", task) } } label: { Label("上移", systemImage: "arrow.up") }
            Button { Task { await model.act("down", task) } } label: { Label("下移", systemImage: "arrow.down") }
            Button(role: .destructive) { Task { await model.act("delete", task) } } label: { Label("删除", systemImage: "trash") }
        }
    }
}

/// Type a task straight into a phase (or the goal's actions).
private struct AddTaskRow: View {
    let placeholder: String
    let phaseId: String?
    @EnvironmentObject private var model: AppModel
    @State private var text = ""

    var body: some View {
        TextField(placeholder, text: $text)
            .font(.subheadline)
            .foregroundStyle(Theme.fg2)
            .submitLabel(.done)
            .onSubmit {
                let t = text.trimmingCharacters(in: .whitespaces)
                guard !t.isEmpty else { return }
                text = ""
                Task { await model.addTask(t, phaseId: phaseId) }
            }
    }
}
