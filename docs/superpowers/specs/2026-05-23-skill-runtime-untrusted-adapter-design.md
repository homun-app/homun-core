# Skill Runtime Untrusted Adapter Design

## Goal

Add a WASM runner adapter for untrusted local skills, with runtime-enforced isolation stronger than the trusted process runner.

## Scope

This block implements a minimal no-host-import WASM adapter. It does not add WASI yet. The point is to run pure WASM skill modules with bounded memory, fuel metering, no filesystem, no network and no inherited process environment.

## Architecture

Add `WasmSkillRunner` to `crates/skill-runtime`.

The adapter:

- accepts a compiled `.wasm` module from a configured path.
- rejects module paths outside allowed roots.
- builds a Wasmtime engine with fuel consumption enabled.
- rejects modules with imports, because imports are host capability requests and must be designed explicitly later.
- requires an exported memory named `memory`.
- writes the serialized `SkillRuntimeRequest` JSON into guest memory at offset `0`.
- calls exported `run(input_ptr: i32, input_len: i32) -> i64`.
- interprets return as `(output_ptr << 32) | output_len`.
- reads `SkillRuntimeOutput` JSON from guest memory.
- enforces max output bytes before JSON parsing.
- lets `SkillRuntime` perform the existing post-run trace/output validation.

## Security Model

This adapter improves over the process runner for untrusted code because the module has no OS process privileges and no host imports. Network and filesystem access are impossible unless a future host import/WASI capability is explicitly added.

The runtime still applies the same defense-in-depth:

- manifest permission validation before execution.
- fuel limit during execution.
- memory/output size limit.
- post-run trace validation.

## Non-Goals

- no WASI.
- no network host imports.
- no filesystem preopens.
- no dynamic plugin download.
- no language-specific SDK.

## Future Work

A later WASI adapter can add capability-based preopens and network host functions. That must be a separate block because the host import surface becomes part of the security model.
