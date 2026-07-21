import ApplicationServices
import CoreGraphics
import Foundation
import HomunComputerProtocol

public protocol PermissionProbing: Sendable {
    func status() -> PermissionSnapshot
    func present(_ permission: HostPermission) -> PermissionSnapshot
}

public struct SystemPermissionProbe: PermissionProbing {
    public init() {}

    public func status() -> PermissionSnapshot {
        PermissionSnapshot(
            accessibility: AXIsProcessTrusted() ? .granted : .notDetermined,
            screenRecording: CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        )
    }

    public func present(_ permission: HostPermission) -> PermissionSnapshot {
        switch permission {
        case .accessibility:
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(options)
            let current = status()
            return PermissionSnapshot(
                accessibility: granted ? .granted : .denied,
                screenRecording: current.screenRecording
            )
        case .screenRecording:
            let granted = CGRequestScreenCaptureAccess()
            let current = status()
            return PermissionSnapshot(
                accessibility: current.accessibility,
                screenRecording: granted ? .granted : .denied
            )
        }
    }
}
