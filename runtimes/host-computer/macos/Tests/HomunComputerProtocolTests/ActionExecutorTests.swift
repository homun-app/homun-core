import HomunComputerProtocol
import Testing
@testable import HomunComputerServiceCore

@Test func staleGenerationNeverRetargetsCurrentElementAtSameIndex() throws {
    let registry = ElementRegistry()
    let old = SyntheticAXNode(role: "AXButton", label: "Old", actions: ["AXPress"])
    let current = SyntheticAXNode(role: "AXButton", label: "Current", actions: ["AXPress"])
    let first = AXSnapshotBuilder().build(root: old, sessionID: "session", registry: registry)
    _ = AXSnapshotBuilder().build(root: current, sessionID: "session", registry: registry)
    let executor = ActionExecutor(registry: registry)

    #expect(throws: ActionFailure.staleSnapshot) {
        _ = try executor.execute(.init(
            target: .init(snapshotID: first.snapshotID, generation: first.generation, index: 0),
            action: .press
        ))
    }
    #expect(current.performedActions.isEmpty)
}

@Test func successfulSemanticActionInvalidatesSnapshot() throws {
    let registry = ElementRegistry()
    let button = SyntheticAXNode(role: "AXButton", label: "Run", actions: ["AXPress"])
    let snapshot = AXSnapshotBuilder().build(root: button, sessionID: "session", registry: registry)
    let target = ActionTarget(snapshotID: snapshot.snapshotID, generation: snapshot.generation, index: 0)
    let executor = ActionExecutor(registry: registry)

    let result = try executor.execute(.init(target: target, action: .press))

    #expect(result.snapshotRequired)
    #expect(button.performedActions == ["AXPress"])
    #expect(throws: ActionFailure.staleSnapshot) {
        _ = try executor.execute(.init(target: target, action: .press))
    }
}

@Test func disabledAndSecureTargetsAreDeniedBeforeMutation() throws {
    let registry = ElementRegistry()
    let disabled = SyntheticAXNode(role: "AXButton", actions: ["AXPress"], enabled: false)
    let snapshot = AXSnapshotBuilder().build(root: disabled, sessionID: "disabled", registry: registry)
    let executor = ActionExecutor(registry: registry)

    #expect(throws: ActionFailure.disabledTarget) {
        _ = try executor.execute(.init(
            target: .init(snapshotID: snapshot.snapshotID, generation: snapshot.generation, index: 0),
            action: .press
        ))
    }

    let secure = SyntheticAXNode(role: "AXSecureTextField", actions: ["AXSetValue"])
    let secureSnapshot = AXSnapshotBuilder().build(root: secure, sessionID: "secure", registry: registry)
    #expect(throws: ActionFailure.secureInputBlocked) {
        _ = try executor.execute(.init(
            target: .init(snapshotID: secureSnapshot.snapshotID, generation: secureSnapshot.generation, index: 0),
            action: .setValue,
            value: "secret"
        ))
    }
}

@Test func textMutationIsBounded() throws {
    let registry = ElementRegistry()
    let field = SyntheticAXNode(role: "AXTextField", actions: ["AXSetValue"])
    let snapshot = AXSnapshotBuilder().build(root: field, sessionID: "text", registry: registry)

    #expect(throws: ActionFailure.invalidValue) {
        _ = try ActionExecutor(registry: registry).execute(.init(
            target: .init(snapshotID: snapshot.snapshotID, generation: snapshot.generation, index: 0),
            action: .setValue,
            value: String(repeating: "x", count: 20_001)
        ))
    }
}
