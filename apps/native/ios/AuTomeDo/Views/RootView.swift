import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if let ws = model.view?.ws {
                    WorkspaceView(ws: ws)
                } else if model.view != nil {
                    WelcomeView()
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.bg)
            .floatingBottomBar { BottomBar() }
            .appToolbar(leading: { leadingItem }, ring: { ToolbarItem(placement: .topBarTrailing) { UsageMenu() } }, trailing: { trailingItems })
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(item: $model.sheet) { intent in
            sheet(for: intent)
                .presentationBackground(Theme.bg)
        }
        .alert(model.confirmation?.title ?? "", isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.confirmation = nil } }), presenting: model.confirmation) { c in
            Button(c.confirmLabel, role: c.danger ? .destructive : nil) { Task { await model.confirm(c, true) } }
            Button("取消", role: .cancel) { Task { await model.confirm(c, false) } }
        } message: { c in
            Text(c.message)
        }
        .fileExporter(isPresented: Binding(get: { model.exporting != nil }, set: { if !$0 { model.exporting = nil } }), document: JSONFile(text: model.exporting?.text ?? ""), contentType: .json, defaultFilename: model.exporting?.filename) { _ in
            model.exporting = nil
        }
        .fileImporter(isPresented: $model.importing, allowedContentTypes: [.json]) { result in
            guard case let .success(url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let text = try? String(contentsOf: url, encoding: .utf8) { Task { await model.importData(text) } }
        }
    }

    private var leadingItem: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { model.present(.switcher) } label: {
                HStack(spacing: 6) {
                    ModeIcon(goal: model.view?.mode == "goal").font(.subheadline)
                    Text(model.view?.ws?.title ?? "AuTomeDo").fontWeight(.semibold).foregroundStyle(Theme.fg).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2).foregroundStyle(Theme.dim)
                }
                .font(Theme.mono(15))
            }
        }
    }

    private var trailingItems: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { model.present(.timeline) } label: { Image(systemName: "text.alignleft") }
                .disabled(model.view?.ws == nil)
            Menu {
                Button { Task { await model.run("/session") } } label: { Label("开始专注 Session", systemImage: "timer") }
                Button { Task { await model.run("/compact") } } label: { Label("Compact 快照", systemImage: "archivebox") }
                Button { Task { await model.review(0) } } label: { Label("周回顾", systemImage: "calendar") }
                if model.view?.ws?.kind == "plan" {
                    Button { Task { await model.run("/diff") } } label: { Label("Plan Diff", systemImage: "plusminus") }
                }
                Divider()
                Button { Task { await model.run("/sync") } } label: { Label("同步设置", systemImage: "arrow.triangle.2.circlepath") }
                Button { Task { await model.exportData() } } label: { Label("导出备份", systemImage: "square.and.arrow.up") }
                Button { model.importing = true } label: { Label("导入备份", systemImage: "square.and.arrow.down") }
                Divider()
                Button { Task { await model.run("/help") } } label: { Label("全部命令", systemImage: "questionmark.circle") }
            } label: {
                Image(systemName: "ellipsis")
            }
        }
    }

    @ViewBuilder
    private func sheet(for intent: Intent) -> some View {
        switch intent {
        case let .form(form): FormSheet(form: form)
        case let .pick(pick): PickSheet(spec: pick).presentationDetents([.medium, .large])
        case let .lines(lines): LinesSheet(title: lines.title, lines: lines.lines)
        case let .review(review): ReviewSheet(review: review)
        case .switcher: SwitcherSheet()
        case .timeline: TimelineSheet()
        case .confirm, .export, .importDoc: EmptyView()
        }
    }
}

/// The exported backup, for the system file exporter.
struct JSONFile: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

/// Nothing yet: start a plan or a goal, or look around with the demo data.
struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("✻ Welcome to AuTomeDo").font(Theme.mono(18, .bold)).foregroundStyle(Theme.accent)
                Text("像编写 Agent 计划一样组织自己的工作。").foregroundStyle(Theme.fg2)
                if let error = model.loadError {
                    Text(error).font(.footnote).foregroundStyle(Theme.red)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Label("Plan：路径明确——先写计划、分阶段，再执行", systemImage: "list.bullet.rectangle").foregroundStyle(Theme.teal)
                    Label("Goal：路径不明——先行动，用 Checkpoint 找方向", systemImage: "scope").foregroundStyle(Theme.violet)
                }
                .font(.subheadline)
                VStack(spacing: 10) {
                    Button { Task { await model.open(["type": "newPlan"]) } } label: { Text("新建 Plan").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                    Button { Task { await model.open(["type": "newGoal"]) } } label: { Text("新建 Goal").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                    Button("载入示例数据看看") { Task { await model.seedDemo() } }
                        .font(.footnote)
                    Button("从备份导入") { model.importing = true }
                        .font(.footnote)
                }
                .padding(.top, 8)
            }
            .padding(24)
        }
    }
}
