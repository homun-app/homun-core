import Foundation

public final class ElementRegistry: @unchecked Sendable {
    private struct EntryKey: Hashable {
        var snapshotID: String
        var generation: UInt64
        var index: UInt32
    }

    private let lock = NSLock()
    private var nextGenerationBySession: [String: UInt64] = [:]
    private var activeSnapshotBySession: [String: String] = [:]
    private var entries: [EntryKey: any AXNodeSource] = [:]

    public init() {}

    @discardableResult
    public func install(
        sessionID: String,
        snapshotID: String,
        nodes: [any AXNodeSource]
    ) -> UInt64 {
        lock.lock()
        defer { lock.unlock() }

        if let priorSnapshotID = activeSnapshotBySession[sessionID] {
            entries = entries.filter { $0.key.snapshotID != priorSnapshotID }
        }

        let generation = (nextGenerationBySession[sessionID] ?? 0) + 1
        nextGenerationBySession[sessionID] = generation
        activeSnapshotBySession[sessionID] = snapshotID
        for (offset, node) in nodes.enumerated() {
            entries[EntryKey(
                snapshotID: snapshotID,
                generation: generation,
                index: UInt32(offset)
            )] = node
        }
        return generation
    }

    public func resolve(
        snapshotID: String,
        generation: UInt64,
        index: UInt32
    ) -> (any AXNodeSource)? {
        lock.lock()
        defer { lock.unlock() }
        return entries[EntryKey(snapshotID: snapshotID, generation: generation, index: index)]
    }
}
