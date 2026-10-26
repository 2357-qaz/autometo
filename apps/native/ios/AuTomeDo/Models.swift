import Foundation

// The JSON the engine answers with (apps/native/src/view.ts and engine.ts).

/// A run of coloured text, as the terminal version draws it.
struct Seg: Decodable, Hashable {
    let t: String
    let c: String?
    let bg: String?
    let b: Bool?
    let s: Bool?
}

typealias Line = [Seg]

struct ViewModel: Decodable {
    struct Steps: Decodable, Hashable {
        let done: Int
        let total: Int
    }

    struct TaskItem: Decodable, Identifiable, Hashable {
        let id: String
        let num: Int
        let title: String
        let status: String
        let note: String?
        let phaseId: String?
        let sub: Bool
        let steps: Steps?
        let here: Bool
        let elsewhere: Bool
    }

    struct Phase: Decodable, Identifiable, Hashable {
        let id: String
        let title: String
        let goal: String
        let status: String
        let due: String?
        let overdue: Bool
    }

    struct GoalInfo: Decodable {
        struct Checkpoint: Decodable {
            let progress: Double
            let verdict: String
            let at: Double
            let learned: String
        }
        let why: String
        let doneWhen: String
        let nextAction: String
        let cadenceDays: Double
        let checkpointDue: Bool
        let nextCheckpointAt: Double
        let last: Checkpoint?
    }

    struct Workspace: Decodable {
        let id: String
        let kind: String
        let title: String
        let status: String
        let meta: Line
        let phases: [Phase]
        let goal: GoalInfo?
        let tasks: [TaskItem]
        let lanes: Int
    }

    struct WorkspaceItem: Decodable, Identifiable, Hashable {
        let id: String
        let kind: String
        let title: String
        let status: String
        let active: Bool
        let detail: String
    }

    struct Status: Decodable {
        struct Sync: Decodable {
            let text: String
            let tone: String
        }
        let tier: String
        let tierLabel: String
        let effort: String
        let lanes: Int
        let used: Double
        let budget: Double
        let level: String
        let fatigue: Int?
        let fatigueMult: Double
        let advice: String?
        let sync: Sync
    }

    struct Session: Decodable {
        let runId: String
        let intent: String
        let startedAt: Double
        let plannedMin: Double
        let tier: String
        let tierLabel: String
        let effort: String
        let lanes: Int
        let tokens: Double
        let rate: Double
    }

    struct OtherSession: Decodable, Hashable {
        let intent: String
        let startedAt: Double
        let plannedMin: Double
    }

    struct Block: Decodable, Identifiable {
        let key: String
        let lines: [Line]
        var id: String { key }
    }

    struct Resume: Decodable {
        let compactId: String
        let ago: String
    }

    let mode: String
    let ws: Workspace?
    let workspaces: [WorkspaceItem]
    let status: Status
    let session: Session?
    let otherSessions: [OtherSession]
    let timeline: [Block]
    let resume: Resume?
    let canUndo: Bool
}

/// A value of a form field (text, a choice, a slider position, a switch).
enum FieldValue: Decodable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string((try? c.decode(String.self)) ?? "") }
    }

    var any: Any {
        switch self {
        case let .string(s): return s
        case let .number(n): return n
        case let .bool(b): return b
        }
    }

    var text: String {
        switch self {
        case let .string(s): return s
        case let .number(n): return n == n.rounded() ? String(Int(n)) : String(n)
        case let .bool(b): return b ? "true" : "false"
        }
    }
}

struct Option: Decodable, Hashable {
    let value: String
    let label: String
    let hint: String?
}

/// One field of a form from the terminal version (apps/tui/src/forms.ts).
struct Field: Decodable, Identifiable {
    let kind: String // text | select | slider | confirm | editor
    let key: String
    let label: String
    let initial: FieldValue?
    let placeholder: String?
    let required: Bool?
    let secret: Bool?
    let options: [Option]?
    let step: Double?
    var id: String { key }
}

struct FormSpec: Decodable {
    let id: String
    let title: String
    let color: String
    let desc: String?
    let fields: [Field]
}

struct PickSpec: Decodable {
    let what: String
    let title: String
    let options: [Option]
    let current: Int
}

struct ConfirmSpec: Decodable, Identifiable {
    let id: String
    let title: String
    let message: String
    let confirmLabel: String
    let danger: Bool
}

struct LinesSpec: Decodable {
    let title: String
    let lines: [Line]
}

struct ReviewSpec: Decodable {
    let offset: Int
    let title: String
    let lines: [Line]
    let markdown: String
}

struct ExportSpec: Decodable {
    let text: String
    let filename: String
}

/// What to show after an action.
enum Intent: Decodable, Identifiable {
    case form(FormSpec)
    case pick(PickSpec)
    case confirm(ConfirmSpec)
    case lines(LinesSpec)
    case review(ReviewSpec)
    case switcher
    case export(ExportSpec)
    case importDoc
    /// Not from the engine: the timeline sheet.
    case timeline

    private enum Key: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let type = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .type)
        switch type {
        case "form": self = .form(try FormSpec(from: decoder))
        case "pick": self = .pick(try PickSpec(from: decoder))
        case "confirm": self = .confirm(try ConfirmSpec(from: decoder))
        case "lines": self = .lines(try LinesSpec(from: decoder))
        case "review": self = .review(try ReviewSpec(from: decoder))
        case "switch": self = .switcher
        case "export": self = .export(try ExportSpec(from: decoder))
        case "import": self = .importDoc
        default: throw DecodingError.dataCorrupted(.init(codingPath: [Key.type], debugDescription: "unknown intent \(type)"))
        }
    }

    var id: String {
        switch self {
        case let .form(f): return "form:\(f.id)"
        case let .pick(p): return "pick:\(p.what)"
        case let .confirm(c): return "confirm:\(c.id)"
        case let .lines(l): return "lines:\(l.title)"
        case let .review(r): return "review:\(r.offset)"
        case .switcher: return "switch"
        case .export: return "export"
        case .importDoc: return "import"
        case .timeline: return "timeline"
        }
    }
}

struct ActionResult: Decodable {
    let text: String?
    let error: Bool?
    let undoable: Bool?
    let intent: Intent?
}

struct Suggestion: Decodable, Identifiable, Hashable {
    let name: String
    let args: String
    let desc: String
    let needsArg: Bool
    var id: String { name }
}

struct Reminder: Decodable {
    let key: String
    let title: String
    let body: String
    let wsId: String?
    let at: Double
}
