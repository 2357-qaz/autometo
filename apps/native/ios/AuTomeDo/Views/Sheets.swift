import SwiftUI

/// A form of the terminal version (apps/tui/src/forms.ts), drawn natively.
struct FormSheet: View {
    let form: FormSpec
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: FieldValue]
    @State private var error: String?
    @State private var busy = false
    @State private var submitted = false

    init(form: FormSpec) {
        self.form = form
        var v: [String: FieldValue] = [:]
        for f in form.fields {
            switch f.kind {
            case "slider": v[f.key] = f.initial ?? .number(0)
            case "confirm": v[f.key] = f.initial ?? .bool(false)
            case "select": v[f.key] = f.initial ?? .string(f.options?.first?.value ?? "")
            default: v[f.key] = f.initial.map { .string($0.text) } ?? .string("")
            }
        }
        _values = State(initialValue: v)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let desc = form.desc, !desc.isEmpty {
                    Section { Text(desc).font(.footnote).foregroundStyle(Theme.dim) }
                }
                ForEach(form.fields) { field in
                    fieldView(field)
                }
                if let error {
                    Section { Text("⎿ \(error)").font(.footnote).foregroundStyle(Theme.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(form.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "…" : "确认") { submit() }.disabled(busy).fontWeight(.semibold)
                }
            }
        }
        .onDisappear { if !submitted { model.cancel(form) } }
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder
    private func fieldView(_ f: Field) -> some View {
        switch f.kind {
        case "select":
            Section(f.label) {
                ForEach(f.options ?? [], id: \.self) { option in
                    Button { values[f.key] = .string(option.value) } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).foregroundStyle(Theme.fg)
                                if let hint = option.hint, !hint.isEmpty { Text(hint).font(.caption).foregroundStyle(Theme.dim) }
                            }
                            Spacer()
                            if values[f.key]?.text == option.value { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                        }
                    }
                }
            }
        case "slider":
            Section(f.label) {
                HStack {
                    Slider(value: number(f.key), in: 0...100, step: f.step ?? 1)
                    Text("\(Int(number(f.key).wrappedValue))%").font(Theme.mono(13)).frame(width: 48, alignment: .trailing)
                }
            }
        case "confirm":
            Section { Toggle(f.label, isOn: flag(f.key)) }
        case "editor":
            Section(f.label) {
                TextEditor(text: text(f.key)).font(Theme.mono(13)).frame(minHeight: 280)
            }
        default:
            Section(f.label) {
                if f.secret == true {
                    SecureField(f.placeholder ?? "", text: text(f.key))
                } else {
                    TextField(f.placeholder ?? "", text: text(f.key), axis: .vertical)
                        .textInputAutocapitalization(.never)
                }
            }
        }
    }

    private func text(_ key: String) -> Binding<String> {
        Binding(get: { values[key]?.text ?? "" }, set: { values[key] = .string($0) })
    }

    private func number(_ key: String) -> Binding<Double> {
        Binding(get: { if case let .number(n)? = values[key] { return n } else { return 0 } }, set: { values[key] = .number($0) })
    }

    private func flag(_ key: String) -> Binding<Bool> {
        Binding(get: { if case let .bool(b)? = values[key] { return b } else { return false } }, set: { values[key] = .bool($0) })
    }

    private func submit() {
        for f in form.fields where f.required == true && (values[f.key]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = "请填写「\(f.label)」"
            return
        }
        busy = true
        error = nil
        let payload = values.mapValues(\.any)
        Task {
            let failure = await model.submit(form, payload)
            busy = false
            if let failure { error = failure } else { submitted = true }
        }
    }
}

/// One value out of a few: model tier, effort, fatigue.
struct PickSheet: View {
    let spec: PickSpec
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(spec.options.enumerated()), id: \.offset) { i, option in
                    Button { Task { await model.pick(spec, option.value) } } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).font(Theme.mono(15, .semibold)).foregroundStyle(spec.what == "tier" ? Theme.tier(option.value) : Theme.fg)
                                if let hint = option.hint { Text(hint).font(.caption).foregroundStyle(Theme.dim) }
                            }
                            Spacer()
                            if i == spec.current { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(spec.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// Plans and goals: open one, start a new one, delete one.
struct SwitcherSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                section("Plan", kind: "plan", color: Theme.teal, glyph: "⏸")
                section("Goal", kind: "goal", color: Theme.violet, glyph: "⏵⏵")
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("切换")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("新建 Plan") { Task { await model.open(["type": "newPlan"]) } }
                        Button("新建 Goal") { Task { await model.open(["type": "newGoal"]) } }
                    } label: { Image(systemName: "plus") }
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, kind: String, color: Color, glyph: String) -> some View {
        let items = (model.view?.workspaces ?? []).filter { $0.kind == kind }
        Section(title) {
            if items.isEmpty {
                Text("还没有").foregroundStyle(Theme.faint)
            }
            ForEach(items) { w in
                Button { Task { await model.select(w) } } label: {
                    HStack {
                        Text(glyph).foregroundStyle(color)
                        Text(w.title).foregroundStyle(w.status == "active" ? Theme.fg : Theme.dim)
                        if w.status != "active" { Text(w.status).font(.caption2).foregroundStyle(Theme.faint) }
                        Spacer()
                        Text(w.detail).font(Theme.mono(12)).foregroundStyle(Theme.dim)
                        if w.active { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                    }
                }
                .swipeActions {
                    Button(role: .destructive) { Task { await model.deleteWorkspace(w) } } label: { Label("删除", systemImage: "trash") }
                }
            }
        }
    }
}
