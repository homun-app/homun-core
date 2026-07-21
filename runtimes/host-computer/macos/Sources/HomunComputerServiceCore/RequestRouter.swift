import Foundation
import HomunComputerProtocol

public struct RequestRouter: Sendable {
    private let authenticator: SessionAuthenticator
    private let permissionProbe: any PermissionProbing
    private let inventory: any AppInventoryProviding
    private let snapshotProvider: SystemSnapshotProvider
    private let captureRunner: BlockingCaptureRunner?
    private let actionExecutor: ActionExecutor
    private let takeoverMonitor: InputTakeoverMonitor?

    public init(
        sessionToken: String,
        permissionProbe: any PermissionProbing = SystemPermissionProbe(),
        artifactRoot: URL? = nil,
        takeoverMonitor: InputTakeoverMonitor? = nil
    ) {
        authenticator = SessionAuthenticator(expectedToken: sessionToken)
        self.permissionProbe = permissionProbe
        inventory = SystemAppInventory()
        let registry = ElementRegistry()
        snapshotProvider = SystemSnapshotProvider(registry: registry)
        actionExecutor = ActionExecutor(registry: registry, takeoverMonitor: takeoverMonitor)
        self.takeoverMonitor = takeoverMonitor
        captureRunner = artifactRoot.map {
            BlockingCaptureRunner(service: ScreenCaptureService(artifactRoot: $0))
        }
    }

    init(
        sessionToken: String,
        permissionProbe: any PermissionProbing,
        inventory: any AppInventoryProviding
    ) {
        authenticator = SessionAuthenticator(expectedToken: sessionToken)
        self.permissionProbe = permissionProbe
        self.inventory = inventory
        let registry = ElementRegistry()
        snapshotProvider = SystemSnapshotProvider(registry: registry)
        actionExecutor = ActionExecutor(registry: registry)
        takeoverMonitor = nil
        captureRunner = nil
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
                "capabilities": .array([
                    .string("permission_status"),
                    .string("permission_present"),
                    .string("list_apps"),
                    .string("list_windows"),
                    .string("get_app_state"),
                    .string("capture_window"),
                    .string("execute_action"),
                    .string("resume_control"),
                ]),
            ]))
        case .permissionStatus:
            return .success(id: request.id, result: permissionProbe.status().jsonValue)
        case .permissionPresent:
            guard
                case let .object(params) = request.params,
                case let .string(rawPermission)? = params["permission"],
                let permission = HostPermission(rawValue: rawPermission)
            else { throw ProtocolFailure.invalidRequest }
            return .success(
                id: request.id,
                result: permissionProbe.present(permission).jsonValue
            )
        case .listApps:
            let includeBackground: Bool
            if
                case let .object(params) = request.params,
                case let .bool(value)? = params["include_background"]
            {
                includeBackground = value
            } else {
                includeBackground = false
            }
            let resolved = inventory.listApplications(includeBackground: includeBackground)
            return .success(id: request.id, result: .object([
                "apps": try encodeJSONValue(resolved.items),
                "truncated": .bool(resolved.truncated),
            ]))
        case .listWindows:
            let resolved = inventory.listWindows()
            return .success(id: request.id, result: .object([
                "windows": try encodeJSONValue(resolved.items),
                "truncated": .bool(resolved.truncated),
            ]))
        case .getAppState:
            guard
                case let .object(params) = request.params,
                case let .number(rawPID)? = params["pid"],
                rawPID.rounded() == rawPID,
                rawPID > 0,
                rawPID <= Double(Int32.max)
            else { throw ProtocolFailure.invalidRequest }
            let snapshot = snapshotProvider.snapshot(
                pid: Int32(rawPID),
                sessionID: request.meta.turnID ?? "default"
            )
            return .success(id: request.id, result: try encodeJSONValue(snapshot))
        case .captureWindow:
            guard
                let captureRunner,
                case let .object(params) = request.params,
                case let .number(rawWindowID)? = params["window_id"],
                rawWindowID.rounded() == rawWindowID,
                rawWindowID > 0,
                rawWindowID <= Double(UInt32.max)
            else { throw ProtocolFailure.invalidRequest }
            do {
                let staged = try captureRunner.capture(windowID: UInt32(rawWindowID))
                return .success(id: request.id, result: try encodeJSONValue(staged))
            } catch CaptureFailure.permissionDenied {
                throw ProtocolFailure.permissionMissing
            } catch CaptureFailure.windowNotFound {
                throw ProtocolFailure.targetNotFound
            } catch {
                throw ProtocolFailure.helperUnavailable
            }
        case .executeAction:
            let action: ActionRequest = try decodeJSONValue(request.params)
            do {
                return .success(
                    id: request.id,
                    result: try encodeJSONValue(actionExecutor.execute(action))
                )
            } catch ActionFailure.staleSnapshot {
                throw ProtocolFailure.staleSnapshot
            } catch ActionFailure.targetNotFound {
                throw ProtocolFailure.targetNotFound
            } catch ActionFailure.secureInputBlocked {
                throw ProtocolFailure.secureInputBlocked
            } catch ActionFailure.terminalInputBlocked {
                throw ProtocolFailure.terminalInputBlocked
            } catch ActionFailure.protectedTarget {
                throw ProtocolFailure.approvalRequired
            } catch ActionFailure.hostLocked {
                throw ProtocolFailure.hostLocked
            } catch ActionFailure.pausedByUser {
                throw ProtocolFailure.approvalRequired
            } catch {
                throw ProtocolFailure.invalidRequest
            }
        case .resumeControl:
            guard
                let takeoverMonitor,
                case let .object(params) = request.params,
                case let .string(token)? = params["resume_token"],
                !token.isEmpty
            else { throw ProtocolFailure.invalidRequest }
            takeoverMonitor.resume(token: token)
            return .success(id: request.id, result: .object([
                "phase": .string(takeoverMonitor.phase.rawValue),
            ]))
        }
    }

    private func encodeJSONValue<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder.hostComputer.decode(
            JSONValue.self,
            from: JSONEncoder.hostComputer.encode(value)
        )
    }

    private func decodeJSONValue<T: Decodable>(_ value: JSONValue) throws -> T {
        try JSONDecoder.hostComputer.decode(T.self, from: JSONEncoder.hostComputer.encode(value))
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
        case .permissionMissing: "screen recording permission is missing"
        case .targetNotFound: "capture target was not found"
        case .helperUnavailable: "window capture failed"
        case .staleSnapshot: "snapshot is stale"
        case .secureInputBlocked: "secure input is blocked"
        case .terminalInputBlocked: "terminal input is blocked"
        case .approvalRequired: "protected target is blocked"
        case .hostLocked: "host session is locked"
        }
    }
}
