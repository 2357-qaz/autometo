import ActivityKit
import SwiftUI
import WidgetKit

/// Lock screen and Dynamic Island while a focus session runs.
struct SessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionAttributes.self) { context in
            LockScreenSession(context: context)
                .padding(14)
                .activityBackgroundTint(Theme.bg)
                .activitySystemActionForegroundColor(Theme.fg)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TierLine(state: context.state).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(since: context.attributes.startedAt).foregroundStyle(Theme.accent).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.intent.isEmpty ? (context.state.task ?? "专注中") : context.state.intent)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        PlannedProgress(start: context.attributes.startedAt, end: context.state.plannedEnd)
                        TokenLine(state: context.state)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Text("✻").foregroundStyle(Theme.tier(context.state.tier))
            } compactTrailing: {
                Elapsed(since: context.attributes.startedAt)
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: 48)
            } minimal: {
                Text("✻").foregroundStyle(Theme.tier(context.state.tier))
            }
            .keylineTint(Theme.accent)
        }
    }
}

private struct LockScreenSession: View {
    let context: ActivityViewContext<SessionAttributes>

    var body: some View {
        let state = context.state
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("✻ 专注中").font(Theme.mono(12, .bold)).foregroundStyle(Theme.accent)
                Text(state.intent.isEmpty ? (state.task ?? "") : state.intent)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.fg)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Elapsed(since: context.attributes.startedAt).font(Theme.mono(15, .semibold)).foregroundStyle(Theme.accent)
            }
            HStack(spacing: 6) {
                TierLine(state: state)
                if let task = state.task, !state.intent.isEmpty, task != state.intent {
                    Text("· \(task)").foregroundStyle(Theme.dim).lineLimit(1)
                }
                if let steps = state.steps {
                    Text("· \(steps)").foregroundStyle(Theme.dim)
                }
            }
            .font(Theme.mono(12))
            PlannedProgress(start: context.attributes.startedAt, end: state.plannedEnd)
            TokenLine(state: state)
        }
    }
}

private struct Elapsed: View {
    let since: Date

    var body: some View {
        Text(since, style: .timer)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
    }
}

private struct TierLine: View {
    let state: SessionAttributes.ContentState

    var body: some View {
        HStack(spacing: 4) {
            Text(state.tierLabel).fontWeight(.bold).foregroundStyle(Theme.tier(state.tier))
            if state.tier == "fable" && state.lanes > 1 {
                Text("×\(state.lanes) 路").foregroundStyle(Theme.pink)
            }
            Text(state.effort).foregroundStyle(Theme.dim)
        }
        .font(Theme.mono(12))
        .lineLimit(1)
    }
}

/// Planned length as a bar that fills by itself; full once the plan is exceeded.
private struct PlannedProgress: View {
    let start: Date
    let end: Date

    var body: some View {
        ProgressView(timerInterval: start...max(end, start.addingTimeInterval(60)), countsDown: false) {
            EmptyView()
        } currentValueLabel: {
            EmptyView()
        }
        .tint(Theme.accent)
    }
}

private struct TokenLine: View {
    let state: SessionAttributes.ContentState

    var body: some View {
        HStack(spacing: 4) {
            Text("↑ \(fmtTokens(state.tokens)) tokens").foregroundStyle(Theme.fg2)
            Text("截至").foregroundStyle(Theme.faint)
            Text(state.tokensAt, style: .time).foregroundStyle(Theme.faint)
            Spacer(minLength: 4)
            Text("≈\(fmtTokens(state.rate))/min").foregroundStyle(Theme.dim)
        }
        .font(Theme.mono(11))
        .lineLimit(1)
    }
}
