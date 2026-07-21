import Foundation
import Testing
import HomunComputerProtocol
@testable import HomunComputerServiceCore

@Test func invalidTokenReturnsAuthenticationErrorWithOriginalID() throws {
    let router = RequestRouter(sessionToken: "expected")
    let request = request(id: 77, token: "incorrect")

    let response = try JSONDecoder.hostComputer.decode(
        RPCResponse.self,
        from: router.route(JSONEncoder.hostComputer.encode(request))
    )

    #expect(response.id == 77)
    #expect(response.result == nil)
    #expect(response.error?.code == .authenticationFailed)
}

@Test func handshakePreservesRequestIDAndReportsProtocol() throws {
    let router = RequestRouter(sessionToken: "expected")
    let request = request(id: 91, token: "expected")

    let response = try JSONDecoder.hostComputer.decode(
        RPCResponse.self,
        from: router.route(JSONEncoder.hostComputer.encode(request))
    )

    #expect(response.id == 91)
    guard case let .object(result)? = response.result else {
        Issue.record("handshake result must be an object")
        return
    }
    #expect(result["protocol_version"] == .number(1))
}

@Test func authenticatedShutdownRequestsServiceExitAfterReply() throws {
    let shutdown = ShutdownSignal()
    let router = RequestRouter(sessionToken: "expected", shutdownSignal: shutdown)
    let rpc = RPCRequest(
        jsonrpc: .v2,
        id: 92,
        method: .shutdown,
        params: .object([:]),
        meta: RequestMeta(
            protocolVersion: 1,
            turnID: nil,
            deadlineUnixMs: Int64.max,
            sessionToken: "expected"
        )
    )

    let response = try JSONDecoder.hostComputer.decode(
        RPCResponse.self,
        from: router.route(JSONEncoder.hostComputer.encode(rpc))
    )

    #expect(response.id == 92)
    #expect(response.error == nil)
    #expect(shutdown.isRequested)
}

private func request(id: UInt64, token: String) -> RPCRequest {
    RPCRequest(
        jsonrpc: .v2,
        id: id,
        method: .handshake,
        params: .object([:]),
        meta: RequestMeta(
            protocolVersion: 1,
            turnID: "turn_test",
            deadlineUnixMs: Int64.max,
            sessionToken: token
        )
    )
}
