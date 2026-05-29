# Decision 0007: Inference Provider Routing (local-first, cloud-delegating)

Date: 2026-05-28

## Status

Accepted.

## Context

The project's Fase 1 assumed a single local LLM runtime: a Python/MLX sidecar
running Gemma 4 E4B, exposed over a local HTTP contract (`/generate_json`,
`/tool_call`, `/analyze_image`, `/generate_stream`, `/warmup`, `/health`).

Two pressures break that single-runtime assumption:

1. **Hardware and OS spread.** The product must run on small/old machines and on
   macOS, Windows and Linux. MLX is Apple-Silicon only. A weak 4B model is not
   enough for agentic browser planning (confirmed live on Trenitalia: the model
   followed the injected plan but could not reliably drive autocomplete/date
   widgets), while a strong model does not fit small hardware.

2. **"Everything local always" is not achievable.** Some tasks (hard multi-step
   planning, high-quality vision/OCR, long-context synthesis) need more capable
   models than a given device can run. The product still wants local-first by
   default, with cloud as an explicit, opt-in boundary — the same principle
   PROJECT.md already states for managed connectors.

Vision is in scope (desktop observation, screenshot/OCR, VisionAgent), so vision
must be available at every tier, not only on the Mac VLM.

## Decision

Replace the single MLX runtime with an **inference provider abstraction** owned
by the Rust Core. The rest of the system keeps the existing runtime contract;
only the thing behind it changes.

### Two roles, decided independently

- **Router + policy/privacy gate — always Rust Core.** Choosing local vs cloud,
  enforcing deny-by-default cloud delegation, redacting what leaves the device,
  and auditing every delegation is the security boundary. PROJECT.md requires
  Rust to own policy/execution/approval/audit, so this never moves into an
  external tool (e.g. LiteLLM) even though such tools exist.
- **Engine — pluggable behind a trait.** The local inference engine is a
  per-deployment choice, not a language commitment.

### Local engine: mistral.rs (Rust-native), llama.cpp as fallback

- Primary local engine: **mistral.rs** — pure-Rust, multimodal/vision, runs on
  Metal + CUDA + CPU (down to low-end devices), OpenAI-compatible surface,
  in-process (no Python sidecar to package). This directly serves the
  small-hardware / multi-OS / vision requirements with a single binary.
- Fallback local engine: **llama.cpp via Rust bindings (`llama-cpp-2`)** — added
  later, in Rust, when mistral.rs lacks a model or where llama.cpp's broader
  hardware coverage (e.g. Vulkan on old/Intel/AMD GPUs) is needed.
- **MLX/Python** is demoted from "the runtime" to an *optional* Apple-Silicon
  performance provider that already speaks the HTTP contract. It is no longer
  required and is not the cross-platform path.
- A **Python provider** (transformers/vLLM) is allowed only as an optional,
  opt-in provider for models that exist solely in that ecosystem — never the
  backbone, because of desktop packaging cost.

### Cloud delegation: two adapters cover the targets

- **OpenAI-compatible adapter** (`base_url` + key): OpenAI, OpenRouter, Together,
  Groq, and — via the same adapter — **Ollama local** (`127.0.0.1:11434/v1`) and
  **Ollama Cloud** (`ollama.com/v1`).
- **Anthropic adapter**: Claude, as the premium agentic/vision/OCR provider.

### Tiered routing

- Tier 0 (always local, fast): intent, JSON extraction, classification,
  redaction decisions.
- Tier 1 (local capable): browser action decisions, memory/routine extraction —
  best local model the hardware tier allows.
- Tier 2 (delegate, opt-in, gated): hard planning, complex tool orchestration,
  long-context synthesis, high-quality vision.

Routing inputs: required capability (vision? long context? tool-calling?),
hardware tier, **privacy/policy**, cost, latency.

## Contract To Preserve

The router implements the traits the system already consumes so Brain,
subagents and the desktop gateway do not change:

- `JsonRuntime::generate_json` (used by e.g. `RuntimeBrowserLoopPlanner`),
- `TextRuntime` / `TextStreamRuntime`, `IntentRuntime`,
- image analysis (`analyze_image`) and `tool_call`,
- warmup/health/cancel.

Each provider also exposes a **capability descriptor**: context window, vision
yes/no, tool-calling quality, rough tokens/s, local vs cloud, cost, privacy
boundary. The router selects on these plus policy.

## Where It Lands

- New `crates/inference`: `trait InferenceProvider`, capability descriptor,
  `ModelRouter` (implements the existing runtime traits), policy/privacy gate.
- Providers: `LocalProvider` (mistral.rs), `OpenAiCompatProvider`,
  `AnthropicProvider`; later `LlamaCppProvider`, optional `MlxProvider`,
  optional Python provider.
- Reuse existing infrastructure: API keys in `local-first-secrets`
  (`secret_ref` only), `PolicyContext` for the cloud gate, SQLite registry for
  provider config/grants — the same patterns the Capability Layer already uses.

## Hardware Tiers (model profiles)

Detect RAM/GPU at startup and pick a local model profile; fall back to cloud
when no adequate local model fits:

- `lite` (<=8 GB): small vision model (e.g. moondream / Qwen2.5-VL-3B class).
- `standard` (~16 GB): mid vision model (~7B class).
- `pro` (Apple Silicon 24 GB+): larger local model.
- `delegate`: insufficient local hardware -> opt-in cloud.

## Non-Scope

- Do not move routing/policy into an external tool (LiteLLM, an Ollama daemon's
  own routing, etc.). Rust owns the boundary.
- Do not make Python the backbone; keep it as an optional provider only.
- Do not add new providers before the trait + router + one local + one cloud
  path are proven by an A/B against the current MLX runtime.

## Consequences

Positive:

- Cross-OS and small-hardware support via a single Rust binary engine.
- Vision available at every tier.
- Local-first preserved; cloud is explicit, gated, audited.
- Brain/subagents/gateway untouched (same traits).

Risks:

- mistral.rs is younger than llama.cpp; model coverage may lag and Metal
  performance may trail MLX on Apple.
- Heavy build features (CUDA/Metal) can slow the workspace build.

Mitigation:

- `llama-cpp-2` fallback behind the same trait when needed.
- Feature-gate heavy local engines so they do not bloat default builds.
- Ship the router + cloud adapter first (no heavy deps) and A/B before
  committing to the in-process local engine.
```
