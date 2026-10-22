import SwiftUI

/// The terminal palette of the web app (apps/web/src/styles.css).
enum Theme {
    static let bg = Color(hex: 0x141413)
    static let panel = Color(hex: 0x201F1D)
    static let fg = Color(hex: 0xE8E6DC)
    static let fg2 = Color(hex: 0xC2BFB4)
    static let dim = Color(hex: 0x8B887F)
    static let faint = Color(hex: 0x5F5C55)
    static let accent = Color(hex: 0xD97757)
    static let green = Color(hex: 0x6FBF73)
    static let red = Color(hex: 0xEF6F6C)
    static let yellow = Color(hex: 0xE5B85C)
    static let violet = Color(hex: 0xA68CF2)
    static let pink = Color(hex: 0xE38FB7)

    static func tier(_ tier: String) -> Color {
        switch tier {
        case "haiku": return green
        case "sonnet": return accent
        case "opus": return violet
        case "fable": return pink
        default: return fg
        }
    }

    static func budget(_ level: String) -> Color {
        switch level {
        case "warn": return yellow
        case "low", "over": return red
        default: return dim
        }
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
