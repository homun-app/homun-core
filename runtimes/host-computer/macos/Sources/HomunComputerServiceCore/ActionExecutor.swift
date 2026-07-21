import HomunComputerProtocol

public enum ActionFailure: Error, Equatable, Sendable {
    case staleSnapshot
    case targetNotFound
    case disabledTarget
    case secureInputBlocked
    case unsupportedAction
    case invalidValue
    case nativeActionFailed
    case protectedTarget
    case terminalInputBlocked
    case pausedByUser
    case hostLocked
}

public struct ActionExecutor: Sendable {
    private let registry: ElementRegistry
    private let policy: ProtectedTargetPolicy
    private let takeoverMonitor: InputTakeoverMonitor?

    public init(
        registry: ElementRegistry,
        policy: ProtectedTargetPolicy = ProtectedTargetPolicy(),
        takeoverMonitor: InputTakeoverMonitor? = nil
    ) {
        self.registry = registry
        self.policy = policy
        self.takeoverMonitor = takeoverMonitor
    }

    public func execute(_ request: ActionRequest) throws -> ActionResult {
        if let takeoverMonitor {
            guard takeoverMonitor.phase != .hostLocked else { throw ActionFailure.hostLocked }
            guard
                let token = request.resumeToken,
                takeoverMonitor.accepts(token: token)
            else { throw ActionFailure.pausedByUser }
        }
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
        do {
            try policy.authorize(
                bundleID: node.bundleID,
                role: node.role,
                subrole: node.subrole,
                action: request.action
            )
        } catch ProtectedTargetFailure.secureInputBlocked {
            throw ActionFailure.secureInputBlocked
        } catch ProtectedTargetFailure.terminalInputBlocked {
            throw ActionFailure.terminalInputBlocked
        } catch {
            throw ActionFailure.protectedTarget
        }
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
