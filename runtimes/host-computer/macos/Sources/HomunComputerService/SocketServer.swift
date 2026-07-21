import Darwin
import Foundation
import HomunComputerProtocol
import HomunComputerServiceCore

struct SocketServer {
    let socketPath: String
    let router: RequestRouter

    func run() throws {
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw ServiceFailure.systemCall("socket") }
        defer { close(listener) }

        try removeOwnedSocketIfPresent()
        var address = try unixAddress(path: socketPath)
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else { throw ServiceFailure.systemCall("bind") }
        guard chmod(socketPath, 0o600) == 0 else { throw ServiceFailure.systemCall("chmod") }
        guard listen(listener, 8) == 0 else { throw ServiceFailure.systemCall("listen") }
        defer { unlink(socketPath) }

        while true {
            let client = accept(listener, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                throw ServiceFailure.systemCall("accept")
            }
            autoreleasepool {
                defer { close(client) }
                handle(client: client)
            }
        }
    }

    private func handle(client: Int32) {
        guard let header = try? readExactly(client, count: 4) else { return }
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0, length <= FrameCodec.maximumPayloadBytes else { return }
        guard let body = try? readExactly(client, count: Int(length)) else { return }
        let response = router.route(body)
        guard let frame = try? FrameCodec.encode(response) else { return }
        try? writeAll(client, data: frame)
    }

    private func removeOwnedSocketIfPresent() throws {
        var info = stat()
        guard lstat(socketPath, &info) == 0 else {
            if errno == ENOENT { return }
            throw ServiceFailure.systemCall("lstat")
        }
        guard info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
            throw ServiceFailure.unsafePath
        }
        guard unlink(socketPath) == 0 else { throw ServiceFailure.systemCall("unlink") }
    }
}

private func unixAddress(path: String) throws -> sockaddr_un {
    let bytes = Array(path.utf8CString)
    var address = sockaddr_un()
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw ServiceFailure.socketPathTooLong
    }
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.initializeMemory(as: UInt8.self, repeating: 0)
        destination.copyBytes(from: bytes.map(UInt8.init(bitPattern:)))
    }
    return address
}

private func readExactly(_ descriptor: Int32, count: Int) throws -> Data {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
        let readCount = data.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), count - offset)
        }
        if readCount == 0 { throw ServiceFailure.unexpectedEOF }
        if readCount < 0 {
            if errno == EINTR { continue }
            throw ServiceFailure.systemCall("read")
        }
        offset += readCount
    }
    return data
}

private func writeAll(_ descriptor: Int32, data: Data) throws {
    var offset = 0
    while offset < data.count {
        let written = data.withUnsafeBytes { bytes in
            Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset)
        }
        if written < 0 {
            if errno == EINTR { continue }
            throw ServiceFailure.systemCall("write")
        }
        offset += written
    }
}

enum ServiceFailure: Error {
    case invalidArguments
    case unsafePath
    case socketPathTooLong
    case unexpectedEOF
    case systemCall(String)
}
