import SwiftUI

/// Today's tokens against the daily budget, as a ring in the navigation bar.
struct UsageRing: View {
    let used: Double
    let budget: Double
    let level: String

    var body: some View {
        let ratio = budget > 0 ? min(1, used / budget) : 0
        ZStack {
            Circle().stroke(Theme.faint.opacity(0.45), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: max(ratio, 0.02))
                .stroke(Self.color(level), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 20, height: 20)
        .accessibilityLabel("今日 Token \(fmtTokens(used)) / \(fmtTokens(budget))")
    }

    static func color(_ level: String) -> Color {
        switch level {
        case "ok": return Theme.blue
        case "warn": return Theme.yellow
        default: return Theme.red
        }
    }
}

/// The ring, opening today's numbers, the HIE advice and the budget.
struct UsageMenu: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let st = model.view?.status {
            Menu {
                Section("今日 Token") {
                    Text("\(fmtTokens(st.used)) / \(fmtTokens(st.budget))（\(st.budget > 0 ? Int((st.used / st.budget * 100).rounded()) : 0)%）")
                    if let advice = st.advice { Text(advice.textGlyphs) }
                }
                Button { model.prompt("/budget ") } label: { Label("设置每日预算", systemImage: "slider.horizontal.3") }
                Button { Task { await model.review(0) } } label: { Label("本周回顾", systemImage: "calendar") }
            } label: {
                UsageRing(used: st.used, budget: st.budget, level: st.level)
            }
        }
    }
}

extension View {
    /// The navigation bar: plan/goal on the left; on the right the usage ring in its own
    /// glass circle (iOS 26), then the other buttons grouped.
    @ViewBuilder
    func appToolbar<Leading: ToolbarContent, Ring: ToolbarContent, Trailing: ToolbarContent>(
        @ToolbarContentBuilder leading: () -> Leading,
        @ToolbarContentBuilder ring: () -> Ring,
        @ToolbarContentBuilder trailing: () -> Trailing
    ) -> some View {
        if #available(iOS 26.0, *) {
            toolbar {
                leading()
                ring()
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                trailing()
            }
        } else {
            toolbar {
                leading()
                ring()
                trailing()
            }
        }
    }
}
