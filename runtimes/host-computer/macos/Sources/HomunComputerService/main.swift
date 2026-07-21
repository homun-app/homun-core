import Darwin
import Foundation
import HomunComputerServiceCore

struct ServiceConfiguration {
    let socketPath: String
    let tokenFile: String
    let parentPID: pid_t
    let artifactRoot: URL

    init(arguments: [String]) throws {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
                return nil
            }
            return arguments[index + 1]
        }

        guard
            let socketPath = value(after: "--socket"),
            let tokenFile = value(after: "--auth-token-file"),
            let parent = value(after: "--parent-pid"),
            let parentPID = pid_t(parent)
        else { throw ServiceFailure.invalidArguments }

        self.socketPath = socketPath
        self.tokenFile = tokenFile
        self.parentPID = parentPID
        artifactRoot = URL(
            fileURLWithPath: value(after: "--artifact-root")
                ?? URL(fileURLWithPath: tokenFile).deletingLastPathComponent()
                    .appendingPathComponent("artifacts", isDirectory: true).path,
            isDirectory: true
        )
    }
}

func consumeTokenFile(at path: String) throws -> String {
    var fileInfo = stat()
    var parentInfo = stat()
    let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
    guard lstat(path, &fileInfo) == 0, lstat(parent, &parentInfo) == 0 else {
        throw ServiceFailure.unsafePath
    }
    guard
        fileInfo.st_uid == geteuid(),
        parentInfo.st_uid == geteuid(),
        fileInfo.st_mode & 0o077 == 0,
        parentInfo.st_mode & 0o077 == 0
    else { throw ServiceFailure.unsafePath }

    let token = try String(contentsOfFile: path, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty else { throw ServiceFailure.unsafePath }
    guard unlink(path) == 0 else { throw ServiceFailure.systemCall("unlink token") }
    return token
}

do {
    signal(SIGPIPE, SIG_IGN)
    let configuration = try ServiceConfiguration(arguments: CommandLine.arguments)
    guard kill(configuration.parentPID, 0) == 0 else { throw ServiceFailure.invalidArguments }
    // The helper is launched through LaunchServices, so it is not a normal child of
    // the gateway. Exit as soon as the authenticated parent disappears; this makes
    // app quit and factory reset release the event tap, socket, and TCC-using process.
    Thread.detachNewThread {
        while true {
            Thread.sleep(forTimeInterval: 1)
            if kill(configuration.parentPID, 0) != 0 {
                exit(0)
            }
        }
    }
    let token = try consumeTokenFile(at: configuration.tokenFile)
    let takeover = InputTakeoverMonitor(eventMarker: Int64.random(in: 1...Int64.max))
    let eventTap = SystemInputEventTap(monitor: takeover)
    _ = eventTap.start()
    let sessionMonitor = HostSessionMonitor(takeover: takeover)
    sessionMonitor.start()
    try withExtendedLifetime((eventTap, sessionMonitor)) {
        try SocketServer(
            socketPath: configuration.socketPath,
            router: RequestRouter(
                sessionToken: token,
                artifactRoot: configuration.artifactRoot,
                takeoverMonitor: takeover
            )
        ).run()
    }
} catch {
    FileHandle.standardError.write(Data("Homun Computer Service failed to start\n".utf8))
    exit(1)
}
