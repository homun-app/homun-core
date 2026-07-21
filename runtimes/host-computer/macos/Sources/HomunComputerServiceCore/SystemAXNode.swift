import ApplicationServices
import Foundation
import HomunComputerProtocol

public final class SystemAXNode: AXActionTarget {
    public let element: AXUIElement

    public init(element: AXUIElement) {
        self.element = element
    }

    public var role: String { stringAttribute("AXRole") ?? "AXUnknown" }
    public var subrole: String? { stringAttribute("AXSubrole") }
    public var label: String? {
        stringAttribute("AXTitle") ?? stringAttribute("AXDescription")
    }
    public var help: String? { stringAttribute("AXHelp") }
    public var value: String? {
        guard !role.localizedCaseInsensitiveContains("secure") else { return nil }
        return stringAttribute("AXValue")
    }
    public var bounds: HostRect? {
        guard
            let position = pointAttribute("AXPosition"),
            let size = sizeAttribute("AXSize")
        else { return nil }
        return HostRect(
            x: Double(position.x),
            y: Double(position.y),
            width: Double(size.width),
            height: Double(size.height)
        )
    }
    public var enabled: Bool { boolAttribute("AXEnabled") ?? true }
    public var focused: Bool { boolAttribute("AXFocused") ?? false }
    public var selected: Bool? { boolAttribute("AXSelected") }
    public var expanded: Bool? { boolAttribute("AXExpanded") }
    public var actionNames: [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }
    public var children: [any AXNodeSource] {
        guard let children = attribute("AXChildren") as? [AXUIElement] else { return [] }
        return children.map(SystemAXNode.init(element:))
    }

    public func perform(actionNamed name: String) throws {
        guard AXUIElementPerformAction(element, name as CFString) == .success else {
            throw ActionFailure.nativeActionFailed
        }
    }

    public func setStringValue(_ value: String) throws {
        guard AXUIElementSetAttributeValue(element, "AXValue" as CFString, value as CFTypeRef) == .success else {
            throw ActionFailure.nativeActionFailed
        }
    }

    private func attribute(_ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    private func stringAttribute(_ name: String) -> String? {
        attribute(name) as? String
    }

    private func boolAttribute(_ name: String) -> Bool? {
        (attribute(name) as? NSNumber)?.boolValue
    }

    private func pointAttribute(_ name: String) -> CGPoint? {
        guard let rawValue = attribute(name), CFGetTypeID(rawValue) == AXValueGetTypeID() else {
            return nil
        }
        let value = unsafeDowncast(rawValue, to: AXValue.self)
        guard AXValueGetType(value) == .cgPoint else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value, .cgPoint, &point) ? point : nil
    }

    private func sizeAttribute(_ name: String) -> CGSize? {
        guard let rawValue = attribute(name), CFGetTypeID(rawValue) == AXValueGetTypeID() else {
            return nil
        }
        let value = unsafeDowncast(rawValue, to: AXValue.self)
        guard AXValueGetType(value) == .cgSize else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value, .cgSize, &size) ? size : nil
    }
}

public struct SystemSnapshotProvider: Sendable {
    private let builder: AXSnapshotBuilder
    private let registry: ElementRegistry

    public init(
        limits: AXSnapshotLimits = AXSnapshotLimits(),
        registry: ElementRegistry = ElementRegistry()
    ) {
        builder = AXSnapshotBuilder(limits: limits)
        self.registry = registry
    }

    public func snapshot(pid: Int32, sessionID: String) -> AppSnapshot {
        let root = SystemAXNode(element: AXUIElementCreateApplication(pid))
        return builder.build(root: root, sessionID: sessionID, registry: registry)
    }
}
