import Capacitor
import Foundation
import WidgetKit

/// What the web app asks of iOS (see apps/web/src/native.ts):
/// - a file copy of the state document, in case iOS clears the web view's storage;
/// - the widget snapshot, shared with the widget through the App Group;
/// - the Live Activity of a running focus session.
@objc(AutomedoNativePlugin)
public class AutomedoNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AutomedoNativePlugin"
    public let jsName = "AutomedoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveAside", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGlance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncActivity", returnType: CAPPluginReturnPromise),
    ]

    /// Application Support/AuTomeDo (included in device backups).
    private func directory(_ sub: String? = nil) throws -> URL {
        var dir = try FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AuTomeDo", isDirectory: true)
        if let sub { dir.appendPathComponent(sub, isDirectory: true) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func backupURL() throws -> URL {
        try directory().appendingPathComponent("state.json")
    }

    @objc func loadBackup(_ call: CAPPluginCall) {
        do {
            let url = try backupURL()
            guard FileManager.default.fileExists(atPath: url.path) else { return call.resolve([:]) }
            call.resolve(["text": try String(contentsOf: url, encoding: .utf8)])
        } catch {
            call.reject("读取备份失败：\(error.localizedDescription)")
        }
    }

    @objc func saveBackup(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else { return call.reject("缺少 text") }
        do {
            try Data(text.utf8).write(to: try backupURL(), options: [.atomic])
            call.resolve()
        } catch {
            call.reject("写入备份失败：\(error.localizedDescription)")
        }
    }

    /// aside/<label>-<time>.json: a copy that must not be lost (never overwritten).
    @objc func saveAside(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else { return call.reject("缺少 text") }
        let label = (call.getString("label") ?? "copy").filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
        do {
            let url = try directory("aside").appendingPathComponent("\(label)-\(stamp)-\(UUID().uuidString.prefix(6)).json")
            try Data(text.utf8).write(to: url, options: [.atomic])
            call.resolve()
        } catch {
            call.reject("保存副本失败：\(error.localizedDescription)")
        }
    }

    @objc func setGlance(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else { return call.reject("缺少 json") }
        GlanceStore.save(json)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func syncActivity(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let glance = Glance.decode(json) else { return call.reject("无法解析 Session 数据") }
        SessionActivityController.sync(glance)
        call.resolve()
    }
}
