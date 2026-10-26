import Foundation

/// The snapshot the web app computes (core's `glance()`, packages/core/src/glance.ts).
/// Numbers are Doubles: JSON does not tell integers apart.
struct Glance: Codable {
    struct TaskRef: Codable, Hashable {
        let title: String
        let num: Int
    }
    struct Steps: Codable, Hashable {
        let done: Int
        let total: Int
    }
    struct CurrentTask: Codable {
        let title: String
        let num: Int
        let steps: Steps?
        let running: [TaskRef]
    }
    struct Workspace: Codable {
        let kind: String
        let title: String
    }
    struct Session: Codable {
        let runId: String
        let intent: String
        let startedAt: Double
        let plannedEnd: Double
        let tier: String
        let tierLabel: String
        let effort: String
        let lanes: Int
        let rate: Double
        let tokens: Double
    }

    let v: Int
    let at: Double
    let day: Double
    let budget: Double
    let used: Double
    let level: String
    let tier: String
    let tierLabel: String
    let effort: String
    let fatigue: Int?
    let lanes: Int
    let ws: Workspace?
    let task: CurrentTask?
    let next: [TaskRef]
    let session: Session?

    static func decode(_ json: String) -> Glance? {
        try? JSONDecoder().decode(Glance.self, from: Data(json.utf8))
    }

    /// Today's usage as of `date`: a snapshot from an earlier day counts as 0.
    func used(on date: Date) -> Double {
        Calendar.current.startOfDay(for: date).timeIntervalSince1970 * 1000 > day + 1 ? 0 : used
    }
}

/// Where the app leaves the snapshot for the widget.
enum GlanceStore {
    private static let key = "glance"

    static func save(_ json: String) {
        AppGroup.defaults?.set(json, forKey: key)
    }

    static func load() -> Glance? {
        AppGroup.defaults?.string(forKey: key).flatMap(Glance.decode)
    }
}

extension Date {
    init(ms: Double) {
        self.init(timeIntervalSince1970: ms / 1000)
    }
}

func fmtTokens(_ n: Double) -> String {
    func short(_ x: Double) -> String {
        let s = String(format: "%.1f", x)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }
    if n >= 1_000_000 { return short(n / 1_000_000) + "M" }
    if n >= 1000 { return short(n / 1000) + "k" }
    return String(Int(n.rounded()))
}
