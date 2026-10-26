import ActivityKit
import Foundation

/// Keeps one Live Activity in line with this device's running focus session.
enum SessionActivityController {
    static func sync(_ glance: Glance) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let running = Activity<SessionAttributes>.activities
        guard let session = glance.session else {
            running.forEach(end)
            return
        }
        let content = ActivityContent(state: SessionAttributes.ContentState(glance: glance, session: session), staleDate: nil)
        if let current = running.first(where: { $0.attributes.runId == session.runId }) {
            Task { await current.update(content) }
            running.filter { $0.id != current.id }.forEach(end)
        } else {
            running.forEach(end)
            do {
                let attributes = SessionAttributes(runId: session.runId, startedAt: Date(ms: session.startedAt))
                _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
            } catch {
                print("Live Activity request failed: \(error)")
            }
        }
    }

    /// Gone right away: an ended session's timer must not keep counting on the lock screen.
    private static func end(_ activity: Activity<SessionAttributes>) {
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
