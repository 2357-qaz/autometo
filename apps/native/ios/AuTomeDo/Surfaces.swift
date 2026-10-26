import Foundation
import UserNotifications
import WidgetKit

/// The widget, the Live Activity and the reminders, kept in line with the engine.
/// (The widget and Live Activity views are shared with apps/mobile: ../../mobile/ios/App.)
actor Surfaces {
    private var lastGlance = ""
    private var remindersDone = ""

    func update(_ engine: Engine, force: Bool = false) async {
        let glanceData = await engine.call("glance")
        if let json = String(data: glanceData, encoding: .utf8), let glance = Glance.decode(json) {
            // Token counts move every minute; anything else is a real change.
            let key = Self.withoutCounters(json)
            if force || key != lastGlance {
                GlanceStore.save(json)
                WidgetCenter.shared.reloadAllTimelines()
                await MainActor.run { SessionActivityController.sync(glance) }
                lastGlance = key
            }
        }
        if let reminders = await engine.decode([Reminder].self, "reminders") {
            let sig = reminders.map { "\($0.key)|\($0.at)|\($0.title)|\($0.body)" }.joined(separator: "\n")
            if sig != remindersDone, await Self.schedule(reminders) { remindersDone = sig }
        }
    }

    private static func withoutCounters(_ json: String) -> String {
        guard var o = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return json }
        o["at"] = 0
        o["used"] = 0
        if var s = o["session"] as? [String: Any] {
            s["tokens"] = 0
            o["session"] = s
        }
        let data = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private static let prefix = "automedo."

    /// Make the pending notifications match `list`. False (try again later) without
    /// permission. New requests replace pending ones with the same identifier, so they go in
    /// first and only then the ones no longer wanted are removed: a failure in between leaves
    /// extra reminders, never none.
    private static func schedule(_ list: [Reminder]) async -> Bool {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            if list.isEmpty { return true }
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional || status == .ephemeral else { return false }
        do {
            for r in list {
                let content = UNMutableNotificationContent()
                content.title = r.title
                content.body = r.body
                content.sound = .default
                if let ws = r.wsId { content.userInfo = ["wsId": ws] }
                let at = Date(ms: r.at)
                let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: at)
                let request = UNNotificationRequest(identifier: prefix + r.key, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
                try await center.add(request)
            }
        } catch {
            return false
        }
        let wanted = Set(list.map { prefix + $0.key })
        let stale = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(prefix) && !wanted.contains($0) }
        center.removePendingNotificationRequests(withIdentifiers: stale)
        return true
    }
}
