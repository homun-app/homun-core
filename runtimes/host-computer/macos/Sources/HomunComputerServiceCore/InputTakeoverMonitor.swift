import CoreGraphics
import Foundation

public enum PhysicalInputKind: Equatable, Sendable {
    case mouseDown
    case scroll
    case keyDown
}

public final class SystemInputEventTap: @unchecked Sendable {
    private let monitor: InputTakeoverMonitor
    private var tap: CFMachPort?

    public init(monitor: InputTakeoverMonitor) {
        self.monitor = monitor
    }

    public func start() -> Bool {
        let types: [CGEventType] = [
            .leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context = Unmanaged.passUnretained(monitor).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<InputTakeoverMonitor>.fromOpaque(context).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    monitor.disableMutationCapability()
                    return Unmanaged.passUnretained(event)
                }
                let marker = event.getIntegerValueField(.eventSourceUserData)
                let kind: PhysicalInputKind = type == .keyDown
                    ? .keyDown
                    : (type == .scrollWheel ? .scroll : .mouseDown)
                monitor.observe(kind: kind, sourceUserData: marker)
                return Unmanaged.passUnretained(event)
            },
            userInfo: context
        ) else {
            monitor.disableMutationCapability()
            return false
        }
        self.tap = tap
        Thread.detachNewThread { [self] in
            guard let tap = self.tap else { return }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()
        }
        return true
    }
}

public enum TakeoverPhase: String, Equatable, Sendable {
    case active
    case pausedByUser
    case hostLocked
    case monitorUnavailable
}

public final class InputTakeoverMonitor: @unchecked Sendable {
    private let lock = NSLock()
    public let eventMarker: Int64
    private var storedPhase: TakeoverPhase = .pausedByUser
    private var resumeToken: String?

    public init(eventMarker: Int64) {
        self.eventMarker = eventMarker
    }

    public var phase: TakeoverPhase {
        lock.withLock { storedPhase }
    }

    public func resume(token: String) {
        lock.withLock {
            guard storedPhase != .hostLocked, storedPhase != .monitorUnavailable else { return }
            resumeToken = token
            storedPhase = .active
        }
    }

    public func accepts(token: String) -> Bool {
        lock.withLock { storedPhase == .active && resumeToken == token }
    }

    public func observe(kind: PhysicalInputKind, sourceUserData: Int64) {
        guard sourceUserData != eventMarker else { return }
        lock.withLock {
            _ = kind
            resumeToken = nil
            storedPhase = .pausedByUser
        }
    }

    public func hostLocked() {
        lock.withLock {
            resumeToken = nil
            storedPhase = .hostLocked
        }
    }

    public func hostUnlocked() {
        lock.withLock {
            resumeToken = nil
            storedPhase = .pausedByUser
        }
    }

    public func disableMutationCapability() {
        lock.withLock {
            resumeToken = nil
            storedPhase = .monitorUnavailable
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
