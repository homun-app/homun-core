import Foundation
import HomunComputerProtocol
import Testing
@testable import HomunComputerServiceCore

@Test func captureDimensionsAreScaledAndBounded() {
    #expect(CaptureDimensions.normalized(width: 2_000, height: 1_000, scale: 2) == .init(width: 4_000, height: 2_000))
    #expect(CaptureDimensions.normalized(width: 10_000, height: 5_000, scale: 2) == .init(width: 8_192, height: 4_096))
}

@Test func captureWritesAnAtomicRelativePNGOnly() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let writer = CaptureArtifactWriter(root: root)

    let result = try writer.writePNG(Data([0x89, 0x50, 0x4E, 0x47]))

    #expect(!result.relativePath.contains("/"))
    #expect(result.relativePath.hasSuffix(".png"))
    #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(result.relativePath).path))
}

@Test func artifactWriterRejectsRootsThatAreFiles() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data().write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }

    #expect(throws: CaptureFailure.self) {
        _ = try CaptureArtifactWriter(root: file).writePNG(Data([1]))
    }
}
