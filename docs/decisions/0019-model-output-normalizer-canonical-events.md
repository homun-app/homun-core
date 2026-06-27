# Decision 0019: NormalizerStage — un solo formato canonico per l'output dei modelli (anti-corruption, serde-typed)

Date: 2026-06-27

## Status

Proposed. Estende il caposaldo della [0016](0016-harness-owned-task-engine-cross-model.md)
("l'harness possiede control-flow, stato e **formato**") portandolo dove oggi NON è
applicato: il **confine di ingresso** della risposta del modello. È il fix
**sistemico** della classe di bug che oggi inseguiamo a uno a uno (lingua,
reasoning che sparisce, proposta-piano non renderizzata).

## Perché questa decisione esiste

L'adattamento al formato dei modelli oggi è **sparpagliato** e in parte nel posto
sbagliato:

- **Gateway, in funzioni separate**: `reassemble_openai_stream` (fallback
  `reasoning_content`), `sanitize_model_text` (`<think>`/`<tool_call>`),
  `parse_plan_marker` (solo `‹‹PLAN››`), l'hack `thinking:disabled`
  **per-z.ai** (`is_zai_base`/`build_chat_payload`), `to_ollama_messages`
  (shape native vs OpenAI).
- **Frontend, a regex**: `ChatView.tsx` parsa **a mano** `‹‹PLAN_PROPOSE››`,
  `‹‹GOAL_PROPOSE››`, `‹‹CHOICES››`, `‹‹PLAN››`, `‹‹COMPOSIO_*››`, `‹‹MCP_CONFIRM››`,
  `‹‹FS_AUTHORIZE››`, `‹‹CONNECT_SUGGEST››` — e fa la coercizione dei tipi (es. step
  stringa-vs-oggetto).

Conseguenze osservate (tutte lo stesso difetto sotto mentite spoglie):

1. **Doppio parsing dei marker** (`parse_plan_marker` backend + `PLAN_PROPOSE_RE`
   frontend) → due tolleranze diverse → gemma propone `steps` come **oggetti**, il
   filtro frontend li scarta, la card resta vuota ("il piano non si attiva").
2. **content vuoto + answer in `reasoning_content`** (GLM thinking, kimi-code) → la
   risposta "sparisce" lasciando solo i Sources.
3. **Adattare il frontend ad ogni modello** invece di migliorare un punto solo.

Ogni nuovo modello/quirk costringe a toccare N punti, frontend incluso. Non scala.

## Lo stato dell'arte

Pattern: **Anti-Corruption Layer** + **"Parse, don't validate"** (Wlaschin). Il
confine col modello mappa input permissivo → un **tipo canonico provabilmente
valido**; verso l'interno gira **solo** il canonico. È il "Pydantic" del caso, ma in
Rust è più forte: Pydantic valida a **runtime**, qui i **tipi sono lo schema**
(compile-time) e gli **stati illegali sono irrappresentabili** — una volta costruito
il `Canonical`, è valido per costruzione.

Toolchain idiomatica (niente engine di schema a runtime):

- **serde** = parser permissivo. `#[serde(untagged)]` per "stringa O oggetto",
  `#[serde(alias=…)]`, `#[serde(default)]`, unknown-fields ignorati (forward-compat).
- **`TryFrom<Raw> for Canonical`** = il confine: coercizione + validazione esplicita.
- `garde` solo se servono vincoli extra; di norma `TryFrom` basta.

## Decisione

Un **`model_normalize` stage** nel gateway. Ogni risposta del modello passa di lì e
ne esce in **un solo formato canonico**; il frontend smette di parsare il testo dei
modelli e renderizza **eventi tipizzati**.

### Pilastro 1 — Tipi `Raw*` permissivi (serde) → `Canonical*` strict (`TryFrom`)

```rust
// loose (accetta le varianti dei modelli)            // strict (illegal states unrepresentable)
#[derive(Deserialize)]
#[serde(untagged)]
enum RawStep { Label(String), Rich { title: String, #[serde(default)] detail: String } }

#[derive(Deserialize)]
struct RawPlanPropose { #[serde(default)] summary: String, #[serde(default)] steps: Vec<RawStep> }

struct PlanProposed { summary: String, steps: Vec<String> }

impl TryFrom<RawPlanPropose> for PlanProposed {
    type Error = NormalizeError;
    fn try_from(r: RawPlanPropose) -> Result<Self, Self::Error> {
        let steps = r.steps.into_iter()
            .map(|s| match s { RawStep::Label(t) => t, RawStep::Rich { title, .. } => title })
            .filter(|s| !s.trim().is_empty()).collect::<Vec<_>>();
        if steps.is_empty() { return Err(NormalizeError::EmptyPlan); }
        Ok(PlanProposed { summary: r.summary, steps })
    }
}
```

Gli altri quirk diventano la **stessa cosa, in un posto**:
- `content` vs `reasoning_content` → `RawMessage { content: Option<String>,
  #[serde(alias="reasoning")] reasoning_content: Option<String> }` + `TryFrom` che
  prende `content` else `reasoning`.
- tool-args **stringa o oggetto** → `#[serde(untagged)] enum RawArgs { Str(String), Obj(Map) }`.
- `<think>…</think>` → strip nel `TryFrom`.

### Pilastro 2 — Eventi tipizzati nello stream (il frontend smette di parsare)

Il gateway emette un enum, non testo con marker:

```rust
enum TurnEvent {
    Text(String),
    Reasoning(String),                 // separato, non mischiato al testo
    ToolCall { name: String, args: serde_json::Value },
    PlanProposed(PlanProposed),        // ex ‹‹PLAN_PROPOSE››
    PlanUpdated(Plan),                 // ex ‹‹PLAN››
    Choices(ChoicePrompt),             // ex ‹‹CHOICES››
    ConnectSuggest(ConnectSuggest),    // ex ‹‹CONNECT_SUGGEST››
    Confirm(ConfirmCard),              // ex ‹‹MCP_CONFIRM››/‹‹FS_AUTHORIZE››/‹‹COMPOSIO_*››
    GoalProposed(Vec<String>),         // ex ‹‹GOAL_PROPOSE››
}
```

`AssistantTurn { text, reasoning, tool_calls, events }` è il payload autoritativo del
`Done`. **Tutte** le regex di `ChatView.tsx` (lista sopra) vengono cancellate: il
frontend fa `switch(event.kind)`.

### Pilastro 3 — Due fasi (lo streaming è la parte dura, non confonderle)

serde valida un JSON **completo**; l'output è **streaming/parziale**:

1. **Live** — una piccola **macchina a stati** sui token: rileva marker e tag che si
   spezzano tra chunk (rischio UTF-8/tag-parziale già notato), emette `Text`/
   `Reasoning` parziali per la UX e bufferizza i blocchi marker finché chiusi.
2. **Turn completo** — parse serde+`TryFrom` sul messaggio riassemblato → `AssistantTurn`
   + eventi finali autoritativi (il `Done` che committa).

### Pilastro 4 — I quirk per-modello si centralizzano (non si eliminano)

L'hack `thinking:disabled` per-z.ai resta legittimo (è una *request option*, non
parsing), ma vive accanto agli altri adattamenti in `model_normalize`, con un
**registro per-provider** documentato, non sparso.

## Quirk noti (fixture di regressione — popolazione bi/tri-modello)

| Quirk | Modello/i | Oggi | Canonico |
|---|---|---|---|
| `steps` oggetti vs stringhe | gemma4 | filtro frontend li scarta | `RawStep` untagged → `label()` |
| answer in `reasoning_content`, `content` vuoto | GLM thinking, kimi-code | risposta sparisce | `TryFrom` content-else-reasoning |
| `<think>…</think>` nel content | qwen/deepseek-r1, kimi | leak live | strip + evento `Reasoning` separato |
| tool-call args come **stringa** JSON | vari OpenAI-compat | re-parse ad-hoc | `RawArgs` untagged |
| `thinking` ON di default | z.ai GLM | hack per-provider | request-option nel registro |
| marker piano `‹‹PLAN_PROPOSE››`/`‹‹PLAN››` | tutti | 2 parser (be+fe) | 1 parser → `PlanProposed`/`PlanUpdated` |

Gate: `scripts/eval_suite.py` resta il contratto; aggiungere **fixture di output
reali** (kimi/gemma/glm catturati) come snapshot test del normalizer.

## Conseguenze

Positive:
- Un nuovo modello/quirk = **una modifica in `model_normalize`**, mai nel frontend.
- Stati illegali irrappresentabili → niente "card vuota"/"risposta vuota" silenziose.
- Cancellazione del parsing-a-regex nel frontend (debito tecnico + fonte di bug).

Rischi / mitigazioni:
- **Streaming/partial** è il costo reale → fase 2 separata, dietro test, non big-bang.
- **Canonico troppo rigido** → tienilo un **enum di eventi estendibile**, non una
  struct chiusa.
- **Regressioni di rendering** → migrazione marker-per-marker, fixture prima.

## Sequenza incrementale (dietro test, verde a ogni passo)

1. ☐ **Modulo `model_normalize`** + tipi `Raw*`/`Canonical*` + `TryFrom`, con i quirk
   già risolti tatticamente (gemma steps, reasoning_content) **spostati** lì.
2. ☐ **Marker → eventi tipizzati** per `PLAN_PROPOSE`/`PLAN` (i due con doppio
   parsing) → un `TurnEvent`; **cancella** `parse_plan_marker` duplicato e le regex
   frontend corrispondenti.
3. ☐ Estendi a `CHOICES`/`CONNECT_SUGGEST`/`*_CONFIRM`/`GOAL_PROPOSE` (le altre regex
   frontend), una alla volta.
4. ☐ **Live state-machine** per i marker parziali in streaming (UX) — l'ultimo, il più
   delicato.
5. ☐ Fixture snapshot di output reali per kimi/gemma/glm nel gate di regressione.

## Riferimenti

- [0016 — harness-owned task engine cross-modello](0016-harness-owned-task-engine-cross-model.md)
  (caposaldo formato/floor) e [0018 — harness adattivo](0018-adaptive-harness-subagents-triggers.md).
- [Architettura agent-loop](../architecture/agent-loop.md) (Pavimento/Manopole).
- Codice da consolidare: `crates/desktop-gateway/src/main.rs` →
  `reassemble_openai_stream`, `sanitize_model_text`, `parse_plan_marker`,
  `build_chat_payload`/`is_zai_base`, `to_ollama_messages`; `apps/desktop/src/components/ChatView.tsx`
  → `PLAN_PROPOSE_RE` & co. (da cancellare).
- SOTA: Anti-Corruption Layer (Evans, DDD); "Parse, don't validate" (Wlaschin);
  serde `untagged`/`alias`/`default`; "make illegal states unrepresentable".
