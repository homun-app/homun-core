import Foundation

public enum FrameCodec {
    public static let maximumPayloadBytes = 8 * 1024 * 1024

    public static func encode(_ payload: Data) throws -> Data {
        guard !payload.isEmpty else {
            throw ProtocolFailure.invalidRequest
        }
        guard payload.count <= maximumPayloadBytes else {
            throw ProtocolFailure.payloadTooLarge
        }

        var length = UInt32(payload.count).bigEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(payload)
        return frame
    }

    public static func decode(_ frame: Data) throws -> Data {
        guard frame.count >= 4 else {
            throw ProtocolFailure.invalidRequest
        }
        let length = frame.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0 else {
            throw ProtocolFailure.invalidRequest
        }
        guard length <= maximumPayloadBytes else {
            throw ProtocolFailure.payloadTooLarge
        }
        guard frame.count == Int(length) + 4 else {
            throw ProtocolFailure.invalidRequest
        }
        return frame.dropFirst(4)
    }
}
