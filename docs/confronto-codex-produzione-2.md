# Homun vs Codex — Gap analysis aggiornata (delta post-PR #101)

**Data:** 2026-07-02 · **Metodo:** read-only. Homun @ `main` (dopo la PR tool-safety #101); riferimento Codex `codex-cli 0.142.5` in `/Users/fabio/Projects/codex/Contents`. Evidenze citate come Homun `file:line` o token estratti dal binario Codex.

> Aggiornamento di [confronto-codex-produzione.md](confronto-codex-produzione.md). Qui si traccia solo il **delta** da quando quel documento è stato scritto: cosa Homun ora eguaglia grazie al lavoro mergiato, e cosa Codex ha ancora che a Homun manca.

**Headline:** la PR #101 chiude l'**architettura** del modello di sicurezza di Codex (chokepoint + vocabolario policy 3×4 + primitive OS + escalation) — un passo grande. Ma atterra **dietro `HOMUN_TOOL_SAFETY` (default off)**, il fence OS è cablato in **un solo tool** (`run_in_project`), e la policy **non è ancora un'impostazione utente**. Il vantaggio residuo di Codex è ora soprattutto in **ergonomia di esecuzione** (apply_patch, shell persistente, compaction, rollout/resume) e **ampiezza del modello di sicurezza** (network policy, profili nominati, hooks, Windows).

---

## Parte A — Cosa Homun ora EGUAGLIA

| Gap precedente (da `confronto-codex-produzione.md`) | Stato | Evidenza in Homun |
|---|---|---|
| Chokepoint unico di esecuzione tool | ✅ chiuso | `execute_chat_tool` (`crates/desktop-gateway/src/main.rs`) — la funzione unica di dispatch; era il "chokepoint che non esiste ancora" su cui ADR 0023 era bloccato |
| Sandbox 3 livelli (`read-only`/`workspace-write`/`danger-full-access`) | ✅ chiuso (tipi+generator) | `SandboxPolicy` in `tool_safety.rs`; risoluzione `WorkspaceWrite` se esiste root scrivibile, else `ReadOnly` |
| Approval policy 4 livelli | ✅ chiuso (tipi), 🟡 parziale (wiring) | `AskForApproval` + `assess_tool_safety` in `tool_safety.rs`; il wiring live mappa solo il booleano legacy `autonomous`→`Never`/`OnRequest` |
| Enforcement OS — macOS Seatbelt | ✅ chiuso (macOS, per `run_in_project`) | `seatbelt.rs` genera un profilo closed-by-default; wired via `sandbox-exec -p`. Network deny-by-default salvo `network_access` → macOS *può già* fare network-off |
| Enforcement OS — Linux Landlock | ✅ chiuso (fence filesystem) | `landlock_fence.rs` + helper `src/bin/homun-linux-sandbox.rs`; best-effort ABI, fail-closed; runtime-validato in CI su ubuntu-24.04. Network-off (seccomp) = TODO |
| Escalation on-failure | ✅ chiuso | card `‹‹SANDBOX_ESCALATE››` + endpoint `/api/capabilities/run/escalate` (`run_escalate`) riesegue unsandboxed dopo approvazione; frontend `SandboxEscalateCard` |
| Card di approvazione unificata (prima MCP+Composio separate) | ✅ chiuso | `emit_approval_card` fonde i flussi via `assess_tool_safety` |
| Shadow-mode osservabilità del fence | ➕ bonus (Homun avanti) | `sandbox_shadow_verdict`/`ShadowVerdict` logga i "would-fence" senza bloccare — Codex non ha equivalente |
| P0 (logging/panic/SQLite recovery/feedback/single-instance/watchdog) | ✅ chiuso | già shippato |
| P1 (fuses + CSP + devtools-off) | ✅ chiuso | già shippato |

**Caveat onesti (diventano le prime priorità):** (1) tutto **dietro flag default-off**; (2) il fence copre **solo `run_in_project`** — `write_file`/`edit_file` e i tool MCP/Composio girano ancora `DangerFullAccess` senza fence OS (il codice lo nota esplicitamente); (3) **nessuna Settings UI** lo espone.

---

## Parte B — Cosa Codex ha ancora che a Homun manca

### ALTA
- **B1 — Sandbox/approval come SETTING utente + profili di permesso nominati.** Codex espone `approval_policy`/`sandbox_policy`/`permissions_profile` come config di prima classe + override per-turno. Homun: env flag + modo inferito nel codice; la Settings UI ha solo l'*approval-routing* (dove ricevere le approvazioni remote), non un selettore di modo. *Perché conta:* una sicurezza che l'utente non vede/sceglie non la userà né la tarerà; è la leva minima per accendere il flag.
- **B2 — `apply_patch` (edit strutturati).** Codex: `apply_patch` (`function`|`freeform`, grammatica `*** Begin Patch`). Homun: solo `write_file`/`edit_file`. *Perché conta:* patch multi-file strutturate sono molto più affidabili dei rewrite full-file sui modelli deboli (la tesi di Homun); diff atomici e rivedibili. È il gap di *qualità esecuzione* più grande.
- **B3 — Shell persistente (`unified_exec`/background terminals + `write_stdin`).** Codex: `exec_command`/`unified_exec` con `session_id`, `write_stdin`, kill, timeout. Homun: ogni comando è un `bash -lc` fresco con timeout fisso — niente sessione, stdin, processi lunghi/interattivi. *Perché conta:* dev server, REPL, installer interattivi impossibili oggi.
- **B4 — Auto-compaction della conversazione.** Codex: `auto_compact_token_limit`, `/compact`, telemetria compaction. Homun: traccia il `context_window` ma non compatta la conversazione in corso. *Perché conta:* le sessioni lunghe sbattono nel context ceiling silenziosamente; table-stakes per il long-horizon engine.
- **B5 — Network policy (oltre l'on/off binario).** Codex: `network.mode`/`allowed_domains`/`denied_domains`/proxy/amendments. Homun: Seatbelt binario, Linux network-off = TODO seccomp. *Perché conta:* "workspace-write ma niente exfiltration" serve l'allowlist domini; è la domanda che ADR 0023 ha lasciato aperta.

### MEDIA
- **B6 — Rollout persistence + resume/fork conversazioni** (Codex: `rollout_path`, `resume`/`--last`/fork). Homun ha resume in-flight + task, non rollout serializzato forkabile. Prerequisito per crash-resume e branching chat (già in roadmap).
- **B7 — Sistema di hooks** (Pre/PostToolUse, SessionStart, UserPromptSubmit, PreCompact…). Homun: nessuno. Leva di estensibilità enterprise + casa naturale per le confirmation policy delle skill (ADR 0023 step 5).
- **B8 — `web_search` nativo** (Codex: tool del modello). Homun: solo test fake + ricerca via browser. Più veloce/economico del browser per lookup.
- **B9 — `notify` + notifica nativa fine-turno.** Homun porta la finestra in primo piano ma non ha pipeline di notifica per run lunghi. Quick-win.
- **B10 — MCP breadth: OAuth + streamable-HTTP + `mcp add/login` UX.** Homun ha stdio+HTTP e registry search, ma OAuth server-MCP e management UX più sottili. I server remoti autenticati (la maggioranza crescente) richiedono OAuth.

### BASSA / non-goal consapevoli
- **B11 — OpenTelemetry export.** Coerente col local-first; probabile non-goal salvo self-host telemetry.
- **B12 — Windows enforcement.** Basso finché Windows non è target di shipping.
- **B13 — Gateway su Unix domain socket.** Da fare con la separazione motore (ADR 0024), non standalone.
- **B14 — `view_image`/image-gen tools, guardian review model, `/review`.** Il *guardian review model* (modello economico che vaglia azioni rischiose) è l'idea interessante, allineata alla tesi cross-model — da parcheggiare come idea.

---

## Parte C — Priorità consigliate (ordinate)

Effort **S/M/L**, validabile-in-locale **Y/N**. Le prime tre *attivano/completano* lavoro già all'80%.

1. **Settings UI: esporre sandbox mode + approval policy, e accendere il flag.** — *S, Y.* Pane "Runtime/Security" in `SettingsView.tsx` (c'è già una sezione `runtime`) con selettore sandbox 3-vie + approval 4-vie, persistito, che sostituisce `HOMUN_TOOL_SAFETY` come sorgente di risoluzione. Trasforma tutta la PR da "dormiente dietro env var" a feature reale.
2. **Estendere il fence OS a `write_file`/`edit_file` (e MCP/Composio) al chokepoint.** — *M, Y.* Oggi il fence avvolge solo `run_in_project`; il path generico è esplicitamente `DangerFullAccess`. Instradare i tool di scrittura attraverso lo stesso check `is_under_writable_root` + fence. È ciò che rende il sandbox onesto.
3. **`apply_patch` (tool di edit strutturato).** — *M, Y.* Grammatica `*** Begin Patch` (o diff JSON) come nuovo tool accanto a `edit_file`, applicazione atomica multi-file + diff card. Massimo guadagno di affidabilità edit sui modelli deboli.
4. **Auto-compaction della conversazione.** — *M, Y.* Trigger stile `auto_compact_token_limit`: quando il thread si avvicina al `context_window`, riassumere i turni vecchi. Si lega al memory engine (il riassunto è una scrittura di memoria).
5. **Shell persistente (`unified_exec`-style).** — *L, Y parziale.* Servizio exec session-keyed con `write_stdin` + background, in sostituzione del `bash -lc` one-shot.
6. **Rollout persistence + resume/fork.** — *L, Y.* Serializzare i thread in rollout resumibile. Prerequisito per crash-resume e branching chat.
7. **Network policy: allowlist domini + seccomp network-off Linux.** — *M, Y.* Promuovere il toggle binario a policy `allowed/denied_domains` + implementare il TODO seccomp. Abilita "workspace-write, no exfiltration".
8. **Hooks + confirmation policy dichiarative nelle skill.** — *M, Y.* Superficie hook minima (Pre/PostToolUse) + `confirmation_policies` in SKILL.md rispettate da `assess_tool_safety`. Coda di ADR 0023 step 5.

**Deferiti / non-goal consapevoli:** OTel (B11) e UDS (B13, da fare con ADR 0024); Windows (B12) attende Windows shipping; `notify` (B9) quick-win S/Y da inserire quando serve; guardian review model (B14) da catturare come idea differenziante, non task a breve.

**Lettura strategica:** il gap di *architettura* della sicurezza è chiuso; il resto è (a) **attivarlo** (Settings + fence a superficie piena — punti 1–2, piccoli e locali) e (b) recuperare l'**ergonomia di esecuzione** di Codex (apply_patch, shell persistente, compaction, rollout — punti 3–6). I punti **1–4** da soli porterebbero Homun a una parità di produzione credibile sul core sicurezza+esecuzione.
