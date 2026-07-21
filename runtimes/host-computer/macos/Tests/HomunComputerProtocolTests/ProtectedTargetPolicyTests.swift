import HomunComputerProtocol
import Testing
@testable import HomunComputerServiceCore

@Test(arguments: [
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.1password.1password",
    "2BUA8C4S2C.com.1password.browser-helper",
    "com.bitwarden.desktop",
])
func protectedBundlesAreNeverMutable(bundleID: String) {
    #expect(throws: ProtectedTargetFailure.protectedTarget) {
        try ProtectedTargetPolicy().authorize(bundleID: bundleID, role: "AXButton", subrole: nil, action: .press)
    }
}

@Test(arguments: ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable"])
func terminalInputCannotBeReenabled(bundleID: String) {
    #expect(throws: ProtectedTargetFailure.terminalInputBlocked) {
        try ProtectedTargetPolicy().authorize(bundleID: bundleID, role: "AXTextArea", subrole: nil, action: .setValue)
    }
}

@Test func secureAndAuthorizationUIAreDeniedGenerically() {
    #expect(throws: ProtectedTargetFailure.secureInputBlocked) {
        try ProtectedTargetPolicy().authorize(bundleID: "example.app", role: "AXSecureTextField", subrole: nil, action: .press)
    }
    #expect(throws: ProtectedTargetFailure.protectedTarget) {
        try ProtectedTargetPolicy().authorize(bundleID: "example.app", role: "AXDialog", subrole: "AXAuthorizationDialog", action: .press)
    }
}

@Test func ordinaryApplicationControlsRemainAllowed() throws {
    try ProtectedTargetPolicy().authorize(bundleID: "com.apple.TextEdit", role: "AXButton", subrole: nil, action: .press)
}
