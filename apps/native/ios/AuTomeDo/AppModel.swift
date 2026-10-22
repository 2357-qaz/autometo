import Foundation
import SwiftUI
import UIKit
import WidgetKit

/// The last answer to show at the bottom (like the terminal's ⎿ line).
struct Output: Equatable {
    let cmd: String
    let text: String
    let error: Bool
    let undoable: Bool
}

/// Screen state. Everything the app knows comes from the engine (`view`); user actions go
/// back to it, and what they open (forms, pickers, confirmations…) comes back as an Intent.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var view: ViewModel?
    /// When `view` was built: running session tokens are extrapolated from it.
    @Published private(set) var viewAt = Date()
    @Published var sheet: Intent?
    @Published var confirmation: ConfirmSpec?
    @Published var exporting: ExportSpec?
    @Published var importing = false
    @Published private(set) var output: Output?
    @Published private(set) var suggestions: [Suggestion] = []
    @Published private(set) var loadError: String?

    let engine: Engine
    private let surfaces = Surfaces()
    private var refreshing = false
    private var refreshAgain = false

    init(engine: Engine) {
        self.engine = engine
        loadError = engine.loadError
        engine.onChange = { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    /// Pull the view again; changes arriving meanwhile coalesce into one more pull.
    func refresh() async {
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        repeat {
            refreshAgain = false
            if let v = await engine.decode(ViewModel.self, "view") {
                view = v
                viewAt = Date()
            }
        } while refreshAgain
        refreshing = false
        await surfaces.update(engine)
    }

    // MARK: - actions

    func run(_ input: String) async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        handle(await engine.decode(ActionResult.self, "execute", ["input": text]), cmd: text)
    }

    func act(_ kind: String, _ task: ViewModel.TaskItem) async {
        if kind == "done" { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        handle(await engine.decode(ActionResult.self, "act", ["kind": kind, "taskId": task.id]), cmd: task.title)
    }

    func addTask(_ title: String, phaseId: String?) async {
        var args: [String: Any] = ["title": title]
        if let phaseId { args["phaseId"] = phaseId }
        handle(await engine.decode(ActionResult.self, "addTask", args), cmd: title)
    }

    func open(_ intent: [String: Any]) async {
        handle(await engine.decode(ActionResult.self, "open", ["intent": intent]), cmd: "")
    }

    /// Submit a form; nil when it closed, else the error to show in it.
    func submit(_ form: FormSpec, _ values: [String: Any]) async -> String? {
        let r = await engine.decode(ActionResult.self, "submitForm", ["id": form.id, "values": values])
        if r?.error == true { return r?.text ?? "出错了" }
        sheet = nil
        handle(r, cmd: form.title)
        return nil
    }

    func cancel(_ form: FormSpec) {
        Task { _ = await engine.call("cancelForm", ["id": form.id]) }
    }

    func pick(_ spec: PickSpec, _ value: String) async {
        sheet = nil
        UISelectionFeedbackGenerator().selectionChanged()
        handle(await engine.decode(ActionResult.self, "pick", ["what": spec.what, "value": value]), cmd: spec.title)
    }

    func confirm(_ spec: ConfirmSpec, _ ok: Bool) async {
        confirmation = nil
        handle(await engine.decode(ActionResult.self, "confirm", ["id": spec.id, "ok": ok]), cmd: spec.title)
    }

    func undo() async {
        handle(await engine.decode(ActionResult.self, "undo"), cmd: "撤销")
    }

    func select(_ ws: ViewModel.WorkspaceItem) async {
        sheet = nil
        _ = await engine.call("selectWs", ["id": ws.id])
    }

    func setMode(_ mode: String) async {
        _ = await engine.call("setMode", ["mode": mode])
    }

    func deleteWorkspace(_ ws: ViewModel.WorkspaceItem) async {
        handle(await engine.decode(ActionResult.self, "deleteWs", ["id": ws.id]), cmd: ws.title)
    }

    func review(_ offset: Int) async {
        handle(await engine.decode(ActionResult.self, "review", ["offset": offset]), cmd: "")
    }

    func resume(_ r: ViewModel.Resume) async {
        await open(["type": "resume", "compactId": r.compactId])
    }

    func dismissResume(_ r: ViewModel.Resume) async {
        _ = await engine.call("dismissResume", ["compactId": r.compactId])
    }

    func exportData() async {
        handle(await engine.decode(ActionResult.self, "exportDoc"), cmd: "导出")
    }

    func importData(_ text: String) async {
        handle(await engine.decode(ActionResult.self, "importDoc", ["text": text]), cmd: "导入")
    }

    func syncNow() async {
        handle(await engine.decode(ActionResult.self, "syncNow"), cmd: "同步")
    }

    func seedDemo() async {
        handle(await engine.decode(ActionResult.self, "seedDemo"), cmd: "示例数据")
    }

    func suggest(_ input: String) async {
        guard input.hasPrefix("/") else {
            suggestions = []
            return
        }
        suggestions = await engine.decode([Suggestion].self, "suggest", ["input": input]) ?? []
    }

    /// Leaving the app: write everything now; the widget and reminders follow.
    func flush() async {
        _ = await engine.call("flush")
        await surfaces.update(engine, force: true)
    }

    /// Coming back: catch up (e.g. notifications allowed in Settings meanwhile).
    func activate() async {
        await refresh()
        await surfaces.update(engine, force: true)
    }

    func clearOutput() {
        output = nil
    }

    private func handle(_ r: ActionResult?, cmd: String) {
        guard let r else { return }
        if let text = r.text, !text.isEmpty {
            output = Output(cmd: cmd, text: text, error: r.error ?? false, undoable: r.undoable ?? false)
        }
        if let intent = r.intent { present(intent) }
    }

    func present(_ intent: Intent) {
        switch intent {
        case let .confirm(c): confirmation = c
        case let .export(e): exporting = e
        case .importDoc: importing = true
        default: sheet = intent
        }
    }
}
