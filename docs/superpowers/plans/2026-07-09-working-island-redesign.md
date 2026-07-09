# Working Island Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere la working island (`WorkspaceIsland`) contestualizzata al thread e permanente: l'attivita' di ogni turno resta consultabile dopo fine turno e reload, l'island diventa un cockpit snello (Obiettivo → Piano → Attivita' corrente), e artefatti/file escono in un menu dedicato.

**Architecture:** Nessun nuovo store. La persistenza dell'attivita' per-turno si ottiene **montando il componente `MessageActivity` (oggi codice morto) inline in ogni messaggio assistant**, che re-parsa i marker `‹‹ACT››` gia' persistiti in `chat_messages.text`. L'island resta la sintesi cross-turn (piano corrente + attivita' del turno corrente + obiettivo di progetto). L'obiettivo testuale riusa la memoria `memory_type:"goal"` (`project_objective_block`). Le navigazioni browser strutturate (Fase 2) emettono un `turn_events` tipizzato dai `browse_sources` gia' catturati.

**Tech Stack:** React 19 + TypeScript + Vite (`apps/desktop`), Rust gateway (`crates/desktop-gateway`, `crates/task-runtime`, `crates/engine`). Test: `node --test` (electron/pure), `check-ui-contract.mjs` (strutturali), `cargo test` (Rust).

**Riferimento spec:** `docs/superpowers/specs/2026-07-08-working-island-redesign-design.md`.

---

## Note di stato verificate (2026-07-09)

- `MessageActivity` — `apps/desktop/src/components/ChatView.tsx:5956`-`5999` — **definito ma mai montato** (dead code). `parseActivitySteps(text)` gia' dentro.
- I marker `‹‹ACT››/‹‹PLAN››/‹‹ARTIFACT››` restano in `chat_messages.text`; regex in `apps/desktop/src/lib/markers.ts:100`/`102`/`105`.
- `WorkspaceIsland` — `ChatView.tsx:2417`-`2779`; reso a `ChatView.tsx:1976`-`1996`. Righe sezione: Plan `2635`, Activity `2700`, Artifacts `2715`, Files `2727`, Goals `2739`, Memory `2751` — ognuna un bottone `onOpenWorkbench(tab)`.
- Read path: `latestActivitySteps` (`3723`), `latestPlanMarkdown` (`3708`), merge `isStreaming ? live : persisted` (`483`-`491`). Il piano gia' persiste (ultimo `plan_update` = piano completo corrente); l'attivita' e' l'unica realmente effimera cross-turn → risolta montando `MessageActivity` inline.
- Nessun kebab in header oggi (`task-topbar` `ChatView.tsx:1962`-`1969` = solo titolo). Esiste `WorkbenchPanel` con tab `files|artifacts|memoria|goals|activity|plan` (`WorkbenchTab` `4115`, `PANEL_VIEWS` `4120`), aperto via `setWorkbenchTab(tab)` + `setArtifactsOpen(true)` (`347`, `346`).
- Obiettivo: nessun campo per-thread; sorgente reale = `project_objective_block(state)` (`crates/desktop-gateway/src/main.rs:4698`-`4729`) dalle memorie `memory_type:"goal"` Confermate/Candidate. Oggi solo prompt-side.
- Browser (Fase 2): nav emesse come free-text `‹‹ACT››🌐 Opening {url}‹‹/ACT››` (`main.rs:18967`), **inghiottite** nel sub-loop `browse` (tx = drain). URL gia' catturati in `TurnOutcome.browse_sources: Vec<String>` (`crates/engine/src/agent_loop.rs:498`-`510`; struct `crates/engine/src/outcome.rs:23`). Fanout durevole: `fanout_turn_event` (`main.rs:28896`-`28940`).

---

## File structure

**Creati:**
- `apps/desktop/src/lib/islandPlan.ts` — funzioni pure: parsing piano + **finestra auto-focus a 3 step** (testabili con `node --test`).
- `apps/desktop/src/lib/islandPlan.test.mjs` — unit test delle funzioni pure.
- `apps/desktop/src/components/WorkspaceIsland.tsx` — il componente island estratto da ChatView (split del file 9.5k).
- `apps/desktop/src/components/ChatHeaderMenu.tsx` — il nuovo kebab "…" in header che apre il Workbench.

**Modificati:**
- `apps/desktop/src/components/ChatView.tsx` — monta `MessageActivity` inline; usa `WorkspaceIsland` estratto; rende il kebab; passa `objective`.
- `apps/desktop/src/lib/markers.ts` — (nessuna modifica prevista; solo import).
- `apps/desktop/scripts/check-ui-contract.mjs` — nuove asserzioni strutturali.
- `crates/desktop-gateway/src/main.rs` — espone `objective` nel payload di project-context (Fase 1); emette `turn_events` browser tipizzato (Fase 2).
- `crates/task-runtime/src/types.rs` — nuovo `TurnEventKind::BrowseNav` (Fase 2).
- `crates/engine/src/*` + `crates/desktop-gateway/src/main.rs` (`GatewayBrowseExecutor`) — emissione browse_sources (Fase 2).

---

# FASE 1 — persistenza core + ridisegno island (nessun endpoint nuovo)

## Task 1: Montare `MessageActivity` inline (fix core della persistenza)

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx` (montaggio nel rendering dei messaggi assistant; componente gia' a `:5956`)
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Scrivere l'asserzione di contratto che fallisce**

In `apps/desktop/scripts/check-ui-contract.mjs`, in fondo alla sezione asserzioni, aggiungere:

```js
assertContains(
  "src/components/ChatView.tsx",
  "<MessageActivity",
  "per-turn activity must be rendered inline in each assistant message"
);
```

- [ ] **Step 2: Eseguire il contratto e verificare che fallisce**

Run: `cd apps/desktop && npm run test:ui-contract`
Expected: FAIL con "per-turn activity must be rendered inline ... expected src/components/ChatView.tsx to contain <MessageActivity"

- [ ] **Step 3: Trovare il punto di rendering del corpo del messaggio assistant**

Run: `cd apps/desktop && grep -n "role === \"assistant\"\|message.role\|MessageBody\|markdown" src/components/ChatView.tsx | head -30`
Individuare il blocco JSX che rende il corpo di un messaggio assistant (dove il testo markdown viene mostrato). Annotare la variabile del messaggio corrente (es. `message`) e il campo testo persistito (es. `message.text`).

- [ ] **Step 4: Montare `MessageActivity` sopra/sotto il corpo del messaggio assistant**

Nel blocco individuato allo Step 3, per i messaggi con `role === "assistant"`, inserire prima del corpo markdown:

```tsx
{message.role === "assistant" && message.text ? (
  <MessageActivity text={message.text} live={false} />
) : null}
```

(`MessageActivity` re-parsa i marker `‹‹ACT››` gia' presenti in `message.text` persistito; `live={false}` perche' e' storico.)

- [ ] **Step 5: Eseguire il contratto e verificare che passa**

Run: `cd apps/desktop && npm run test:ui-contract`
Expected: PASS

- [ ] **Step 6: Verifica di build (typecheck)**

Run: `cd apps/desktop && npm run build`
Expected: build ok (tsc --noEmit senza errori)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(island): render per-turn activity inline in assistant messages"
```

---

## Task 2: Funzioni pure del piano + finestra auto-focus a 3 step

**Files:**
- Create: `apps/desktop/src/lib/islandPlan.ts`
- Test: `apps/desktop/src/lib/islandPlan.test.mjs`

- [ ] **Step 1: Scrivere i test che falliscono**

Creare `apps/desktop/src/lib/islandPlan.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { threeStepWindow } from "./islandPlan.mjs";

const step = (title, status) => ({ title, status });

test("<=6 steps: window shows all, no collapse groups", () => {
  const steps = [step("a", "done"), step("b", "doing"), step("c", "todo")];
  const w = threeStepWindow(steps);
  assert.equal(w.before.length, 0);
  assert.equal(w.after.length, 0);
  assert.deepEqual(w.window.map((s) => s.title), ["a", "b", "c"]);
});

test(">6 steps: centers a 3-step window on the in_progress step", () => {
  const steps = [
    step("1", "done"), step("2", "done"), step("3", "done"),
    step("4", "doing"), step("5", "todo"), step("6", "todo"), step("7", "todo"),
  ];
  const w = threeStepWindow(steps);
  assert.deepEqual(w.window.map((s) => s.title), ["3", "4", "5"]);
  assert.equal(w.before.length, 2); // 1,2 collapsed as "completed"
  assert.equal(w.after.length, 2);  // 6,7 collapsed as "waiting"
});

test(">6 steps with no in_progress: centers on first non-completed", () => {
  const steps = [
    step("1", "done"), step("2", "done"), step("3", "done"),
    step("4", "done"), step("5", "todo"), step("6", "todo"), step("7", "todo"),
  ];
  const w = threeStepWindow(steps);
  assert.equal(w.window[0].title, "4"); // window centered so current (5) is in view
  assert.ok(w.window.some((s) => s.title === "5"));
});
```

Nota: il test importa `./islandPlan.mjs`. Per farlo compilare da TS mantenendo una sola sorgente, scrivere la logica pura in un file `.mjs` puro (`islandPlan.mjs`) e ri-esportarla da `islandPlan.ts` per il consumo TS (vedi Step 3).

- [ ] **Step 2: Eseguire i test e verificare che falliscono**

Run: `cd apps/desktop && node --test src/lib/islandPlan.test.mjs`
Expected: FAIL con "Cannot find module ./islandPlan.mjs"

- [ ] **Step 3: Implementare la logica pura**

Creare `apps/desktop/src/lib/islandPlan.mjs`:

```js
// Auto-focus 3-step window (ZCode pattern): keep the panel short while always
// showing the current step in context. <=6 steps => show all; else a 3-step
// window centered on the current step, with the rest collapsed into
// "completed" (before) and "waiting" (after) groups.
export function currentStepIndex(steps) {
  const doing = steps.findIndex((s) => s.status === "doing" || s.status === "in_progress");
  if (doing >= 0) return doing;
  const firstOpen = steps.findIndex((s) => s.status !== "done" && s.status !== "completed");
  return firstOpen >= 0 ? firstOpen : Math.max(0, steps.length - 1);
}

export function threeStepWindow(steps) {
  if (steps.length <= 6) return { before: [], window: steps, after: [] };
  const cur = currentStepIndex(steps);
  let start = Math.max(0, cur - 1);
  let end = Math.min(steps.length, start + 3);
  start = Math.max(0, end - 3);
  return {
    before: steps.slice(0, start),
    window: steps.slice(start, end),
    after: steps.slice(end),
  };
}
```

Creare `apps/desktop/src/lib/islandPlan.ts` (wrapper tipizzato per il consumo React):

```ts
export type IslandPlanStatus = "todo" | "doing" | "done" | "blocked" | "in_progress" | "completed";
export interface IslandPlanStep { title: string; status: IslandPlanStatus }
export interface PlanWindow { before: IslandPlanStep[]; window: IslandPlanStep[]; after: IslandPlanStep[] }
// Re-export the single pure source so TS and node:test share one implementation.
// @ts-expect-error — .mjs sibling, resolved at build by Vite.
export { threeStepWindow, currentStepIndex } from "./islandPlan.mjs";
```

- [ ] **Step 4: Eseguire i test e verificare che passano**

Run: `cd apps/desktop && node --test src/lib/islandPlan.test.mjs`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/islandPlan.mjs apps/desktop/src/lib/islandPlan.ts apps/desktop/src/lib/islandPlan.test.mjs
git commit -m "feat(island): pure 3-step auto-focus plan window + tests"
```

---

## Task 3: Esporre l'obiettivo di progetto (goal testuale) — server

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (payload project-context che gia' fornisce il goal count)
- Test: `crates/desktop-gateway/src/...` (cargo test nella stessa area)

- [ ] **Step 1: Individuare il payload che fornisce `projectGoalCount` alla UI**

Run: `cd .. && grep -n "goalCount\|goal_count\|projectGoal\|project_context\|ProjectContext" crates/desktop-gateway/src/main.rs | head -20`
Individuare la struct/handler che serializza il conteggio goal per il thread/workspace (la UI legge `projectGoalCount`). Annotare il nome del campo JSON e la funzione.

- [ ] **Step 2: Scrivere un test che verifica la presenza del campo `objective`**

Nel modulo test piu' vicino a quel handler (o `crates/desktop-gateway/src/lib.rs` se e' li' che vivono i test di serializzazione), aggiungere un test che costruisce lo stato con una memoria `memory_type:"goal"` Confermata e asserisce che il payload project-context includa `objective` = testo dell'obiettivo. Usare `project_objective_block` come sorgente (main.rs:4698). Forma:

```rust
#[test]
fn project_context_payload_includes_objective_when_goal_memory_present() {
    // Arrange: state with a confirmed memory_type:"goal"
    // Act: build the project-context payload for the workspace
    // Assert: payload["objective"].as_str() == Some("<goal text>")
}
```

(Adattare Arrange/Act ai costruttori reali trovati allo Step 1; se `project_objective_block` prende `&state`, testarlo direttamente asserendo `Some(text)`.)

- [ ] **Step 3: Eseguire il test e verificare che fallisce**

Run: `cargo test -p local-first-desktop-gateway project_context_payload_includes_objective -- --nocapture`
Expected: FAIL (campo `objective` assente)

- [ ] **Step 4: Aggiungere il campo `objective` al payload**

Nella struct/handler dello Step 1, aggiungere un campo `objective: Option<String>` popolato da `project_objective_block(&state)` (che gia' restituisce `Option<String>` dalle goal-memories, e `None` per i workspace personali/threads → l'island lo nascondera').

- [ ] **Step 5: Eseguire il test e verificare che passa**

Run: `cargo test -p local-first-desktop-gateway project_context_payload_includes_objective -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(island): expose project objective text in project-context payload"
```

---

## Task 4: Ridisegno island — Obiettivo (testo) + Piano con finestra a 3 step + rimozione righe output

**Files:**
- Create: `apps/desktop/src/components/WorkspaceIsland.tsx` (estrazione)
- Modify: `apps/desktop/src/components/ChatView.tsx` (usa il componente estratto; passa `objective`)
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Scrivere le asserzioni di contratto che falliscono**

In `check-ui-contract.mjs` aggiungere:

```js
assertContains(
  "src/components/WorkspaceIsland.tsx",
  "threeStepWindow",
  "island plan must use the 3-step auto-focus window"
);
assertNotContains(
  "src/components/WorkspaceIsland.tsx",
  "onOpenWorkbench(\"artifacts\")",
  "artifacts row must be removed from the island (moved to the header menu)"
);
assertNotContains(
  "src/components/WorkspaceIsland.tsx",
  "onOpenWorkbench(\"files\")",
  "files row must be removed from the island"
);
```

- [ ] **Step 2: Eseguire il contratto e verificare che fallisce**

Run: `cd apps/desktop && npm run test:ui-contract`
Expected: FAIL (file `WorkspaceIsland.tsx` assente / asserzioni non soddisfatte)

- [ ] **Step 3: Estrarre `WorkspaceIsland` in un file dedicato**

Spostare la funzione `WorkspaceIsland` (`ChatView.tsx:2417`-`2779`) e gli helper `WorkspaceIslandMode`/`WORKSPACE_ISLAND_MODE_KEY`/`loadWorkspaceIslandMode` (`2407`-`2415`) in `apps/desktop/src/components/WorkspaceIsland.tsx`, esportandola. Importare in ChatView: `import { WorkspaceIsland } from "./WorkspaceIsland";`. Portare con se' i tipi necessari (`PlanStep`, `ParsedArtifact`, `WorkbenchTab`, `ChatStreamStatus`) via import.

- [ ] **Step 4: Aggiungere il blocco Obiettivo (condizionale) e la finestra a 3 step**

In `WorkspaceIsland.tsx`:
1. Aggiungere prop `objective?: string | null` all'interfaccia.
2. In cima al pannello espanso, prima della sezione Piano, rendere il blocco solo se `objective`:

```tsx
{objective ? (
  <div className="wi-goal">
    <span className="wi-goal-label">Obiettivo</span>
    <p className="wi-goal-text">{objective}</p>
  </div>
) : null}
```

3. Sostituire la lista piano inline (`2646`-`2698`) con il rendering basato su `threeStepWindow(planSteps)`:

```tsx
import { threeStepWindow } from "../lib/islandPlan";
// ...
const planWin = threeStepWindow(planSteps);
// render: collapsible "{planWin.before.length} completati" (if >0),
// then planWin.window rows (status icon + title, current highlighted),
// then collapsible "{planWin.after.length} in attesa" (if >0).
```

- [ ] **Step 5: Rimuovere le righe Artifacts/Files/Goals/Memory dall'island**

Cancellare i blocchi righe Artifacts (`2715`-`2725`), Files (`2727`-`2737`), Goals (`2739`-`2749`), Memory (`2751`-`2761`) dal componente estratto. Mantenere Plan e Activity. Rimuovere le prop ora inutilizzate (`artifacts`, `fileCount`, `goalCount`, `memoryCount`) dall'interfaccia e dal sito di rendering in ChatView (`1979`-`1985`) — o lasciarle se ancora servono al conteggio nel kebab (vedi Task 5).

- [ ] **Step 6: Passare `objective` da ChatView**

Nel sito di rendering (`ChatView.tsx:1976`), aggiungere `objective={projectObjective}` dove `projectObjective` viene letto dallo stesso fetch di `projectGoalCount` (campo `objective` aggiunto in Task 3). Individuare quel fetch con `grep -n "projectGoalCount" src/components/ChatView.tsx`.

- [ ] **Step 7: Eseguire contratto + build**

Run: `cd apps/desktop && npm run test:ui-contract && npm run build`
Expected: PASS + build ok

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/WorkspaceIsland.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(island): extract WorkspaceIsland; goal text + 3-step plan window; drop output rows"
```

---

## Task 5: Kebab "…" in header che apre il Workbench (Artefatti/File/Screenshot/Attivita')

**Files:**
- Create: `apps/desktop/src/components/ChatHeaderMenu.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx` (`task-topbar` `1962`-`1969`)
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Asserzione di contratto che fallisce**

```js
assertContains(
  "src/components/ChatView.tsx",
  "<ChatHeaderMenu",
  "chat header must expose a kebab menu for artifacts/files/screenshots/background activity"
);
```

- [ ] **Step 2: Eseguire e verificare fallimento**

Run: `cd apps/desktop && npm run test:ui-contract`
Expected: FAIL

- [ ] **Step 3: Creare `ChatHeaderMenu.tsx`**

```tsx
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import type { WorkbenchTab } from "./ChatView"; // or shared types module

export function ChatHeaderMenu({
  onOpenWorkbench,
  onCaptureScreenshot,
}: {
  onOpenWorkbench: (tab: WorkbenchTab) => void;
  onCaptureScreenshot?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-header-menu">
      <button aria-label="More" className="chat-header-menu-trigger" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={18} />
      </button>
      {open ? (
        <div className="chat-header-menu-popover" role="menu">
          <button role="menuitem" onClick={() => { onOpenWorkbench("artifacts"); setOpen(false); }}>Artefatti</button>
          <button role="menuitem" onClick={() => { onOpenWorkbench("files"); setOpen(false); }}>File</button>
          {onCaptureScreenshot ? (
            <button role="menuitem" onClick={() => { onCaptureScreenshot(); setOpen(false); }}>Screenshot</button>
          ) : null}
          <button role="menuitem" onClick={() => { onOpenWorkbench("activity"); setOpen(false); }}>Attivita' in background</button>
        </div>
      ) : null}
    </div>
  );
}
```

(Se `WorkbenchTab` non e' esportato da ChatView, estrarlo in un modulo tipi condiviso e importarlo in entrambi.)

- [ ] **Step 4: Montare il kebab nel `task-topbar`**

In `ChatView.tsx:1962`-`1969`, accanto allo span del titolo, aggiungere:

```tsx
<ChatHeaderMenu
  onOpenWorkbench={(tab) => { setArtifactsInitial(null); setWorkbenchTab(tab); setArtifactsOpen(true); }}
  onCaptureScreenshot={onCaptureScreenshot}
/>
```

- [ ] **Step 5: Eseguire contratto + build**

Run: `cd apps/desktop && npm run test:ui-contract && npm run build`
Expected: PASS + build ok

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/ChatHeaderMenu.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(island): header kebab menu opening the Workbench (artifacts/files/screenshot/activity)"
```

---

## Task 6: Verifica live-non-distruttiva a fine turno

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx` (`941`-`942`)

- [ ] **Step 1: Ispezionare l'azzeramento a fine turno**

Run: `cd apps/desktop && grep -n "setLiveActivitySteps(\[\])\|setLivePlanMarkdown(null)" src/components/ChatView.tsx`
Confermare i due siti: submit (`772`-`773`) e finally di fine turno (`941`-`942`).

- [ ] **Step 2: Rendere l'azzeramento di fine turno non distruttivo**

Poiche' l'attivita' per-turno ora vive inline (Task 1) e il piano persiste dai messaggi, l'azzeramento a fine turno e' corretto per il *live* ma non deve lasciare l'island vuota se il messaggio persistito non e' ancora arrivato. Alla `941`-`942`, azzerare il live solo dopo che il messaggio assistant persistito e' presente in `messages` (guardia gia' disponibile `streamingAssistantId`/`messages`). Se il messaggio non e' ancora committato, rimandare l'azzeramento (lasciare che il merge `isStreaming ? live : persisted` converga naturalmente al persistito al prossimo render). Implementazione minima: mantenere l'azzeramento ma verificare via build + il gate live (Step 3) che non ci siano flicker.

- [ ] **Step 3: Verifica manuale documentata (gate)**

Documentare nel commit il check: avviare `npm run electron:dev`, eseguire un turno che produce `‹‹ACT››`, poi ricaricare → l'attivita' del turno resta visibile inline nel messaggio (Task 1) e l'island mostra piano+attivita' correnti senza vuoto/flicker.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx
git commit -m "fix(island): converge to persisted activity at turn end without flicker"
```

---

# FASE 2 — navigazioni browser strutturate (server + UI)

## Task 7: `TurnEventKind::BrowseNav` + emissione dai `browse_sources`

**Files:**
- Modify: `crates/task-runtime/src/types.rs` (`199`-`237`)
- Test: `crates/task-runtime/src/store.rs` (mod `turn_event_tests`)

- [ ] **Step 1: Test round-trip del nuovo kind (fallisce)**

In `crates/task-runtime/src/store.rs`, mod `turn_event_tests` (`:1148`), aggiungere:

```rust
#[test]
fn browse_nav_kind_round_trips() {
    let s = store();
    s.insert_turn_event("t1", TurnEventKind::BrowseNav, json!({"urls":["https://a"]})).unwrap();
    let ev = s.read_turn_events("t1", 0).unwrap();
    assert_eq!(ev[0].kind, TurnEventKind::BrowseNav);
    assert_eq!(ev[0].payload["urls"][0], "https://a");
}
```

- [ ] **Step 2: Eseguire e verificare fallimento**

Run: `cargo test -p task-runtime browse_nav_kind_round_trips -- --nocapture`
Expected: FAIL (variante `BrowseNav` inesistente)

- [ ] **Step 3: Aggiungere la variante**

In `crates/task-runtime/src/types.rs`, enum `TurnEventKind` (`:199`), aggiungere `BrowseNav`; in `as_str` (`:222`) mappare `TurnEventKind::BrowseNav => "browse_nav"`.

- [ ] **Step 4: Eseguire e verificare pass**

Run: `cargo test -p task-runtime browse_nav_kind_round_trips -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git commit -m "feat(browser): add TurnEventKind::BrowseNav for structured navigations"
```

---

## Task 8: Emettere `browse_sources` come evento tipizzato dal browse executor

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`GatewayBrowseExecutor::browse`, ~`22315`-`22410`; fanout `fanout_turn_event` `28896`-`28940`)

- [ ] **Step 1: Individuare il ritorno di `browse` con l'outcome**

Run: `cd .. && grep -n "browse_result_from_outcome\|fn browse\|browse_sources" crates/desktop-gateway/src/main.rs crates/engine/src/agent_loop.rs`
Confermare che in `GatewayBrowseExecutor::browse` (`main.rs:22383`-`22409`) l'`outcome` (con `outcome.browse_sources: Vec<String>`) e' disponibile prima di `browse_result_from_outcome`.

- [ ] **Step 2: Emettere l'evento tipizzato verso il canale del manager**

Subito prima di `browse_result_from_outcome(&outcome)` (`~22409`), se `!outcome.browse_sources.is_empty()`, emettere sul canale del turno manager (NON sul drain) un `GenerateStreamEvent` che il fanout mappera' a `TurnEventKind::BrowseNav`. Usare il `tx` del manager disponibile in `GatewayCapabilityExecutor::execute_tool` (il chiamante di `browse`), passandolo a `browse` o emettendo nel chiamante col risultato. Payload: `{ "urls": outcome.browse_sources }`.

- [ ] **Step 3: Aggiungere il caso nel fanout durevole**

In `fanout_turn_event` (`main.rs:28896`), aggiungere il caso che riconosce il tipo stream browser-nav → `TurnEventKind::BrowseNav` con payload `{urls}` (parallelo ai casi `activity`/`plan_update` a `28918`-`28925`), cosi' l'evento finisce durevolmente in `turn_events`.

- [ ] **Step 4: Verifica build gateway**

Run: `cargo build -p local-first-desktop-gateway`
Expected: ok

- [ ] **Step 5: Verifica live documentata (gate)**

Eseguire un turno con `browse(goal)`; verificare in `~/.homun/homun.sqlite` che compaia una riga `turn_events` con `kind='browse_nav'` e `payload_json` contenente gli URL.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(browser): emit visited browse_sources as durable BrowseNav turn_event"
```

---

## Task 9: UI — chip "Browser · N nav" dagli eventi tipizzati

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx` (sottoscrizione `turn.event` `402`-`418`; rendering attivita' island)
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Asserzione di contratto (fallisce)**

```js
assertContains(
  "src/components/ChatView.tsx",
  "browse_nav",
  "UI must handle the structured browse_nav turn event"
);
```

- [ ] **Step 2: Eseguire e verificare fallimento**

Run: `cd apps/desktop && npm run test:ui-contract`
Expected: FAIL

- [ ] **Step 3: Gestire `kind === "browse_nav"` nella sottoscrizione**

Nell'effetto `402`-`418`, aggiungere il branch che, su `msg.kind === "browse_nav"`, accumula gli URL (payload `.urls`) in uno stato live `liveBrowseNavs` e li rende come chip "Browser · N nav" espandibile (lista URL) nella sezione Attivita' dell'island.

- [ ] **Step 4: Eseguire contratto + build**

Run: `cd apps/desktop && npm run test:ui-contract && npm run build`
Expected: PASS + build ok

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(island): render structured Browser navigations chip"
```

---

## Gate finali (prima di considerare chiuso)

- [ ] `cargo test -p local-first-desktop-gateway` — verde
- [ ] `cargo test -p task-runtime` — verde
- [ ] `cd apps/desktop && npm run test:ui-contract` — verde
- [ ] `cd apps/desktop && npm run build` — verde
- [ ] `cd apps/desktop && node --test src/lib/islandPlan.test.mjs` — verde
- [ ] Verifica live: turno con attivita' + reload → attivita' per-turno permanente inline; island = obiettivo (se presente) + piano a 3 step + attivita' corrente; artefatti/file solo nel kebab.
- [ ] Aggiornare `docs/STATO.md` con lo stato del ridisegno island.

---

## Non-goal (esclusi da questo piano)

- Endpoint `turn_events` a livello thread e output tool espandibile-per-sempre in stile ZCode (non necessario alla persistenza core; eventuale Fase 3 di arricchimento).
- Link durevole turno↔messaggio (`chat_messages.linked_task_id` sul path interattivo): solo per click-through, non richiesto dall'MVP.
- Cattura status/title HTTP per-navigazione (arricchimento futuro di `browse_sources`).
- Checkpoint/rewind, refactor `browse(goal)` (ADR 0025 gia' chiuso).
