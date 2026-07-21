import Testing
@testable import HomunComputerServiceCore

@Test func physicalInputInvalidatesResumeToken() {
    let monitor = InputTakeoverMonitor(eventMarker: 42)
    monitor.resume(token: "resume-1")
    monitor.observe(kind: .mouseDown, sourceUserData: 0)

    #expect(monitor.phase == .pausedByUser)
    #expect(!monitor.accepts(token: "resume-1"))
}

@Test func taggedHomunEventsDoNotTriggerTakeover() {
    let monitor = InputTakeoverMonitor(eventMarker: 42)
    monitor.resume(token: "resume-1")
    monitor.observe(kind: .scroll, sourceUserData: 42)

    #expect(monitor.accepts(token: "resume-1"))
}

@Test func lockSleepAndTapFailureAreFailClosed() {
    let monitor = InputTakeoverMonitor(eventMarker: 42)
    monitor.resume(token: "resume-1")
    monitor.hostLocked()
    #expect(monitor.phase == .hostLocked)
    monitor.hostUnlocked()
    #expect(monitor.phase == .pausedByUser)
    monitor.disableMutationCapability()
    #expect(monitor.phase == .monitorUnavailable)
}
