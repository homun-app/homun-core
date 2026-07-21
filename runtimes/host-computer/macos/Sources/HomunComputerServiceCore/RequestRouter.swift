import Foundation
import HomunComputerProtocol

public struct RequestRouter: Sendable {
    private let authenticator: SessionAuthenticator

    public init(sessionToken: String) {
        authenticator = SessionAuthenticator(expectedToken: sessionToken)
    }

    public func route(_ body: Data) -> Data {
        let response: RPCResponse
        do {
            let request = try JSONDecoder.hostComputer.decode(RPCRequest.self, from: body)
            response = try handle(request)
        } catch let failure as ProtocolFailure {
            response = .failure(
                id: extractID(from: body),
                code: failure.errorCode,
                message: message(for: failure)
            )
        } catch {
            response = .failure(
                id: extractID(from: body),
                code: .invalidRequest,
                message: "invalid host computer request"
            )
        }
        return (try? JSONEncoder.hostComputer.encode(response)) ?? Data()
    }

    private func handle(_ request: RPCRequest) throws -> RPCResponse {
        guard authenticator.accepts(request.meta.sessionToken) else {
            throw ProtocolFailure.authenticationFailed
        }
        try request.validateProtocolVersion()
        guard request.meta.deadlineUnixMs > Int64(Date().timeIntervalSince1970 * 1_000) else {
            throw ProtocolFailure.deadlineExceeded
        }

        switch request.method {
        case .handshake:
            return .success(id: request.id, result: .object([
                "protocol_version": .number(Double(hostComputerProtocolVersion)),
                "helper_build": .string("0.1.0"),
                "helper_pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
                "host_os_version": .string(ProcessInfo.processInfo.operatingSystemVersionString),
                "capabilities": .array([.string("permission_status")]),
            ]))
        case .permissionStatus:
            return .success(id: request.id, result: .object([
                "accessibility": .string("not_determined"),
                "screen_recording": .string("not_determined"),
            ]))
        }
    }

    private func extractID(from body: Data) -> UInt64 {
        guard
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let number = object["id"] as? NSNumber
        else { return 0 }
        return number.uint64Value
    }

    private func message(for failure: ProtocolFailure) -> String {
        switch failure {
        case .authenticationFailed: "authentication failed"
        case .protocolMismatch: "protocol version mismatch"
        case .invalidRequest: "invalid request"
        case .deadlineExceeded: "request deadline exceeded"
        case .payloadTooLarge: "request payload too large"
        }
    }
}
