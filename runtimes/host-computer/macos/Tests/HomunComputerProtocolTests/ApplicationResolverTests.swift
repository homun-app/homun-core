import Foundation
import Testing
import HomunComputerProtocol
@testable import HomunComputerServiceCore

@Test func duplicateNamesRemainDistinctByPIDAndStartTime() {
    let records = [
        RunningApplicationRecord(
            pid: 202,
            processStartTimeUnixMs: 2_000,
            displayName: "Notes",
            bundleIdentifier: "com.example.notes.two",
            activationPolicy: .regular,
            isActive: false,
            isHidden: false
        ),
        RunningApplicationRecord(
            pid: 101,
            processStartTimeUnixMs: 1_000,
            displayName: "Notes",
            bundleIdentifier: "com.example.notes.one",
            activationPolicy: .regular,
            isActive: true,
            isHidden: false
        ),
    ]

    let result = ApplicationResolver.resolve(records, includeBackground: false, limit: 500)

    #expect(result.items.map(\.identity.pid) == [101, 202])
    #expect(Set(result.items.map(\.identity)).count == 2)
    #expect(!result.truncated)
}

@Test func backgroundApplicationsAreExcludedByDefaultAndBoundedExplicitly() {
    let records = [
        RunningApplicationRecord(
            pid: 1,
            processStartTimeUnixMs: 1,
            displayName: "Visible",
            bundleIdentifier: "visible",
            activationPolicy: .regular,
            isActive: false,
            isHidden: false
        ),
        RunningApplicationRecord(
            pid: 2,
            processStartTimeUnixMs: 2,
            displayName: "Agent",
            bundleIdentifier: nil,
            activationPolicy: .prohibited,
            isActive: false,
            isHidden: false
        ),
    ]

    let visible = ApplicationResolver.resolve(records, includeBackground: false, limit: 500)
    let all = ApplicationResolver.resolve(records, includeBackground: true, limit: 1)

    #expect(visible.items.map(\.displayName) == ["Visible"])
    #expect(all.items.count == 1)
    #expect(all.truncated)
}

@Test func windowIdentityNeverDependsOnTitle() {
    let records = [
        WindowRecord(
            ownerPID: 44,
            windowID: 9,
            title: "Untitled",
            bounds: HostRect(x: 10, y: 20, width: 300, height: 200),
            isOnScreen: true,
            isMinimized: false,
            displayID: 1
        ),
        WindowRecord(
            ownerPID: 44,
            windowID: 10,
            title: "Untitled",
            bounds: HostRect(x: 20, y: 30, width: 300, height: 200),
            isOnScreen: false,
            isMinimized: true,
            displayID: nil
        ),
    ]

    let result = WindowResolver.resolve(records, limit: 1)

    #expect(result.items.first?.identity.windowID == 9)
    #expect(result.truncated)
}
