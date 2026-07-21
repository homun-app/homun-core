import Foundation

public let hostComputerProtocolVersion = 1

public enum JSONRPCVersion: String, Codable, Sendable {
    case v2 = "2.0"
}

public enum HostComputerMethod: String, Codable, Sendable {
    case handshake
    case permissionStatus = "permission_status"
    case permissionPresent = "permission_present"
    case listApps = "list_apps"
    case listWindows = "list_windows"
    case getAppState = "get_app_state"
    case captureWindow = "capture_window"
    case executeAction = "execute_action"
}

public struct ApplicationIdentity: Codable, Equatable, Hashable, Sendable {
    public var pid: Int32
    public var processStartTimeUnixMs: Int64

    public init(pid: Int32, processStartTimeUnixMs: Int64) {
        self.pid = pid
        self.processStartTimeUnixMs = processStartTimeUnixMs
    }

    enum CodingKeys: String, CodingKey {
        case pid
        case processStartTimeUnixMs = "process_start_time_unix_ms"
    }
}

public enum HostActivationPolicy: String, Codable, Equatable, Sendable {
    case regular
    case accessory
    case prohibited
}

public struct HostApplication: Codable, Equatable, Sendable {
    public var identity: ApplicationIdentity
    public var displayName: String
    public var bundleID: String?
    public var activationPolicy: HostActivationPolicy
    public var isActive: Bool
    public var isHidden: Bool

    public init(
        identity: ApplicationIdentity,
        displayName: String,
        bundleID: String?,
        activationPolicy: HostActivationPolicy,
        isActive: Bool,
        isHidden: Bool
    ) {
        self.identity = identity
        self.displayName = displayName
        self.bundleID = bundleID
        self.activationPolicy = activationPolicy
        self.isActive = isActive
        self.isHidden = isHidden
    }

    enum CodingKeys: String, CodingKey {
        case identity
        case displayName = "display_name"
        case bundleID = "bundle_id"
        case activationPolicy = "activation_policy"
        case isActive = "is_active"
        case isHidden = "is_hidden"
    }
}

public struct HostRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct WindowIdentity: Codable, Equatable, Hashable, Sendable {
    public var pid: Int32
    public var windowID: UInt32

    public init(pid: Int32, windowID: UInt32) {
        self.pid = pid
        self.windowID = windowID
    }

    enum CodingKeys: String, CodingKey {
        case pid
        case windowID = "window_id"
    }
}

public struct HostWindow: Codable, Equatable, Sendable {
    public var identity: WindowIdentity
    public var title: String?
    public var bounds: HostRect
    public var isMinimized: Bool
    public var isOnScreen: Bool
    public var displayID: UInt32?

    public init(
        identity: WindowIdentity,
        title: String?,
        bounds: HostRect,
        isMinimized: Bool,
        isOnScreen: Bool,
        displayID: UInt32?
    ) {
        self.identity = identity
        self.title = title
        self.bounds = bounds
        self.isMinimized = isMinimized
        self.isOnScreen = isOnScreen
        self.displayID = displayID
    }

    enum CodingKeys: String, CodingKey {
        case identity, title, bounds
        case isMinimized = "is_minimized"
        case isOnScreen = "is_on_screen"
        case displayID = "display_id"
    }
}

public enum SemanticAction: String, Codable, Equatable, Hashable, Sendable {
    case press
    case setValue = "set_value"
    case showMenu = "show_menu"
    case increment
    case decrement
    case confirm
    case cancel
    case raise
    case scrollUp = "scroll_up"
    case scrollDown = "scroll_down"
}

public enum SnapshotTreeMode: String, Codable, Equatable, Sendable {
    case full
    case diff
}

public struct HostElement: Codable, Equatable, Sendable {
    public var index: UInt32
    public var role: String
    public var subrole: String?
    public var label: String?
    public var help: String?
    public var value: String?
    public var bounds: HostRect?
    public var enabled: Bool
    public var focused: Bool
    public var selected: Bool?
    public var expanded: Bool?
    public var sensitive: Bool
    public var actions: [SemanticAction]
    public var parentIndex: UInt32?
    public var childIndices: [UInt32]

    public init(
        index: UInt32,
        role: String,
        subrole: String? = nil,
        label: String? = nil,
        help: String? = nil,
        value: String? = nil,
        bounds: HostRect? = nil,
        enabled: Bool = true,
        focused: Bool = false,
        selected: Bool? = nil,
        expanded: Bool? = nil,
        sensitive: Bool = false,
        actions: [SemanticAction] = [],
        parentIndex: UInt32? = nil,
        childIndices: [UInt32] = []
    ) {
        self.index = index
        self.role = role
        self.subrole = subrole
        self.label = label
        self.help = help
        self.value = value
        self.bounds = bounds
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.expanded = expanded
        self.sensitive = sensitive
        self.actions = actions
        self.parentIndex = parentIndex
        self.childIndices = childIndices
    }

    enum CodingKeys: String, CodingKey {
        case index, role, subrole, label, help, value, bounds, enabled, focused, selected, expanded, sensitive, actions
        case parentIndex = "parent_index"
        case childIndices = "child_indices"
    }
}

public struct SnapshotDiff: Codable, Equatable, Sendable {
    public var inserted: [HostElement]
    public var updated: [HostElement]
    public var removedIndices: [UInt32]

    public init(inserted: [HostElement], updated: [HostElement], removedIndices: [UInt32]) {
        self.inserted = inserted
        self.updated = updated
        self.removedIndices = removedIndices
    }

    enum CodingKeys: String, CodingKey {
        case inserted, updated
        case removedIndices = "removed_indices"
    }
}

public struct ArtifactRef: Codable, Equatable, Sendable {
    public var artifactRef: String
    public var mimeType: String
    public var sizeBytes: UInt64
    public var sha256: String

    enum CodingKeys: String, CodingKey {
        case artifactRef = "artifact_ref"
        case mimeType = "mime_type"
        case sizeBytes = "size_bytes"
        case sha256
    }
}

public struct StagedCapture: Codable, Equatable, Sendable {
    public var relativePath: String

    public init(relativePath: String) {
        self.relativePath = relativePath
    }

    enum CodingKeys: String, CodingKey {
        case relativePath = "relative_path"
    }
}

public struct ActionTarget: Codable, Equatable, Sendable {
    public var snapshotID: String
    public var generation: UInt64
    public var index: UInt32

    public init(snapshotID: String, generation: UInt64, index: UInt32) {
        self.snapshotID = snapshotID
        self.generation = generation
        self.index = index
    }

    enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case generation, index
    }
}

public struct ActionRequest: Codable, Equatable, Sendable {
    public var target: ActionTarget
    public var action: SemanticAction
    public var value: String?

    public init(target: ActionTarget, action: SemanticAction, value: String? = nil) {
        self.target = target
        self.action = action
        self.value = value
    }
}

public struct ActionResult: Codable, Equatable, Sendable {
    public var snapshotRequired: Bool

    public init(snapshotRequired: Bool) {
        self.snapshotRequired = snapshotRequired
    }

    enum CodingKeys: String, CodingKey {
        case snapshotRequired = "snapshot_required"
    }
}

public struct AppSnapshot: Codable, Equatable, Sendable {
    public var snapshotID: String
    public var generation: UInt64
    public var capturedAtUnixMs: Int64
    public var treeMode: SnapshotTreeMode
    public var baseSnapshotID: String?
    public var elements: [HostElement]
    public var focusedElementIndex: UInt32?
    public var screenshotRef: ArtifactRef?
    public var truncated: Bool

    public init(
        snapshotID: String,
        generation: UInt64,
        capturedAtUnixMs: Int64,
        treeMode: SnapshotTreeMode = .full,
        baseSnapshotID: String? = nil,
        elements: [HostElement],
        focusedElementIndex: UInt32?,
        screenshotRef: ArtifactRef? = nil,
        truncated: Bool
    ) {
        self.snapshotID = snapshotID
        self.generation = generation
        self.capturedAtUnixMs = capturedAtUnixMs
        self.treeMode = treeMode
        self.baseSnapshotID = baseSnapshotID
        self.elements = elements
        self.focusedElementIndex = focusedElementIndex
        self.screenshotRef = screenshotRef
        self.truncated = truncated
    }

    enum CodingKeys: String, CodingKey {
        case snapshotID = "snapshot_id"
        case generation
        case capturedAtUnixMs = "captured_at_unix_ms"
        case treeMode = "tree_mode"
        case baseSnapshotID = "base_snapshot_id"
        case elements
        case focusedElementIndex = "focused_element_index"
        case screenshotRef = "screenshot_ref"
        case truncated
    }
}

public enum PermissionState: String, Codable, Equatable, Sendable {
    case granted
    case denied
    case notDetermined = "not_determined"
    case restricted
}

public enum HostPermission: String, Codable, Equatable, Sendable {
    case accessibility
    case screenRecording = "screen_recording"
}

public struct PermissionSnapshot: Codable, Equatable, Sendable {
    public var accessibility: PermissionState
    public var screenRecording: PermissionState

    public init(accessibility: PermissionState, screenRecording: PermissionState) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
    }

    enum CodingKeys: String, CodingKey {
        case accessibility
        case screenRecording = "screen_recording"
    }

    public var jsonValue: JSONValue {
        .object([
            "accessibility": .string(accessibility.rawValue),
            "screen_recording": .string(screenRecording.rawValue),
        ])
    }
}

public struct RequestMeta: Codable, Equatable, Sendable {
    public var protocolVersion: Int
    public var turnID: String?
    public var deadlineUnixMs: Int64
    public var sessionToken: String

    public init(
        protocolVersion: Int,
        turnID: String?,
        deadlineUnixMs: Int64,
        sessionToken: String
    ) {
        self.protocolVersion = protocolVersion
        self.turnID = turnID
        self.deadlineUnixMs = deadlineUnixMs
        self.sessionToken = sessionToken
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case turnID = "turn_id"
        case deadlineUnixMs = "deadline_unix_ms"
        case sessionToken = "session_token"
    }
}

public struct RPCRequest: Codable, Equatable, Sendable, CustomDebugStringConvertible {
    public var jsonrpc: JSONRPCVersion
    public var id: UInt64
    public var method: HostComputerMethod
    public var params: JSONValue
    public var meta: RequestMeta

    public init(
        jsonrpc: JSONRPCVersion,
        id: UInt64,
        method: HostComputerMethod,
        params: JSONValue,
        meta: RequestMeta
    ) {
        self.jsonrpc = jsonrpc
        self.id = id
        self.method = method
        self.params = params
        self.meta = meta
    }

    public var debugDescription: String {
        "RPCRequest(jsonrpc: \(jsonrpc.rawValue), id: \(id), method: \(method.rawValue), "
            + "meta: RequestMeta(protocolVersion: \(meta.protocolVersion), turnID: \(String(describing: meta.turnID)), "
            + "deadlineUnixMs: \(meta.deadlineUnixMs), sessionToken: [REDACTED]))"
    }

    public func validateProtocolVersion() throws {
        guard meta.protocolVersion == hostComputerProtocolVersion else {
            throw ProtocolFailure.protocolMismatch
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

public enum HostComputerErrorCode: String, Codable, Sendable {
    case authenticationFailed = "authentication_failed"
    case protocolMismatch = "protocol_mismatch"
    case invalidRequest = "invalid_request"
    case permissionMissing = "permission_missing"
    case appNotGranted = "app_not_granted"
    case approvalRequired = "approval_required"
    case secureInputBlocked = "secure_input_blocked"
    case terminalInputBlocked = "terminal_input_blocked"
    case staleSnapshot = "stale_snapshot"
    case targetNotFound = "target_not_found"
    case deadlineExceeded = "deadline_exceeded"
    case payloadTooLarge = "payload_too_large"
    case helperUnavailable = "helper_unavailable"
    case hostLocked = "host_locked"
    case unsupportedPlatform = "unsupported_platform"
}

public struct RPCErrorPayload: Codable, Equatable, Sendable {
    public var code: HostComputerErrorCode
    public var message: String
    public var data: JSONValue?

    public init(code: HostComputerErrorCode, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public struct RPCResponse: Codable, Equatable, Sendable {
    public var jsonrpc: JSONRPCVersion
    public var id: UInt64
    public var result: JSONValue?
    public var error: RPCErrorPayload?

    public static func success(id: UInt64, result: JSONValue) -> RPCResponse {
        RPCResponse(jsonrpc: .v2, id: id, result: result, error: nil)
    }

    public static func failure(
        id: UInt64,
        code: HostComputerErrorCode,
        message: String
    ) -> RPCResponse {
        RPCResponse(
            jsonrpc: .v2,
            id: id,
            result: nil,
            error: RPCErrorPayload(code: code, message: message)
        )
    }
}

public enum ProtocolFailure: Error, Equatable, Sendable {
    case authenticationFailed
    case protocolMismatch
    case invalidRequest
    case deadlineExceeded
    case payloadTooLarge
    case permissionMissing
    case targetNotFound
    case helperUnavailable
    case staleSnapshot
    case secureInputBlocked

    public var errorCode: HostComputerErrorCode {
        switch self {
        case .authenticationFailed: .authenticationFailed
        case .protocolMismatch: .protocolMismatch
        case .invalidRequest: .invalidRequest
        case .deadlineExceeded: .deadlineExceeded
        case .payloadTooLarge: .payloadTooLarge
        case .permissionMissing: .permissionMissing
        case .targetNotFound: .targetNotFound
        case .helperUnavailable: .helperUnavailable
        case .staleSnapshot: .staleSnapshot
        case .secureInputBlocked: .secureInputBlocked
        }
    }
}

public struct SessionAuthenticator: Sendable {
    private let expectedToken: [UInt8]

    public init(expectedToken: String) {
        self.expectedToken = Array(expectedToken.utf8)
    }

    public func accepts(_ candidate: String) -> Bool {
        let candidateBytes = Array(candidate.utf8)
        var difference = UInt8(expectedToken.count ^ candidateBytes.count)
        let count = max(expectedToken.count, candidateBytes.count)
        for index in 0..<count {
            let expected = index < expectedToken.count ? expectedToken[index] : 0
            let actual = index < candidateBytes.count ? candidateBytes[index] : 0
            difference |= expected ^ actual
        }
        return difference == 0
    }
}

public extension JSONDecoder {
    static var hostComputer: JSONDecoder {
        JSONDecoder()
    }
}

public extension JSONEncoder {
    static var hostComputer: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
