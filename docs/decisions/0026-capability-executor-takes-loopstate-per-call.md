# ADR 0026 — `CapabilityExecutor` riceve `&mut LoopState` per-call (engine-owns-state)

- **Stato:** Accepted (2026-07-08)
- **Contesto:** ADR 0024 (estrazione motore), inc 5, passo 5.D1b. Dipende da: seam
  `CapabilityExecutor` (ADR 0024/5d.1a), `LoopState` (5.B1).
- **Supersede:** raffina la firma di `engine::CapabilityExecutor` introdotta a 5d.1a.

## Il nodo

A 5.D1c il corpo loop diventa `engine::run_turn(&mut ls: LoopState, exec: &dyn CapabilityExecutor, …)`.
Ma il `GatewayCapabilityExecutor` di 5e.3a è `{ ctx: &ChatToolCtx }`, e `ChatToolCtx` **borrowa
`&mut ls`** (`messages: &mut ls.messages`, `plan: &mut ls.plan`, …). Un `&dyn` costruito **una volta**
che incapsula `&mut ls`, passato a un loop che ha già `&mut ls`, è un **doppio borrow mutabile di `ls`
→ non compila**. Radice: l'executor deve vedere lo stato *com'è a ogni tool-call* (il piano corrente per
il merge di `update_plan`, `accumulated`, …), ma quello stato cambia ogni round — un `&ls` *tenuto*
dall'executor non può coesistere col `&mut ls` del loop.

## La decisione

Il seam **non cattura** lo stato del turno: lo **riceve per-call**.

```rust
pub trait CapabilityExecutor {
    fn execute_tool(
        &self, name: &str, args: &Value, call_id: &str,
        state: &mut LoopState,        // NEW: lo stato mutabile del turno, passato a ogni call
    ) -> impl Future<Output = Result<ToolOutcome, String>> + Send;
}
```

- `GatewayCapabilityExecutor` tiene **solo il contesto gateway turn-costante** (i 15 read-only che
  `execute_chat_tool` legge e che non cambiano per-round: `state`, `tx`, `request`, `capability_corpus`,
  `catalog_index`, `composio_writes`, `automation_*`, `turn_scaffold`, i flag `read_only`/`autonomous`/
  `can_see_*`/`contact_only`/`floor_acting`, `thread_id`).
- Per-call costruisce `ChatToolCtx` da `state: &mut LoopState` + il contesto tenuto, e chiama
  `execute_chat_tool`. Il loop engine passa `&mut ls` a ogni call: il `&mut` **entra** nella chiamata,
  non è tenuto altrove → nessun conflitto (borrow sequenziali).
- **Provider binding foldato in `LoopState`** (`base_url`/`model`/`api_key`): `execute_chat_tool` li legge,
  cambiano per-round (swap) → devono viaggiare con lo stato per-call, non essere turn-costanti. (Chiude il
  fold provider rimandato da P4b.2/5.B1.)
- **`ChatToolCtx` si restringe** al read-set reale di `execute_chat_tool` (4 campi `LoopState` +
  provider + i 15 read-only). I campi **browser** e `pending_confirm` escono da `ChatToolCtx`:
  `execute_chat_tool` non li usa (verificato: 0 campi browser nel read-set); il ramo browser resta il seam
  temporaneo `execute_browser_tool` (→ ADR 0025).

## Perché (A) e non le alternative

- **(B) wire del seam dentro `run_agent_rounds` tenendo la costruzione ctx:** attiva il seam ma **non**
  riduce la firma → non sblocca il crate-move. Tappa morta.
- **(C) snapshot/read-view dei campi letti:** elenco fragile che cresce; più contorto di passare `&mut ls`.
- **(A)** è l'unico che scioglie il doppio-borrow **e** sblocca `engine::run_turn`, e resta coerente col
  caposaldo "un solo chokepoint tool" (ADR 0023 sandbox atterra sempre su questo `execute_tool`).

## Conseguenze

- Cambia il contratto `engine::CapabilityExecutor` (+ mock). ADR 0023 (sandbox) continua ad atterrare sullo
  stesso metodo — nessuna perdita.
- `LoopState` guadagna il provider binding → è la struct-stato completa del turno (engine-owned).
- Precondizione pulita per ADR 0025: il ramo browser sarà l'unico seam residuo, sostituito da `browse(goal)`.

## Rollout (slice gated, behavior-preserving; validazione col parity-oracle `tool_trace_dump`)

1. Fold provider binding in `LoopState`.
2. Restringere `ChatToolCtx` al read-set (togliere browser/pending_confirm; il ramo browser li prende diretti).
3. Cambiare il contratto `execute_tool(&mut LoopState)` + mock; `GatewayCapabilityExecutor` tiene i read-only
   turn-costanti e costruisce il ctx per-call.
4. Wire in `run_agent_rounds` (sostituire `execute_chat_tool` col seam), diff `tool_trace_dump` OFF/ON.
5. → 5.D1c: `run_agent_rounds` → `engine::run_turn` dietro `HOMUN_ENGINE_CRATE`.
