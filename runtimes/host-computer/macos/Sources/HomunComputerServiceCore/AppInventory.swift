import AppKit
import CoreGraphics
import Foundation
import HomunComputerProtocol

protocol AppInventoryProviding: Sendable {
    func listApplications(includeBackground: Bool) -> ResolvedList<HostApplication>
    func listWindows() -> ResolvedList<HostWindow>
}

struct SystemAppInventory: AppInventoryProviding {
    func listApplications(includeBackground: Bool) -> ResolvedList<HostApplication> {
        let records = NSWorkspace.shared.runningApplications.map(RunningApplicationRecord.init)
        return ApplicationResolver.resolve(
            records,
            includeBackground: includeBackground,
            limit: 500
        )
    }

    func listWindows() -> ResolvedList<HostWindow> {
        let rawWindows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], 0)
            as? [[String: Any]] ?? []
        let records = rawWindows.compactMap { raw -> WindowRecord? in
            guard
                let pid = (raw["kCGWindowOwnerPID"] as? NSNumber)?.int32Value,
                let windowID = (raw["kCGWindowNumber"] as? NSNumber)?.uint32Value,
                let boundsDictionary = raw["kCGWindowBounds"] as? NSDictionary,
                let rect = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary)
            else { return nil }
            let onScreen = (raw["kCGWindowIsOnscreen"] as? NSNumber)?.boolValue ?? false
            return WindowRecord(
                ownerPID: pid,
                windowID: windowID,
                title: raw["kCGWindowName"] as? String,
                bounds: HostRect(
                    x: rect.origin.x,
                    y: rect.origin.y,
                    width: rect.width,
                    height: rect.height
                ),
                isOnScreen: onScreen,
                isMinimized: !onScreen,
                displayID: nil
            )
        }
        return WindowResolver.resolve(records, limit: 1_000)
    }
}
