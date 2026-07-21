import HomunComputerProtocol

public enum ActionFailure: Error, Equatable, Sendable {
    case staleSnapshot
    case targetNotFound
    case disabledTarget
    case secureInputBlocked
    case unsupportedAction
    case invalidValue
    case nativeActionFailed
}

public struct ActionExecutor: Sendable {
    private let registry: ElementRegistry

    public init(registry: ElementRegistry) {
        self.registry = registry
    }

    public func execute(_ request: ActionRequest) throws -> ActionResult {
        guard registry.contains(
            snapshotID: request.target.snapshotID,
            generation: request.target.generation
        ) else { throw ActionFailure.staleSnapshot }
        guard let node = registry.resolve(
            snapshotID: request.target.snapshotID,
            generation: request.target.generation,
            index: request.target.index
        ) else { throw ActionFailure.targetNotFound }
        guard node.enabled else { throw ActionFailure.disabledTarget }
        guard !isSensitive(node) else { throw ActionFailure.secureInputBlocked }
        guard let target = node as? any AXActionTarget else {
            throw ActionFailure.unsupportedAction
        }

        if request.action == .setValue {
            guard let value = request.value, value.unicodeScalars.count <= 20_000 else {
                throw ActionFailure.invalidValue
            }
            guard node.actionNames.contains("AXSetValue") else {
                throw ActionFailure.unsupportedAction
            }
            try target.setStringValue(value)
        } else {
            guard request.value == nil, let nativeName = nativeName(for: request.action) else {
                throw ActionFailure.unsupportedAction
            }
            guard node.actionNames.contains(nativeName) else {
                throw ActionFailure.unsupportedAction
            }
            try target.perform(actionNamed: nativeName)
        }

        registry.invalidate(
            snapshotID: request.target.snapshotID,
            generation: request.target.generation
        )
        return ActionResult(snapshotRequired: true)
    }

    private func isSensitive(_ node: any AXNodeSource) -> Bool {
        node.role.localizedCaseInsensitiveContains("secure")
            || (node.subrole?.localizedCaseInsensitiveContains("secure") ?? false)
    }

    private func nativeName(for action: SemanticAction) -> String? {
        switch action {
        case .press: "AXPress"
        case .showMenu: "AXShowMenu"
        case .increment: "AXIncrement"
        case .decrement: "AXDecrement"
        case .confirm: "AXConfirm"
        case .cancel: "AXCancel"
        case .raise: "AXRaise"
        case .scrollUp: "AXScrollUp"
        case .scrollDown: "AXScrollDown"
        case .setValue: nil
        }
    }
}
