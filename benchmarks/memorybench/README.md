# Homun MemoryBench provider

This adapter implements MemoryBench's public `Provider` contract against the local Homun desktop gateway.

It deliberately accepts only `localhost`, `127.0.0.0/8`, or `::1`. Every run uses an isolated benchmark project, search returns only current memories with provenance, and `clear` calls Homun's governed workspace deletion route.

Run the deterministic contract tests:

```sh
cd benchmarks/memorybench/homun-provider
npm test
```

To use the provider from MemoryBench, register `HomunProvider` in its provider registry and initialize it with the desktop gateway URL and token. The live benchmark endpoints are disabled unless Homun is started with `HOMUN_MEMORYBENCH_ENABLED=1`.

The opt-in governance suite covers project isolation, direct grant and revoke, update history, repeated ingest, temporal expiry, abstention, and Vault non-leakage. Model-backed benchmark runs remain opt-in and are not part of the deterministic release gate.
