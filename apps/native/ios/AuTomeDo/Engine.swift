import Foundation
import JavaScriptCore

/// Runs engine.js (@automedo/core and friends, see apps/native/src) in JavaScriptCore and
/// gives it what a browser or Node would: timers, network, a file for the state document.
///
/// JavaScriptCore is not thread-safe: the context lives on one serial queue, and every
/// call into it (actions, timers firing, requests finishing) is made on that queue.
final class Engine: @unchecked Sendable {
    struct Paths {
        /// The state document (atomic writes).
        let doc: URL
        /// Copies that must not be lost (e.g. a document that could not be read).
        let aside: URL
    }

    private let queue = DispatchQueue(label: "app.automedo.native.engine", qos: .userInitiated)
    private let paths: Paths
    private let defaults: UserDefaults
    private let session: URLSession
    private var context: JSContext!
    private var automedo: JSValue!
    private var timers: [Int: DispatchWorkItem] = [:]
    private var requests: [Int: URLSessionDataTask] = [:]
    private var replies: [Int: CheckedContinuation<Data, Never>] = [:]
    private var nextCall = 1

    /// Called on the main queue when the state or the sync status changed.
    var onChange: (@Sendable () -> Void)?
    /// Set when the stored document could not be read at start.
    private(set) var loadError: String?
    /// The last uncaught JavaScript error (also logged).
    private(set) var lastException: String?

    init(paths: Paths, defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.paths = paths
        self.defaults = defaults
        self.session = session
        queue.sync { boot() }
    }

    // MARK: - calls from Swift

    /// Run an engine function (see `api` in engine.ts); the JSON it answers with.
    func call(_ name: String, _ args: [String: Any] = [:]) async -> Data {
        let json = (try? JSONSerialization.data(withJSONObject: args)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return await withCheckedContinuation { continuation in
            queue.async {
                let id = self.nextCall
                self.nextCall += 1
                self.replies[id] = continuation
                self.automedo.invokeMethod("call", withArguments: [id, name, json])
            }
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ name: String, _ args: [String: Any] = [:]) async -> T? {
        let data = await call(name, args)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            NSLog("[engine] could not decode %@ from %@: %@", String(describing: T.self), name, String(describing: error))
            return nil
        }
    }

    // MARK: - setup

    private func boot() {
        context = JSContext(virtualMachine: JSVirtualMachine())
        context.name = "AuTomeDo engine"
        context.exceptionHandler = { [weak self] _, exception in
            let message = exception?.toString() ?? "?"
            let stack = exception?.objectForKeyedSubscript("stack")?.toString() ?? ""
            NSLog("[engine] uncaught: %@\n%@", message, stack)
            self?.lastException = message
        }
        context.setObject(makeHost(), forKeyedSubscript: "host" as NSString)
        guard let url = Bundle(for: Engine.self).url(forResource: "engine", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            loadError = "engine.js 不在 App 里（构建时要先 npm run build -w @automedo/native）"
            return
        }
        context.evaluateScript(source, withSourceURL: url)
        automedo = context.objectForKeyedSubscript("Automedo")
        let started = automedo.invokeMethod("start", withArguments: [])?.toString() ?? "{}"
        if let info = try? JSONSerialization.jsonObject(with: Data(started.utf8)) as? [String: Any] {
            loadError = info["loadError"] as? String
        }
    }

    private func fail(_ message: String) {
        guard let ctx = JSContext.current() else { return }
        ctx.exception = JSValue(newErrorFromMessage: message, in: ctx)
    }

    /// The `host` object of host.ts. Every function runs on `queue` (it is called from JS).
    private func makeHost() -> JSValue {
        let host = JSValue(newObjectIn: context)!
        func set(_ name: String, _ block: Any) {
            host.setObject(block, forKeyedSubscript: name as NSString)
        }

        let log: @convention(block) (String, String) -> Void = { level, message in
            NSLog("[engine %@] %@", level, message)
        }
        let readDoc: @convention(block) () -> String? = { [paths] in
            try? String(contentsOf: paths.doc, encoding: .utf8)
        }
        let writeDoc: @convention(block) (String) -> Void = { [weak self, paths] text in
            do {
                try FileManager.default.createDirectory(at: paths.doc.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(text.utf8).write(to: paths.doc, options: [.atomic])
            } catch {
                self?.fail("保存失败：\(error.localizedDescription)")
            }
        }
        let saveAside: @convention(block) (String, String) -> Void = { [weak self, paths] label, text in
            do {
                try FileManager.default.createDirectory(at: paths.aside, withIntermediateDirectories: true)
                let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
                let name = "\(label.filter { $0.isLetter || $0.isNumber || $0 == "-" })-\(stamp)-\(UUID().uuidString.prefix(6)).json"
                try Data(text.utf8).write(to: paths.aside.appendingPathComponent(name), options: [.atomic])
            } catch {
                self?.fail("另存失败：\(error.localizedDescription)")
            }
        }
        let getItem: @convention(block) (String) -> String? = { [defaults] key in
            defaults.string(forKey: "automedo.\(key)")
        }
        let setItem: @convention(block) (String, JSValue) -> Void = { [defaults] key, value in
            if value.isNull || value.isUndefined {
                defaults.removeObject(forKey: "automedo.\(key)")
            } else {
                defaults.set(value.toString(), forKey: "automedo.\(key)")
            }
        }
        let setTimer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in
            self?.startTimer(id, ms)
        }
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: id)?.cancel()
        }
        let fetch: @convention(block) (Int, String, String, String, JSValue) -> Void = { [weak self] id, url, method, headers, body in
            self?.startRequest(id, url: url, method: method, headersJSON: headers, body: body.isNull || body.isUndefined ? nil : body.toString())
        }
        let cancelFetch: @convention(block) (Int) -> Void = { [weak self] id in
            self?.requests.removeValue(forKey: id)?.cancel()
        }
        let reply: @convention(block) (Int, String) -> Void = { [weak self] id, json in
            self?.replies.removeValue(forKey: id)?.resume(returning: Data(json.utf8))
        }
        let changed: @convention(block) () -> Void = { [weak self] in
            DispatchQueue.main.async { self?.onChange?() }
        }

        set("log", log)
        set("readDoc", readDoc)
        set("writeDoc", writeDoc)
        set("saveAside", saveAside)
        set("getItem", getItem)
        set("setItem", setItem)
        set("setTimer", setTimer)
        set("clearTimer", clearTimer)
        set("fetch", fetch)
        set("cancelFetch", cancelFetch)
        set("reply", reply)
        set("changed", changed)
        return host
    }

    private func startTimer(_ id: Int, _ ms: Double) {
        let item = DispatchWorkItem { [weak self] in
            // A cleared timer is gone from the table; an interval re-arms itself from JS.
            guard let self, self.timers.removeValue(forKey: id) != nil else { return }
            self.automedo.invokeMethod("timer", withArguments: [id])
        }
        timers[id] = item
        queue.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: item)
    }

    private func startRequest(_ id: Int, url: String, method: String, headersJSON: String, body: String?) {
        guard let target = URL(string: url) else {
            automedo.invokeMethod("fetched", withArguments: [id, 0, "{}", NSNull(), "地址无效：\(url)"])
            return
        }
        var request = URLRequest(url: target, timeoutInterval: 60)
        request.httpMethod = method
        if let headers = try? JSONSerialization.jsonObject(with: Data(headersJSON.utf8)) as? [String: String] {
            for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        }
        if let body { request.httpBody = Data(body.utf8) }
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async {
                guard self.requests.removeValue(forKey: id) != nil else { return } // cancelled by JS
                let http = response as? HTTPURLResponse
                var headers: [String: String] = [:]
                for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k)] = String(describing: v) }
                let headersOut = (try? JSONSerialization.data(withJSONObject: headers)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                let text: Any = data.map { String(decoding: $0, as: UTF8.self) } ?? NSNull()
                let failure: Any = error.map { $0.localizedDescription } ?? NSNull()
                self.automedo.invokeMethod("fetched", withArguments: [id, http?.statusCode ?? 0, headersOut, text, failure])
            }
        }
        requests[id] = task
        task.resume()
    }
}
