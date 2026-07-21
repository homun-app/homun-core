import HomunComputerProtocol

public enum ProtectedTargetFailure: Error, Equatable, Sendable {
    case protectedTarget
    case secureInputBlocked
    case terminalInputBlocked
}

public struct ProtectedTargetPolicy: Sendable {
    public static let protectedBundleIDs: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.SecurityAgent",
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
        "com.lastpass.LastPass",
        "com.dashlane.Dashlane",
    ]

    public static let terminalBundleIDs: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "dev.warp.Warp",
    ]

    public init() {}

    public func authorize(
        bundleID: String?,
        role: String,
        subrole: String?,
        action: SemanticAction
    ) throws {
        if role.localizedCaseInsensitiveContains("secure")
            || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
        {
            throw ProtectedTargetFailure.secureInputBlocked
        }
        if subrole?.localizedCaseInsensitiveContains("authorization") == true {
            throw ProtectedTargetFailure.protectedTarget
        }
        if let bundleID, Self.protectedBundleIDs.contains(bundleID) {
            throw ProtectedTargetFailure.protectedTarget
        }
        if let bundleID, Self.terminalBundleIDs.contains(bundleID) {
            throw ProtectedTargetFailure.terminalInputBlocked
        }
        _ = action
    }
}
