import XCTest
@testable import AuTomeDo

/// The real bridge: engine.js in JavaScriptCore, host functions in Swift (Engine.swift).
final class EngineTests: XCTestCase {
    private func temp() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("engine-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func engine(_ dir: URL) -> Engine {
        Engine(paths: .init(doc: dir.appendingPathComponent("state.json"), aside: dir.appendingPathComponent("aside")), defaults: UserDefaults(suiteName: "tests.\(UUID().uuidString)")!)
    }

    func testCommandsViewAndSaveThroughHostTimers() async throws {
        let dir = temp()
        let e = engine(dir)
        XCTAssertNil(e.loadError)
        let created = await e.decode(ActionResult.self, "execute", ["input": "/plan 原生版"])
        XCTAssertEqual(created?.text?.contains("原生版"), true)
        _ = await e.call("execute", ["input": "写测试"])
        let view = await e.decode(ViewModel.self, "view")
        XCTAssertEqual(view?.ws?.title, "原生版")
        XCTAssertEqual(view?.ws?.tasks.map(\.title), ["写测试"])
        XCTAssertFalse(view?.timeline.isEmpty ?? true)
        // The store saves after a 150 ms debounce: a timer run by GCD on the engine queue.
        try await Task.sleep(nanoseconds: 800_000_000)
        let doc = try String(contentsOf: dir.appendingPathComponent("state.json"), encoding: .utf8)
        XCTAssertTrue(doc.contains("原生版"))
        // Another launch reads it back.
        let again = await engine(dir).decode(ViewModel.self, "view")
        XCTAssertEqual(again?.ws?.title, "原生版")
        XCTAssertNil(e.lastException)
    }

    func testFableAsksToSplitAndTheFormRunsTheRefusedSwitch() async throws {
        let e = engine(temp())
        _ = await e.call("execute", ["input": "/plan P"])
        _ = await e.call("execute", ["input": "配色"])
        let first = await e.decode(ViewModel.self, "view")
        let task = try XCTUnwrap(first?.ws?.tasks.first)
        _ = await e.call("act", ["kind": "start", "taskId": task.id])
        let refused = await e.decode(ActionResult.self, "execute", ["input": "/model fable"])
        guard case let .form(form)? = refused?.intent else { return XCTFail("expected the split form, got \(String(describing: refused))") }
        XCTAssertEqual(form.fields.map(\.key), ["doneWhen", "steps", "start", "risk"])
        let done = await e.decode(ActionResult.self, "submitForm", ["id": form.id, "values": ["doneWhen": "能用", "steps": "选字体；定主色", "start": "1 2", "risk": ""]])
        XCTAssertNotEqual(done?.error, true)
        let after = await e.decode(ViewModel.self, "view")
        let view = try XCTUnwrap(after)
        XCTAssertEqual(view.status.tierLabel, "Fable")
        XCTAssertEqual(view.status.lanes, 2)
        XCTAssertEqual(view.ws?.tasks.filter(\.sub).map(\.title), ["选字体", "定主色"])
    }

    func testANetworkFailureComesBackThroughFetch() async throws {
        let e = engine(temp())
        let form = await e.decode(ActionResult.self, "execute", ["input": "/sync"])
        guard case let .form(spec)? = form?.intent else { return XCTFail("expected the sync form") }
        // Nothing listens on port 9: URLSession fails, the engine's fetch rejects, the form says why.
        let r = await e.decode(ActionResult.self, "submitForm", ["id": spec.id, "values": ["url": "http://127.0.0.1:9", "token": "x"]])
        XCTAssertEqual(r?.error, true)
        XCTAssertFalse((r?.text ?? "").isEmpty)
    }

    func testAnUnreadableDocumentIsKeptAside() throws {
        let dir = temp()
        try Data("{\"plans\":[".utf8).write(to: dir.appendingPathComponent("state.json"))
        let e = engine(dir)
        XCTAssertNotNil(e.loadError)
        let aside = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("aside").path)
        XCTAssertEqual(aside.count, 1)
    }

    func testTheWidgetSnapshotDecodes() async throws {
        let e = engine(temp())
        _ = await e.call("seedDemo")
        let data = await e.call("glance")
        let glance = try XCTUnwrap(Glance.decode(String(decoding: data, as: UTF8.self)))
        XCTAssertNotNil(glance.ws)
        let reminders = await e.decode([Reminder].self, "reminders")
        XCTAssertNotNil(reminders)
    }
}
