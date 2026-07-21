import AppKit
import Foundation
import HomunComputerProtocol

struct RunningApplicationRecord: Sendable {
    let pid: Int32
    let processStartTimeUnixMs: Int64
    let displayName: String
    let bundleIdentifier: String?
    let activationPolicy: HostActivationPolicy
    let isActive: Bool
    let isHidden: Bool
}

struct ResolvedList<Item: Sendable>: Sendable {
    let items: [Item]
    let truncated: Bool
}

enum ApplicationResolver {
    static func resolve(
        _ records: [RunningApplicationRecord],
        includeBackground: Bool,
        limit: Int
    ) -> ResolvedList<HostApplication> {
        let sorted = records
            .filter { includeBackground || $0.activationPolicy != .prohibited }
            .sorted {
                let comparison = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                return comparison == .orderedSame
                    ? $0.pid < $1.pid
                    : comparison == .orderedAscending
            }
        let bounded = sorted.prefix(max(0, limit)).map { record in
            HostApplication(
                identity: ApplicationIdentity(
                    pid: record.pid,
                    processStartTimeUnixMs: record.processStartTimeUnixMs
                ),
                displayName: record.displayName,
                bundleID: record.bundleIdentifier,
                activationPolicy: record.activationPolicy,
                isActive: record.isActive,
                isHidden: record.isHidden
            )
        }
        return ResolvedList(items: Array(bounded), truncated: sorted.count > bounded.count)
    }
}

private extension HostActivationPolicy {
    init(_ policy: NSApplication.ActivationPolicy) {
        switch policy {
        case .regular: self = .regular
        case .accessory: self = .accessory
        case .prohibited: self = .prohibited
        @unknown default: self = .prohibited
        }
    }
}

extension RunningApplicationRecord {
    init(_ application: NSRunningApplication) {
        let launchDate = application.launchDate?.timeIntervalSince1970 ?? 0
        self.init(
            pid: application.processIdentifier,
            processStartTimeUnixMs: Int64(launchDate * 1_000),
            displayName: application.localizedName
                ?? application.bundleURL?.deletingPathExtension().lastPathComponent
                ?? "Process \(application.processIdentifier)",
            bundleIdentifier: application.bundleIdentifier,
            activationPolicy: HostActivationPolicy(application.activationPolicy),
            isActive: application.isActive,
            isHidden: application.isHidden
        )
    }
}
