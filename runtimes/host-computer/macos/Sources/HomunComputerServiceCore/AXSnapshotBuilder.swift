import Foundation
import HomunComputerProtocol

public protocol AXNodeSource: AnyObject {
    var bundleID: String? { get }
    var role: String { get }
    var subrole: String? { get }
    var label: String? { get }
    var help: String? { get }
    var value: String? { get }
    var bounds: HostRect? { get }
    var enabled: Bool { get }
    var focused: Bool { get }
    var selected: Bool? { get }
    var expanded: Bool? { get }
    var actionNames: [String] { get }
    var children: [any AXNodeSource] { get }
}

public protocol AXActionTarget: AXNodeSource {
    func perform(actionNamed name: String) throws
    func setStringValue(_ value: String) throws
}

public final class SyntheticAXNode: AXActionTarget {
    public var bundleID: String?
    public var role: String
    public var subrole: String?
    public var label: String?
    public var help: String?
    public var value: String?
    public var bounds: HostRect?
    public var enabled: Bool
    public var focused: Bool
    public var selected: Bool?
    public var expanded: Bool?
    public var actionNames: [String]
    public var children: [any AXNodeSource]
    public private(set) var performedActions: [String] = []

    public init(
        role: String,
        bundleID: String? = nil,
        subrole: String? = nil,
        label: String? = nil,
        help: String? = nil,
        value: String? = nil,
        actions: [String] = [],
        bounds: HostRect? = nil,
        enabled: Bool = true,
        focused: Bool = false,
        selected: Bool? = nil,
        expanded: Bool? = nil,
        children: [any AXNodeSource] = []
    ) {
        self.role = role
        self.bundleID = bundleID
        self.subrole = subrole
        self.label = label
        self.help = help
        self.value = value
        self.actionNames = actions
        self.bounds = bounds
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.expanded = expanded
        self.children = children
    }

    public func perform(actionNamed name: String) throws {
        performedActions.append(name)
    }

    public func setStringValue(_ value: String) throws {
        self.value = value
        performedActions.append("AXSetValue")
    }
}

public struct AXSnapshotLimits: Equatable, Sendable {
    public var maxDepth: Int
    public var maxNodes: Int
    public var maxCharacters: Int

    public init(maxDepth: Int = 12, maxNodes: Int = 2_000, maxCharacters: Int = 200_000) {
        self.maxDepth = max(0, maxDepth)
        self.maxNodes = max(1, maxNodes)
        self.maxCharacters = max(0, maxCharacters)
    }
}

public struct AXSnapshotBuilder: Sendable {
    public var limits: AXSnapshotLimits

    public init(limits: AXSnapshotLimits = AXSnapshotLimits()) {
        self.limits = limits
    }

    public func build(
        root: any AXNodeSource,
        sessionID: String,
        registry: ElementRegistry
    ) -> AppSnapshot {
        var state = BuildState(limits: limits)
        _ = state.visit(root, parentIndex: nil, depth: 0)

        let snapshotID = UUID().uuidString.lowercased()
        let generation = registry.install(
            sessionID: sessionID,
            snapshotID: snapshotID,
            nodes: state.nodes
        )
        let focusedIndex = state.elements.first(where: \.focused)?.index
        return AppSnapshot(
            snapshotID: snapshotID,
            generation: generation,
            capturedAtUnixMs: Int64(Date().timeIntervalSince1970 * 1_000),
            elements: state.elements,
            focusedElementIndex: focusedIndex,
            truncated: state.truncated
        )
    }
}

private struct BuildState {
    let limits: AXSnapshotLimits
    var elements: [HostElement] = []
    var nodes: [any AXNodeSource] = []
    var visited: Set<ObjectIdentifier> = []
    var characterCount = 0
    var truncated = false

    mutating func visit(
        _ node: any AXNodeSource,
        parentIndex: UInt32?,
        depth: Int
    ) -> UInt32? {
        guard depth <= limits.maxDepth else {
            truncated = true
            return nil
        }
        guard elements.count < limits.maxNodes else {
            truncated = true
            return nil
        }

        let identity = ObjectIdentifier(node)
        guard visited.insert(identity).inserted else {
            return nil
        }

        let index = UInt32(elements.count)
        let isSensitive = Self.isSensitive(role: node.role, subrole: node.subrole)
        let actions = Self.semanticActions(node.actionNames, sensitive: isSensitive)
        elements.append(HostElement(
            index: index,
            role: bounded(node.role) ?? "AXUnknown",
            subrole: bounded(node.subrole),
            label: bounded(node.label),
            help: bounded(node.help),
            value: isSensitive ? nil : bounded(node.value),
            bounds: node.bounds,
            enabled: node.enabled,
            focused: node.focused,
            selected: node.selected,
            expanded: node.expanded,
            sensitive: isSensitive,
            actions: actions,
            parentIndex: parentIndex
        ))
        nodes.append(node)

        var childIndices: [UInt32] = []
        for child in node.children {
            if let childIndex = visit(child, parentIndex: index, depth: depth + 1) {
                childIndices.append(childIndex)
            }
        }
        elements[Int(index)].childIndices = childIndices
        return index
    }

    mutating func bounded(_ value: String?) -> String? {
        guard let value else { return nil }
        let remaining = max(0, limits.maxCharacters - characterCount)
        guard remaining > 0 else {
            if !value.isEmpty { truncated = true }
            return nil
        }
        guard value.count > remaining else {
            characterCount += value.count
            return value
        }
        truncated = true
        let end = value.index(value.startIndex, offsetBy: remaining)
        characterCount += remaining
        return String(value[..<end])
    }

    static func isSensitive(role: String, subrole: String?) -> Bool {
        role.localizedCaseInsensitiveContains("secure")
            || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
    }

    static func semanticActions(_ names: [String], sensitive: Bool) -> [SemanticAction] {
        if sensitive { return [] }
        let mapped = names.compactMap { name -> SemanticAction? in
            switch name {
            case "AXPress": .press
            case "AXSetValue": .setValue
            case "AXShowMenu": .showMenu
            case "AXIncrement": .increment
            case "AXDecrement": .decrement
            case "AXConfirm": .confirm
            case "AXCancel": .cancel
            case "AXRaise": .raise
            case "AXScrollUp": .scrollUp
            case "AXScrollDown": .scrollDown
            default: nil
            }
        }
        return Array(Set(mapped))
            .sorted { $0.rawValue < $1.rawValue }
    }
}
