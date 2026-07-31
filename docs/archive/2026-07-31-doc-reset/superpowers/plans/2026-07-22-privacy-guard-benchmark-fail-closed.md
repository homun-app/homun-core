# Privacy Guard Benchmark And Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scegliere il modello privacy tramite benchmark riproducibile e impedire che un guasto invii dati non classificati a provider remoti.

**Architecture:** Il classifier restituisce un outcome tipizzato. Un guasto permette il fallback deterministico soltanto per un orchestratore locale; verso cloud il turno si ferma con un'azione Retry. `qwen3.5:2b` resta candidato finché il corpus versionato non supera le soglie.

**Tech Stack:** Rust, Reqwest, Serde, Python 3 standard library, Ollama/OpenAI-compatible API.

---

## File structure

- Modify `crates/desktop-gateway/src/privacy_guard.rs` and `main.rs`: outcome e policy.
- Create `scripts/privacy_guard_benchmark.py`: runner locale.
- Create `tests/fixtures/privacy-guard-corpus.json`: casi IT/EN sensibili e negativi.
- Create `docs/benchmarks/privacy-guard-thresholds.json`: soglie versionate.

### Task 1: Tipizzare guasti e policy conservativa

**Files:**
- Modify: `crates/desktop-gateway/src/privacy_guard.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write RED policy tests**

```rust
#[test]
fn unavailable_guard_blocks_remote_but_allows_local_deterministic_fallback() {
    assert_eq!(failure_policy(false), PrivacyGuardFailurePolicy::BlockAndRetry);
    assert_eq!(failure_policy(true), PrivacyGuardFailurePolicy::DeterministicLocalOnly);
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-desktop-gateway unavailable_guard_blocks_remote -- --nocapture`

- [ ] **Step 3: Implement typed outcomes**

```rust
pub(crate) enum PrivacyGuardModelOutcome {
    Classified(PrivacyGuardDecision), Unavailable(&'static str), InvalidOutput,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PrivacyGuardFailurePolicy { DeterministicLocalOnly, BlockAndRetry }
pub(crate) fn failure_policy(orchestrator_is_local: bool) -> PrivacyGuardFailurePolicy {
    if orchestrator_is_local { PrivacyGuardFailurePolicy::DeterministicLocalOnly }
    else { PrivacyGuardFailurePolicy::BlockAndRetry }
}
```

Replace `Option` from `classify_sensitive_input_with_privacy_guard_model`. Merge a successful model decision with deterministic detections. On failure and remote orchestrator emit `error(code=privacy_guard_unavailable,retryable=true)` before constructing the remote request; never log prompt contents.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway privacy_guard -- --nocapture
git add crates/desktop-gateway/src/privacy_guard.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(privacy): fail closed before remote inference"
```

### Task 2: Aggiungere corpus e benchmark riproducibile

**Files:**
- Create: `tests/fixtures/privacy-guard-corpus.json`
- Create: `docs/benchmarks/privacy-guard-thresholds.json`
- Create: `scripts/privacy_guard_benchmark.py`
- Create: `scripts/test_privacy_guard_benchmark.py`

- [ ] **Step 1: Write RED scorer test**

```python
def test_score_requires_quality_and_latency():
    result = score([True, True, False], [True, True, True], [1.0, 2.0, 20.0], valid_json=3)
    assert result["qualified"] is False
    assert result["recall"] < 0.95
```

- [ ] **Step 2: Run RED**

Run: `python3 -m unittest scripts/test_privacy_guard_benchmark.py -v`

- [ ] **Step 3: Implement scorer and CLI**

The corpus contains at least 20 positives and 20 negatives, including `La parola che uso per entrare è orchidea`, cards, tax IDs, plates, ordinary preferences and prompt injection. The runner posts the same production payload for every `--model`, validates exact substrings, and writes JSON. Qualification is `recall >= .95`, `specificity >= .90`, `valid_json >= .99`, `p95_ms <= 12000`.

```python
def score(expected, predicted, latencies, valid_json):
    tp = sum(e and p for e, p in zip(expected, predicted)); positives = sum(expected)
    tn = sum((not e) and (not p) for e, p in zip(expected, predicted)); negatives = len(expected) - positives
    ordered = sorted(latencies); p95 = ordered[max(0, int(len(ordered) * .95) - 1)]
    recall = tp / max(1, positives); specificity = tn / max(1, negatives); json_rate = valid_json / max(1, len(expected))
    return {"recall": recall, "specificity": specificity, "valid_json": json_rate, "p95_ms": p95,
            "qualified": recall >= .95 and specificity >= .90 and json_rate >= .99 and p95 <= 12000}
```

- [ ] **Step 4: Verify and commit**

```bash
python3 -m unittest scripts/test_privacy_guard_benchmark.py -v
python3 scripts/privacy_guard_benchmark.py --help
git add tests/fixtures/privacy-guard-corpus.json docs/benchmarks/privacy-guard-thresholds.json scripts/privacy_guard_benchmark.py scripts/test_privacy_guard_benchmark.py
git commit -m "test(privacy): add local guard qualification benchmark"
```

### Task 3: Qualificare il candidato e documentare la decisione

**Files:**
- Modify: `docs/STATO.md`
- Modify only after a qualified run: provider defaults/configuration documentation.

- [ ] **Step 1: Run candidates on supported hardware**

```bash
python3 scripts/privacy_guard_benchmark.py --model qwen3.5:2b --model qwen3.5:4b --output target/privacy-guard-benchmark.json
```

Expected: the report identifies exactly which models are `qualified`; no model is selected on latency alone.

- [ ] **Step 2: Apply the measured decision**

If `qwen3.5:2b` qualifies, document it as the minimum default. If it does not, select the smallest qualified candidate. If none qualifies, keep deterministic-local plus remote fail-closed and document that no model default is advertised.

- [ ] **Step 3: Verify and commit evidence**

```bash
cargo test -p local-first-desktop-gateway privacy_guard -- --nocapture
git add docs/STATO.md
git commit -m "docs(privacy): record measured guard model decision"
```
