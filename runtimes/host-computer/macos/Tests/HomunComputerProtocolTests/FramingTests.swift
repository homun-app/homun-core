import Foundation
import Testing
@testable import HomunComputerProtocol

@Test func frameUsesFourByteBigEndianLength() throws {
    let payload = Data("hello".utf8)
    let frame = try FrameCodec.encode(payload)

    #expect(Array(frame.prefix(4)) == [0, 0, 0, 5])
    #expect(try FrameCodec.decode(frame) == payload)
}

@Test func emptyFrameIsRejected() {
    #expect(throws: ProtocolFailure.invalidRequest) {
        try FrameCodec.encode(Data())
    }
}

@Test func oversizedLengthIsRejectedBeforeBodyRead() {
    let length = UInt32(FrameCodec.maximumPayloadBytes + 1).bigEndian
    let header = withUnsafeBytes(of: length) { Data($0) }

    #expect(throws: ProtocolFailure.payloadTooLarge) {
        try FrameCodec.decode(header)
    }
}

@Test func truncatedFrameIsRejected() {
    let header = withUnsafeBytes(of: UInt32(20).bigEndian) { Data($0) }

    #expect(throws: ProtocolFailure.invalidRequest) {
        try FrameCodec.decode(header + Data("short".utf8))
    }
}
