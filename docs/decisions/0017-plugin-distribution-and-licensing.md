# Decision 0017: Plugin distribution, signing and licensing

Date: 2026-06-24

## Status

Accepted (direction). First contracts are implemented in `local-first-capabilities`;
the in-app manager and hosted registry are still upcoming work.

## Context

ADR 0011 defines Homun as an agnostic local-first core with an addon ecosystem.
WS7 introduced plugin-shaped capabilities and WS9 turns that shape into a
distributable platform: versioned plugins, a website registry, signed packages,
beta channels, updates, and eventually paid plugins.

The important constraint is that distribution must not weaken the local-first
boundary. Installing a plugin is allowed to add panels, workflows, skills,
connectors or template catalogs, but it must not create a second capability
registry, bypass the approval model, or grant raw system access.

## Decision

1. **The Homun website hosts the registry; Homun remains the runtime authority.**
   The registry is an index of available packages, not a live control plane. The
   app downloads metadata/packages and verifies them locally.

2. **Every distributable plugin has two contracts.**
   `PluginManifest` describes the installed plugin: identity, semver, channel,
   minimum Homun version, entitlement and declared capabilities. `PluginRegistryEntry`
   describes a registry package: manifest URL, package URL, digest, signature and
   distribution metadata. `.hplugin` packages also carry a `PluginPackageManifest`
   that lists the internal manifest path and declared files.

3. **Install/update verification is deterministic.**
   The install candidate gate checks channel policy, Homun version compatibility,
   trusted public key allowlist, package digest and Ed25519 signature before a
   package can be staged for install. Heuristics are not allowed to decide
   installability.

4. **Beta is explicit opt-in.**
   Stable packages are visible by default. Beta packages are unavailable unless
   the user enables beta access for that plugin/channel in the manager.

5. **Paid is prepared locally; payment is later cloud.**
   `entitlement=paid` and offline-verifiable license tokens are part of the
   contract. License claims are verified locally with Ed25519 against the plugin
   target and expiry. The actual account/payment workflow can require
   cloud/always-on infrastructure later, but installed plugin execution remains
   local-first.

6. **Execution remains contained.**
   Package verification only says "this package is authentic and compatible".
   Runtime execution still goes through the capability host, permissions,
   approval gates and ADR 0009 containment. Package inspection reads
   `homun-package.json`, verifies declared file digests, and feeds text blobs to
   static security scan before activation; staging writes only declared files and
   is blocked by critical scan findings.

## Consequences

- The plugin manager can be built as UI plus fetch/cache/install plumbing over the
  shared contracts; it should not embed separate routing or trust logic.
- Third-party/plugin marketplace work has a clear progression: signed-by-Homun
  free/beta plugins first, paid entitlements second, external payment/review
  process later.
- `make_deck`, `make_document`, template catalogs and future deliverable plugins
  can converge on the same distribution mechanism without becoming separate
  memory or capability systems.

## Non-goals

- No arbitrary untrusted code execution as part of this decision.
- No payment processor or account backend in the local-only WS9 slices.
- No second registry for templates, skills or workflows: they are plugin
  capabilities inside the unified capability registry.
