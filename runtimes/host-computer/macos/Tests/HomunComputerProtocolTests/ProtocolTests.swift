import Foundation
import Testing
@testable import HomunComputerProtocol

@Test func handshakeFixtureRoundTrips() throws {
    let data = try fixture(named: "handshake-request-v1")
    let request = try JSONDecoder.hostComputer.decode(RPCRequest.self, from: data)

    #expect(request.jsonrpc == .v2)
    #expect(request.meta.protocolVersion == 1)
    #expect(request.method == .handshake)
    #expect(try canonicalJSON(JSONEncoder.hostComputer.encode(request)) == canonicalJSON(data))
}

@Test func requestDebugDescriptionRedactsSessionToken() throws {
    let request = try JSONDecoder.hostComputer.decode(
        RPCRequest.self,
        from: fixture(named: "handshake-request-v1")
    )

    #expect(!request.debugDescription.contains("test-session-token-32-bytes-long"))
    #expect(request.debugDescription.contains("[REDACTED]"))
}

@Test func unsupportedProtocolVersionIsRejected() throws {
    var request = try JSONDecoder.hostComputer.decode(
        RPCRequest.self,
        from: fixture(named: "handshake-request-v1")
    )
    request.meta.protocolVersion = 2

    #expect(throws: ProtocolFailure.protocolMismatch) {
        try request.validateProtocolVersion()
    }
}

@Test func authenticationUsesExactConstantTimeComparison() {
    let authenticator = SessionAuthenticator(expectedToken: "abcdef")

    #expect(authenticator.accepts("abcdef"))
    #expect(!authenticator.accepts("abcdeg"))
    #expect(!authenticator.accepts("abcdef0"))
}

private func fixture(named name: String) throws -> Data {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return try Data(contentsOf: packageRoot.appending(path: "Fixtures/\(name).json"))
}

private func canonicalJSON(_ data: Data) throws -> String {
    let object = try JSONSerialization.jsonObject(with: data)
    let canonical = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: canonical, as: UTF8.self)
}
