import CoreGraphics
import Foundation
import HomunComputerProtocol
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

public struct CaptureDimensions: Equatable, Sendable {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public static func normalized(
        width: Double,
        height: Double,
        scale: Double,
        maximum: Int = 8_192
    ) -> CaptureDimensions {
        let requestedWidth = max(1, Int((width * scale).rounded()))
        let requestedHeight = max(1, Int((height * scale).rounded()))
        let reduction = min(1, Double(maximum) / Double(max(requestedWidth, requestedHeight)))
        return CaptureDimensions(
            width: max(1, Int((Double(requestedWidth) * reduction).rounded())),
            height: max(1, Int((Double(requestedHeight) * reduction).rounded()))
        )
    }
}

public enum CaptureFailure: Error, Equatable, Sendable {
    case permissionDenied
    case windowNotFound
    case invalidArtifactRoot
    case encodingFailed
    case captureFailed
}

public struct CaptureArtifactWriter: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public func writePNG(_ data: Data) throws -> StagedCapture {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory)
        if exists && !isDirectory.boolValue {
            throw CaptureFailure.invalidArtifactRoot
        }
        do {
            if !exists {
                try FileManager.default.createDirectory(
                    at: root,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
            }
            let filename = "capture-\(UUID().uuidString.lowercased()).png"
            let destination = root.appendingPathComponent(filename, isDirectory: false)
            try data.write(to: destination, options: [.atomic])
            return StagedCapture(relativePath: filename)
        } catch let failure as CaptureFailure {
            throw failure
        } catch {
            throw CaptureFailure.invalidArtifactRoot
        }
    }
}

@available(macOS 14.0, *)
public struct ScreenCaptureService: Sendable {
    private let writer: CaptureArtifactWriter

    public init(artifactRoot: URL) {
        writer = CaptureArtifactWriter(root: artifactRoot)
    }

    public func capture(windowID: CGWindowID, scale: Double = 2) async throws -> StagedCapture {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: false
            )
        } catch {
            throw CaptureFailure.permissionDenied
        }
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw CaptureFailure.windowNotFound
        }

        let dimensions = CaptureDimensions.normalized(
            width: window.frame.width,
            height: window.frame.height,
            scale: scale
        )
        let configuration = SCStreamConfiguration()
        configuration.width = dimensions.width
        configuration.height = dimensions.height
        configuration.showsCursor = false
        configuration.captureResolution = .best
        let filter = SCContentFilter(desktopIndependentWindow: window)

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw CaptureFailure.captureFailed
        }
        return try writer.writePNG(try pngData(image))
    }

    private func pngData(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data,
                UTType.png.identifier as CFString,
                1,
                nil
            )
        else { throw CaptureFailure.encodingFailed }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureFailure.encodingFailed
        }
        return data as Data
    }
}

private final class CaptureResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<StagedCapture, Error>?

    func store(_ result: Result<StagedCapture, Error>) {
        lock.lock()
        self.result = result
        lock.unlock()
    }

    func load() -> Result<StagedCapture, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return result
    }
}

public struct BlockingCaptureRunner: Sendable {
    private let service: ScreenCaptureService

    public init(service: ScreenCaptureService) {
        self.service = service
    }

    public func capture(windowID: CGWindowID, timeout: TimeInterval = 5) throws -> StagedCapture {
        let semaphore = DispatchSemaphore(value: 0)
        let box = CaptureResultBox()
        Task.detached {
            do {
                box.store(.success(try await service.capture(windowID: windowID)))
            } catch {
                box.store(.failure(error))
            }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw CaptureFailure.captureFailed
        }
        return try box.load()!.get()
    }
}
