import Foundation
import Testing
import HomunComputerProtocol
@testable import HomunComputerServiceCore

@Test func snapshotIsDeterministicBoundedAndCycleSafe() {
    let root = SyntheticAXNode(role: "AXWindow", label: "Fixture")
    let button = SyntheticAXNode(
        role: "AXButton",
        label: "Run",
        actions: ["AXPress"],
        bounds: HostRect(x: 10, y: 20, width: 80, height: 30)
    )
    let secure = SyntheticAXNode(
        role: "AXSecureTextField",
        label: "Password",
        value: "must-never-leak",
        actions: ["AXSetValue", "AXPress"]
    )
    root.children = [button, secure]
    secure.children = [root]

    let registry = ElementRegistry()
    let snapshot = AXSnapshotBuilder(limits: .init(maxDepth: 12, maxNodes: 2, maxCharacters: 100))
        .build(root: root, sessionID: "session", registry: registry)

    #expect(snapshot.elements.map(\.index) == [0, 1])
    #expect(snapshot.elements[1].role == "AXButton")
    #expect(snapshot.elements[1].parentIndex == 0)
    #expect(snapshot.truncated)
}

@Test func secureFieldNeverExposesValueOrSetValueAction() {
    let secure = SyntheticAXNode(
        role: "AXSecureTextField",
        label: "Password",
        value: "customer-secret",
        actions: ["AXSetValue", "AXPress"]
    )

    let snapshot = AXSnapshotBuilder().build(
        root: secure,
        sessionID: "session",
        registry: ElementRegistry()
    )
    let element = snapshot.elements[0]

    #expect(element.value == nil)
    #expect(element.sensitive)
    #expect(!element.actions.contains(.setValue))
}

@Test func installingNewGenerationMakesOldTargetsStale() {
    let registry = ElementRegistry()
    let node = SyntheticAXNode(role: "AXButton", label: "Run")
    let first = AXSnapshotBuilder().build(root: node, sessionID: "session", registry: registry)
    let second = AXSnapshotBuilder().build(root: node, sessionID: "session", registry: registry)

    #expect(registry.resolve(snapshotID: first.snapshotID, generation: first.generation, index: 0) == nil)
    #expect(registry.resolve(snapshotID: second.snapshotID, generation: second.generation, index: 0) != nil)
}

@Test func diffReconstructsTheExactCurrentElementList() {
    let base = [
        HostElement(index: 0, role: "AXWindow", label: "Before"),
        HostElement(index: 1, role: "AXButton", label: "Keep"),
    ]
    let current = [
        HostElement(index: 0, role: "AXWindow", label: "After"),
        HostElement(index: 2, role: "AXCheckBox", label: "Added"),
    ]

    let diff = SnapshotDiffer.diff(base: base, current: current)

    #expect(SnapshotDiffer.apply(diff, to: base) == current)
    #expect(diff.removedIndices == [1])
    #expect(diff.updated.map(\.index) == [0])
    #expect(diff.inserted.map(\.index) == [2])
}
