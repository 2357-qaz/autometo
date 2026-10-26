import ActivityKit
import Foundation

/// The Live Activity of a focus session. The timer counts by itself; tokens are as of
/// the last update (the app updates it while it is open).
struct SessionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var intent: String
        var tier: String
        var tierLabel: String
        var effort: String
        var lanes: Int
        var rate: Double
        var tokens: Double
        var tokensAt: Date
        var plannedEnd: Date
        var task: String?
        var steps: String?
    }

    var runId: String
    var startedAt: Date
}

extension SessionAttributes.ContentState {
    init(glance g: Glance, session s: Glance.Session) {
        let steps = g.task?.steps.map { "\($0.done)/\($0.total) 步" }
        self.init(
            intent: s.intent,
            tier: s.tier,
            tierLabel: s.tierLabel,
            effort: s.effort,
            lanes: s.lanes,
            rate: s.rate,
            tokens: s.tokens,
            tokensAt: Date(ms: g.at),
            plannedEnd: Date(ms: s.plannedEnd),
            task: g.task?.title,
            steps: steps
        )
    }
}
