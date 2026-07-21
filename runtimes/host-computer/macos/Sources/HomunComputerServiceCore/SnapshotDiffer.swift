import HomunComputerProtocol

public enum SnapshotDiffer {
    public static func diff(base: [HostElement], current: [HostElement]) -> SnapshotDiff {
        let baseByIndex = Dictionary(uniqueKeysWithValues: base.map { ($0.index, $0) })
        let currentByIndex = Dictionary(uniqueKeysWithValues: current.map { ($0.index, $0) })

        let inserted = current
            .filter { baseByIndex[$0.index] == nil }
            .sorted { $0.index < $1.index }
        let updated = current
            .filter { currentElement in
                baseByIndex[currentElement.index].map { $0 != currentElement } ?? false
            }
            .sorted { $0.index < $1.index }
        let removed = base
            .filter { currentByIndex[$0.index] == nil }
            .map(\.index)
            .sorted()
        return SnapshotDiff(inserted: inserted, updated: updated, removedIndices: removed)
    }

    public static func apply(_ diff: SnapshotDiff, to base: [HostElement]) -> [HostElement] {
        var result = Dictionary(uniqueKeysWithValues: base.map { ($0.index, $0) })
        for index in diff.removedIndices {
            result.removeValue(forKey: index)
        }
        for element in diff.updated + diff.inserted {
            result[element.index] = element
        }
        return result.values.sorted { $0.index < $1.index }
    }
}
