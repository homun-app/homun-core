import AppKit
import Foundation

public final class HostSessionMonitor: @unchecked Sendable {
    private let takeover: InputTakeoverMonitor
    private var observers: [NSObjectProtocol] = []

    public init(takeover: InputTakeoverMonitor) {
        self.takeover = takeover
    }

    public func start() {
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: nil
        ) { [takeover] _ in takeover.hostLocked() })
        observers.append(distributed.addObserver(
            forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: nil
        ) { [takeover] _ in takeover.hostUnlocked() })
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: nil
        ) { [takeover] _ in takeover.hostLocked() })
        observers.append(workspace.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: nil
        ) { [takeover] _ in takeover.hostUnlocked() })
    }

    deinit {
        for observer in observers {
            DistributedNotificationCenter.default().removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
    }
}
