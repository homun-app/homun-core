import AppKit
import CryptoKit
import Foundation
import HomunComputerProtocol
import Security

struct RunningApplicationRecord: Sendable {
    let pid: Int32
    let processStartTimeUnixMs: Int64
    let displayName: String
    let bundleIdentifier: String?
    let signingIdentity: AppSigningIdentity?
    let activationPolicy: HostActivationPolicy
    let isActive: Bool
    let isHidden: Bool

    init(
        pid: Int32,
        processStartTimeUnixMs: Int64,
        displayName: String,
        bundleIdentifier: String?,
        signingIdentity: AppSigningIdentity? = nil,
        activationPolicy: HostActivationPolicy,
        isActive: Bool,
        isHidden: Bool
    ) {
        self.pid = pid
        self.processStartTimeUnixMs = processStartTimeUnixMs
        self.displayName = displayName
        self.bundleIdentifier = bundleIdentifier
        self.signingIdentity = signingIdentity
        self.activationPolicy = activationPolicy
        self.isActive = isActive
        self.isHidden = isHidden
    }
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
                signingIdentity: record.signingIdentity,
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
            signingIdentity: application.bundleURL.flatMap(resolveSigningIdentity),
            activationPolicy: HostActivationPolicy(application.activationPolicy),
            isActive: application.isActive,
            isHidden: application.isHidden
        )
    }
}

private func resolveSigningIdentity(bundleURL: URL) -> AppSigningIdentity? {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, [], &staticCode) == errSecSuccess,
          let staticCode else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [CFString: Any],
          let teamID = values[kSecCodeInfoTeamIdentifier] as? String,
          !teamID.isEmpty else { return nil }
    var requirement: SecRequirement?
    guard SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess,
          let requirement else { return nil }
    var text: CFString?
    guard SecRequirementCopyString(requirement, [], &text) == errSecSuccess,
          let requirementText = text as String? else { return nil }
    let digest = SHA256.hash(data: Data(requirementText.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
    return AppSigningIdentity(teamID: teamID, designatedRequirementSHA256: digest)
}
