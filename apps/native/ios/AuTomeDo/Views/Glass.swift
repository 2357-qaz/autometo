import SwiftUI

/// Liquid Glass on iOS 26, a material with the same shape before it.
extension View {
    @ViewBuilder
    func glass<S: Shape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(Glass.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            background {
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    if let tint { shape.fill(tint) }
                    shape.stroke(Color.white.opacity(0.08), lineWidth: 1)
                }
            }
        }
    }

    /// A bar pinned to the bottom that content scrolls under (with the system's scroll
    /// edge effect on iOS 26; a fade into the background before it).
    @ViewBuilder
    func floatingBottomBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0, content: bar)
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) {
                bar().background {
                    LinearGradient(colors: [Theme.bg.opacity(0), Theme.bg.opacity(0.92), Theme.bg], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea()
                }
            }
        }
    }
}

/// Glass shapes close to each other blend and morph together (iOS 26).
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Plan / goal, as an SF Symbol in the mode's colour.
struct ModeIcon: View {
    let goal: Bool

    var body: some View {
        Image(systemName: goal ? "scope" : "checklist")
            .foregroundStyle(goal ? Theme.violet : Theme.teal)
    }
}

extension String {
    private static let glyphSwaps: [Unicode.Scalar: String] = ["\u{23FA}": "●", "\u{25FC}": "■", "\u{25B6}": "►", "\u{2733}": "✲"]
    private static let pinnedGlyphs: Set<Unicode.Scalar> = ["\u{23F8}", "\u{26A0}"]

    /// The terminal's glyphs that iOS would draw as colour emoji (⏸ ⏺ ◼ ▶ ✳ ⚠): swapped
    /// for a look-alike, or held to their text form, so they take the line's colour.
    var textGlyphs: String {
        guard unicodeScalars.contains(where: { Self.glyphSwaps[$0] != nil || Self.pinnedGlyphs.contains($0) }) else { return self }
        let scalars = Array(unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, s) in scalars.enumerated() {
            if let swap = Self.glyphSwaps[s] {
                out.append(contentsOf: swap.unicodeScalars)
                continue
            }
            out.append(s)
            let next = i + 1 < scalars.count ? scalars[i + 1] : nil
            if Self.pinnedGlyphs.contains(s), next != "\u{FE0E}", next != "\u{FE0F}" { out.append("\u{FE0E}") }
        }
        return String(out)
    }
}
