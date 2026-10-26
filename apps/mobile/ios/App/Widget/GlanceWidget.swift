import SwiftUI
import WidgetKit

/// Home / lock screen widget: the task in progress, its steps and lanes, today's budget.
struct GlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AutomedoGlance", provider: GlanceProvider()) { entry in
            GlanceWidgetView(entry: entry)
        }
        .configurationDisplayName("AuTomeDo")
        .description("当前任务、并行的子任务和今日预算")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct GlanceEntry: TimelineEntry {
    let date: Date
    let glance: Glance?
}

struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: .now, glance: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: .now, glance: GlanceStore.load() ?? (context.isPreview ? .sample : nil)))
    }

    /// The app reloads the widget whenever something changes; the only change of its own is
    /// midnight, when today's usage starts again from 0.
    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        let glance = GlanceStore.load()
        let now = Date()
        let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now.addingTimeInterval(86_400)
        let entries = [GlanceEntry(date: now, glance: glance), GlanceEntry(date: midnight, glance: glance)]
        completion(Timeline(entries: entries, policy: .after(midnight.addingTimeInterval(3600))))
    }
}

struct GlanceWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        Group {
            if let g = entry.glance {
                switch family {
                case .systemMedium: MediumGlance(g: g, date: entry.date)
                case .accessoryRectangular: RectangularGlance(g: g, date: entry.date)
                default: SmallGlance(g: g, date: entry.date)
                }
            } else {
                NoGlance()
            }
        }
        .containerBackground(for: .widget) {
            family == .accessoryRectangular ? Color.clear : Theme.bg
        }
    }
}

// MARK: - pieces

private struct Header: View {
    let g: Glance

    var body: some View {
        HStack(spacing: 4) {
            Text("✻").foregroundStyle(Theme.accent)
            Text(g.tierLabel).foregroundStyle(Theme.tier(g.tier)).fontWeight(.bold)
            if g.tier == "fable" && g.lanes > 1 {
                Text("×\(g.lanes)").foregroundStyle(Theme.pink)
            }
            Spacer(minLength: 0)
            if let s = g.session {
                Text(Date(ms: s.startedAt), style: .timer)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: 56, alignment: .trailing)
            }
        }
        .font(Theme.mono(11))
        .lineLimit(1)
    }
}

private struct TaskBlock: View {
    let g: Glance

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let t = g.task {
                Text(t.title)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Theme.accent)
                    .lineLimit(2)
                if let steps = t.steps {
                    HStack(spacing: 4) {
                        Text("\(steps.done)/\(steps.total) 步").foregroundStyle(Theme.dim)
                        if t.running.count > 1 {
                            Text("并行 \(t.running.count) 路").foregroundStyle(Theme.pink)
                        }
                    }
                    .font(Theme.mono(11))
                }
            } else if let next = g.next.first {
                Text("下一个").font(Theme.mono(11)).foregroundStyle(Theme.dim)
                Text(next.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(2)
            } else {
                Text(g.ws == nil ? "还没有计划" : "没有待办").font(.system(size: 14)).foregroundStyle(Theme.dim)
            }
        }
    }
}

private struct Budget: View {
    let g: Glance
    let date: Date

    var body: some View {
        let used = g.used(on: date)
        let level = used == g.used ? g.level : "ok"
        VStack(alignment: .leading, spacing: 3) {
            ProgressView(value: min(used, g.budget), total: max(g.budget, 1))
                .tint(level == "ok" ? Theme.fg2 : Theme.budget(level))
            Text("\(fmtTokens(used)) / \(fmtTokens(g.budget))")
                .font(Theme.mono(10))
                .foregroundStyle(Theme.budget(level))
        }
    }
}

private struct SmallGlance: View {
    let g: Glance
    let date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Header(g: g)
            Spacer(minLength: 0)
            TaskBlock(g: g)
            Spacer(minLength: 0)
            Budget(g: g, date: date)
        }
    }
}

private struct MediumGlance: View {
    let g: Glance
    let date: Date

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SmallGlance(g: g, date: date)
            VStack(alignment: .leading, spacing: 4) {
                if let ws = g.ws {
                    Text(ws.title).font(Theme.mono(11)).foregroundStyle(ws.kind == "plan" ? Color(hex: 0x4FB3A6) : Theme.violet).lineLimit(1)
                }
                ForEach(g.task?.running ?? [], id: \.self) { t in row("◼", t, Theme.accent) }
                ForEach(g.next.prefix(max(0, 4 - (g.task?.running.count ?? 0))), id: \.self) { t in row("☐", t, Theme.fg) }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func row(_ glyph: String, _ t: Glance.TaskRef, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Text(glyph).foregroundStyle(color)
            Text(t.title).foregroundStyle(color).lineLimit(1)
            Text("#\(t.num)").foregroundStyle(Theme.faint)
        }
        .font(.system(size: 12))
    }
}

private struct RectangularGlance: View {
    let g: Glance
    let date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(g.task?.title ?? g.next.first.map { "下一个：\($0.title)" } ?? "AuTomeDo")
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1)
            HStack(spacing: 4) {
                if let steps = g.task?.steps { Text("\(steps.done)/\(steps.total) 步") }
                Text("\(fmtTokens(g.used(on: date)))/\(fmtTokens(g.budget))")
            }
            .font(Theme.mono(11))
            if let s = g.session {
                Text(Date(ms: s.startedAt), style: .timer).font(Theme.mono(11)).monospacedDigit()
            }
        }
    }
}

/// No snapshot: the app was not opened yet, or the App Group did not work out.
private struct NoGlance: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("✻ AuTomeDo").font(Theme.mono(12, .bold)).foregroundStyle(Theme.accent)
            Text("打开一次 App 后显示").font(.system(size: 12)).foregroundStyle(Theme.dim)
            Text(AppGroup.id).font(Theme.mono(8)).foregroundStyle(Theme.faint).lineLimit(2)
        }
    }
}

extension Glance {
    static let sample = Glance.decode("""
    {"v":1,"at":0,"day":0,"budget":200000,"used":27400,"level":"ok","tier":"fable","tierLabel":"Fable","effort":"medium","fatigue":null,"lanes":2,
     "ws":{"kind":"plan","title":"个人网站改版"},
     "task":{"title":"确定字体与配色","num":4,"steps":{"done":0,"total":3},"running":[{"title":"选字体","num":5},{"title":"定主色","num":6}]},
     "next":[{"title":"做样张","num":7},{"title":"搭建 Astro 项目","num":8}],"session":null}
    """)
}
