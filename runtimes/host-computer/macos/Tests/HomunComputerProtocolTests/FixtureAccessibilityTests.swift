import AppKit
import Testing
@testable import HomunComputerFixtureCore

@MainActor
@Test func dragDestinationIsAnExplicitAccessibilityElement() {
    let target = FixtureDropTarget(didDrop: {})
    target.setAccessibilityIdentifier("fixture.drag-destination")

    #expect(target.isAccessibilityElement())
    #expect(target.accessibilityRole() == .group)
    #expect(target.accessibilityIdentifier() == "fixture.drag-destination")
}
