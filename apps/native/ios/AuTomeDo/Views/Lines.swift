import SwiftUI

extension Color {
    /// "#rrggbb" from the engine's coloured lines.
    init?(hexString: String?) {
        guard let s = hexString, s.hasPrefix("#"), s.count == 7, let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
        self.init(hex: v)
    }
}

extension Line {
    var attributed: AttributedString {
        var out = AttributedString()
        for seg in self {
            var run = AttributedString(seg.t)
            run.foregroundColor = Color(hexString: seg.c) ?? Theme.fg
            if let bg = Color(hexString: seg.bg) { run.backgroundColor = bg }
            if seg.b == true { run.inlinePresentationIntent = .stronglyEmphasized }
            if seg.s == true { run.strikethroughStyle = .single }
            out += run
        }
        return out
    }

    var plain: String { map(\.t).joined() }
}

/// Lines of the terminal version (timeline, review, help…), drawn with their colours.
struct LinesView: View {
    let lines: [Line]
    var size: CGFloat = 12.5

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? AttributedString(" ") : line.attributed)
                    .font(Theme.mono(size))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .textSelection(.enabled)
    }
}

struct LinesSheet: View {
    let title: String
    let lines: [Line]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LinesView(lines: lines).padding()
            }
            .background(Theme.bg)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

/// The plan/goal's history, newest at the bottom, as in the terminal.
struct TimelineSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(model.view?.timeline ?? []) { block in
                            LinesView(lines: block.lines).id(block.id)
                        }
                    }
                    .padding()
                }
                .onAppear {
                    if let last = model.view?.timeline.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .background(Theme.bg)
            .navigationTitle(model.view?.ws?.title ?? "日志")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

struct ReviewSheet: View {
    let review: ReviewSpec
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LinesView(lines: review.lines, size: 12).padding()
            }
            .background(Theme.bg)
            .navigationTitle(review.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button { Task { await model.review(review.offset - 1) } } label: { Label("上一周", systemImage: "chevron.left") }
                    Spacer()
                    ShareLink(item: review.markdown) { Label("Markdown", systemImage: "square.and.arrow.up") }
                    Spacer()
                    Button { Task { await model.review(review.offset + 1) } } label: { Label("下一周", systemImage: "chevron.right") }
                        .disabled(review.offset >= 0)
                }
            }
        }
    }
}
