import Foundation

public final class ElementRegistry: @unchecked Sendable {
    private struct EntryKey: Hashable {
        var snapshotID: String
        var generation: UInt64
        var index: UInt32
    }

    private struct SnapshotKey: Hashable {
        var snapshotID: String
        var generation: UInt64
    }

    private let lock = NSLock()
    private var nextGenerationBySession: [String: UInt64] = [:]
    private var activeSnapshotBySession: [String: String] = [:]
    private var entries: [EntryKey: any AXNodeSource] = [:]
    private var activeSnapshots: Set<SnapshotKey> = []

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
            activeSnapshots = activeSnapshots.filter { $0.snapshotID != priorSnapshotID }
        }

        let generation = (nextGenerationBySession[sessionID] ?? 0) + 1
        nextGenerationBySession[sessionID] = generation
        activeSnapshotBySession[sessionID] = snapshotID
        activeSnapshots.insert(SnapshotKey(snapshotID: snapshotID, generation: generation))
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

    public func contains(snapshotID: String, generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeSnapshots.contains(SnapshotKey(snapshotID: snapshotID, generation: generation))
    }

    public func invalidate(snapshotID: String, generation: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        activeSnapshots.remove(SnapshotKey(snapshotID: snapshotID, generation: generation))
        entries = entries.filter {
            $0.key.snapshotID != snapshotID || $0.key.generation != generation
        }
    }
}
