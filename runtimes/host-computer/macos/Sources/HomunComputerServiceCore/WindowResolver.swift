import Foundation
import HomunComputerProtocol

struct WindowRecord: Sendable {
    let ownerPID: Int32
    let windowID: UInt32
    let title: String?
    let bounds: HostRect
    let isOnScreen: Bool
    let isMinimized: Bool
    let displayID: UInt32?
}

enum WindowResolver {
    static func resolve(
        _ records: [WindowRecord],
        limit: Int
    ) -> ResolvedList<HostWindow> {
        let sorted = records.sorted {
            ($0.ownerPID, $0.windowID) < ($1.ownerPID, $1.windowID)
        }
        let bounded = sorted.prefix(max(0, limit)).map { record in
            HostWindow(
                identity: WindowIdentity(pid: record.ownerPID, windowID: record.windowID),
                title: record.title,
                bounds: record.bounds,
                isMinimized: record.isMinimized,
                isOnScreen: record.isOnScreen,
                displayID: record.displayID
            )
        }
        return ResolvedList(items: Array(bounded), truncated: sorted.count > bounded.count)
    }
}
