import Foundation

/// The App Group shared by the app and its widget.
///
/// Signed with a free Apple ID (Sideloadly, AltStore, SideStore), the group is renamed to
/// one unique to that account, so the declared name cannot be relied on. In order:
/// 1. AltStore / SideStore write the groups they registered into Info.plist (ALTAppGroups);
/// 2. otherwise the provisioning profile the signer embedded lists the groups granted;
/// 3. otherwise (Xcode with a team of one's own) the declared name.
/// The app and the widget each read their own bundle, which the signer treats alike.
enum AppGroup {
    static let declared = "group.app.automedo.ios"

    static let id: String = {
        if let groups = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String], let first = groups.first {
            return first
        }
        return profileGroups().first ?? declared
    }()

    static var defaults: UserDefaults? { UserDefaults(suiteName: id) }

    /// `com.apple.security.application-groups` of embedded.mobileprovision (a plist inside a CMS envelope).
    static func profileGroups() -> [String] {
        guard
            let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
            let data = try? Data(contentsOf: url),
            let start = data.range(of: Data("<?xml".utf8)),
            let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
            let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any],
            let groups = entitlements["com.apple.security.application-groups"] as? [String]
        else { return [] }
        return groups
    }
}
