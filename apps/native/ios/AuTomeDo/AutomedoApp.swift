import SwiftUI

@main
struct AutomedoApp: App {
    @StateObject private var model: AppModel
    @Environment(\.scenePhase) private var phase

    init() {
        let demo = Screenshot.isDemo
        let base: URL
        if demo {
            // Screenshots / a first look: fresh demo data every launch, nothing of the real data touched.
            base = FileManager.default.temporaryDirectory.appendingPathComponent("automedo-demo", isDirectory: true)
            try? FileManager.default.removeItem(at: base)
        } else {
            base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))!
                .appendingPathComponent("AuTomeDo", isDirectory: true)
        }
        let defaults = demo ? (UserDefaults(suiteName: "automedo.demo") ?? .standard) : .standard
        if demo { defaults.removePersistentDomain(forName: "automedo.demo") }
        let engine = Engine(paths: .init(doc: base.appendingPathComponent("state.json"), aside: base.appendingPathComponent("aside", isDirectory: true)), defaults: defaults)
        _model = StateObject(wrappedValue: AppModel(engine: engine))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .task {
                    await model.activate()
                    await Screenshot.prepare(model)
                }
                .onChange(of: phase) { _, now in
                    switch now {
                    case .background: Task { await model.flush() }
                    case .active: Task { await model.activate() }
                    default: break
                    }
                }
        }
    }
}

/// Launch arguments used by CI to take screenshots in the simulator:
/// `-AutomedoDemo` (demo data in a temporary place) and `-AutomedoScreen <name>`.
enum Screenshot {
    static let isDemo = ProcessInfo.processInfo.arguments.contains("-AutomedoDemo")

    static var screen: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-AutomedoScreen"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    @MainActor
    static func prepare(_ model: AppModel) async {
        guard isDemo else { return }
        await model.seedDemo()
        await model.refresh()
        model.clearOutput()
        switch screen {
        case "split":
            await model.run("/model fable")
        case "fable":
            await model.run("/model fable")
            if case let .form(form)? = model.sheet {
                _ = await model.submit(form, ["doneWhen": "两套方案能直接用在首页", "steps": "选字体；定主色；做样张", "start": "1 2", "risk": "配色要和插画一起看"])
            }
            await model.run("/session 45")
            if case let .form(form)? = model.sheet {
                _ = await model.submit(form, ["intent": "定配色", "tier": "fable", "effort": "medium", "minutes": "45"])
            }
        case "review":
            await model.review(0)
        case "timeline":
            model.present(.timeline)
        case "switcher":
            model.present(.switcher)
        case "command":
            model.input = "/re"
            await model.suggest("/re")
        default:
            break
        }
    }
}
