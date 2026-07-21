import Foundation
import Testing
import HomunComputerProtocol
@testable import HomunComputerServiceCore

@Test func statusReadDoesNotPresentPermissionPrompts() throws {
    let probe = FakePermissionProbe(
        snapshot: PermissionSnapshot(accessibility: .granted, screenRecording: .denied)
    )
    let router = RequestRouter(sessionToken: "expected", permissionProbe: probe)

    let response = try route(
        RPCRequest(
            jsonrpc: .v2,
            id: 12,
            method: .permissionStatus,
            params: .object([:]),
            meta: futureMeta()
        ),
        through: router
    )

    #expect(probe.presentCallCount == 0)
    guard case let .object(result)? = response.result else {
        Issue.record("permission result must be an object")
        return
    }
    #expect(result["accessibility"] == .string("granted"))
    #expect(result["screen_recording"] == .string("denied"))
}

@Test func explicitPresentRequestTargetsOnlySelectedPermission() throws {
    let probe = FakePermissionProbe(
        snapshot: PermissionSnapshot(accessibility: .notDetermined, screenRecording: .restricted)
    )
    let router = RequestRouter(sessionToken: "expected", permissionProbe: probe)

    _ = try route(
        RPCRequest(
            jsonrpc: .v2,
            id: 13,
            method: .permissionPresent,
            params: .object(["permission": .string("accessibility")]),
            meta: futureMeta()
        ),
        through: router
    )

    #expect(probe.presentedPermissions == [.accessibility])
}

private final class FakePermissionProbe: PermissionProbing, @unchecked Sendable {
    let snapshot: PermissionSnapshot
    var presentCallCount = 0
    var presentedPermissions: [HostPermission] = []

    init(snapshot: PermissionSnapshot) {
        self.snapshot = snapshot
    }

    func status() -> PermissionSnapshot {
        snapshot
    }

    func present(_ permission: HostPermission) -> PermissionSnapshot {
        presentCallCount += 1
        presentedPermissions.append(permission)
        return snapshot
    }
}

private func futureMeta() -> RequestMeta {
    RequestMeta(
        protocolVersion: 1,
        turnID: "turn_test",
        deadlineUnixMs: Int64.max,
        sessionToken: "expected"
    )
}

private func route(_ request: RPCRequest, through router: RequestRouter) throws -> RPCResponse {
    try JSONDecoder.hostComputer.decode(
        RPCResponse.self,
        from: router.route(JSONEncoder.hostComputer.encode(request))
    )
}
