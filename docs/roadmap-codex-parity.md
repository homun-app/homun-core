# Roadmap — Codex parity (coding-agent) + oltre

> Documento vivo. Obiettivo: chiudere **tutti** i gap Codex per l'identità coding-agent, **mantenendo** i
> differenziatori Homun (motore di memoria, local-first, model-agnostic). Metodo: subagent-driven + TDD,
> incrementale, ogni pezzo revisionato + validato eseguendo; STATO.md traccia il punto. Basato sull'inventario
> Codex 0.142.5 (binario reale) del 2026-07-03.

## Principio d'ordinamento
Non valore puro, ma **dipendenze + rischio + momentum**: chiudi ciò che è iniziato → table-stakes indipendenti →
**estrazione motore** (abilitatore che rende tutto il resto più economico) → coding-tool grossi sul motore pulito →
estensibilità → produzione. Deliberatamente NON inseguiti in coda.

## Stato di partenza (2026-07-03)
Già a pari/avanti: `apply_patch` ✅, sandbox 3-livelli ✅, MCP/skills ✅, browser/computer-use, auto-update/feedback.
Avanti: **motore di memoria ibrido**, **local-first/privacy**, **model-agnostic**. Costruito stanotte: sandbox
onesto, apply_patch, subagenti slice-1 (machinery).

---

## Fase 0 — Chiudere l'arco safety (piccolo, alta confidenza) — *in corso*
Chiude ADR 0023 al 100%. S–M.
- **0.1 Approval axis 4-livelli in Settings (#1b)** — esporre `approval_policy` (untrusted/on-failure/on-request/
  never) + wiring `resolved_approval_policy()` al chokepoint, sostituendo la logica autonomous-based. *(S)*
- **0.2 Bundle `homun-linux-sandbox`** nel packaged Linux (electron-builder) → Linux auto-recinta (il probe promuove
  a workspace-write) + Windows approval-only confermato. *(S)*
- **0.3 Skill confirmation policies** — categorie sensibili dichiarative in `SKILL.md` (delete/financial/medical/
  sensitive-data) rispettate dall'harness (il pattern Codex Step 5 ADR 0023). *(M)*
- **0.4 Network approval per-dominio** (Codex `network_approval`/MITM) — opzionale, più avanti. *(M, opz)*
**Success:** approval selezionabile+wired; Linux fenced di default nel packaged; skill possono dichiarare conferme.

## Fase 1 — Table-stakes coding-agent (indipendenti dall'estrazione) — *M*
- **1.1 Auto-compaction** — compaction token-budget-driven della conversazione + consapevolezza contesto
  (`get_context_remaining`/`new_context_window` equivalenti). Senza, le sessioni lunghe si rompono. *(M)*
- **1.2 Eval subagenti su gemma4** — validare flag-on end-to-end (manager spawna read/gather + sintetizza),
  poi accendere `HOMUN_SUBAGENTS` di default. *(S–M)* → sblocca la priorità utente.
- **1.3 Subagent lifecycle basilare** — `wait`/`interrupt`/`close` + concorrenza cloud-aware (semaforo =
  `active_llm_concurrency`) + chip UI multi-agente. *(M)*
**Success:** conversazioni lunghe non si rompono; subagenti validati e on-by-default; UI multi-agente.

## Fase 2 — L'ABILITATORE strutturale: estrazione motore ([ADR 0024](decisions/0024-engine-extraction-from-monolith-gateway.md)) — *L*
Codex ha un core modulare (`core/src/tools/handlers/*.rs`, un handler per-tool). Homun ha `main.rs` ~57k righe.
Il chokepoint `execute_chat_tool` (fatto) è il primo passo. Estrarre in un crate **motore** con handler per-tool.
- **2.1 Fase A** — crate motore in-process (trait iniettati, non `AppState`), `stream_chat_via_openai` estratto.
- **2.2 Handler per-tool** — ogni famiglia (shell/file/apply_patch/browser/mcp/composio/subagent) diventa un
  handler modulo, come Codex.
- **2.3 Fase B** (opz) — processo satellite / UDS.
**Success:** il turno + i tool vivono in un crate motore modulare; `main.rs` sotto controllo; ogni coding-tool
successivo è un handler, non un ramo del monolite. **Va pianificato con un ADR-refresh prima di partire.**

## Fase 3 — I coding-tool grossi (sul motore pulito) — *L*
- **3.1 Git integration** — `git_commit`, `create_pr` (octocrab), `worktree`, tracking branch/PR sul thread. Il
  valore coding-agent più alto. *(L)*
- **3.2 Session rewind/checkpoint/fork** — albero thread, rollback delle modifiche dell'agente, "torna a qui",
  resume. *(L)* (converge col chat-branching in roadmap.)
- **3.3 unified_exec** — terminale interattivo persistente (`exec_command`+`write_stdin` stateful) accanto al
  `run_in_project` one-shot. *(M)*
- **3.4 Code review mode** — workflow review integrato (findings + confidence + priority). Homun ha già il pattern
  review-agent (usato stanotte) da promuovere a feature. *(M)*
**Success:** commit/PR dall'agente; undo/branch delle sue modifiche; REPL/interattivi; review integrata.

## Fase 4 — Estensibilità / enterprise — *M*
- **4.1 Hooks** (11 eventi: pre/post-tool, compact, session, subagent, permission). *(M)*
- **4.2 Config `config.toml` + `AGENTS.md`** istruzioni a scope-layered (project/enterprise/MDM). *(M)*
- **4.3 Custom slash commands / prompts**. *(S–M)*
- **4.4 reasoning-effort per-turno + collaboration modes** (chat/pair/plan/read-only preset). *(M)*
- **4.5 Manifest plugin installabile** (formato §7 confronto) sopra il registry esistente. *(L)*

## Fase 5 — Produzione / piattaforma (confronto doc) — *M*
- **5.1 Firma Windows/Linux + auto-publish release** — *bloccato su certificati utente*.
- **5.2 `homun://` protocol handler** (OAuth callback + plugin install).
- **5.3 E2E Playwright-Electron** smoke in CI.
- **5.4 Gateway su Unix domain socket** (con la separazione motore, Fase 2B).

## Fase 6 — Extra avanzati (in Codex experimental) — *opzionale*
- Image-generation tool; **code_mode** (celle JS in sandbox = code-interpreter); realtime voice.
Bassa priorità: anche in Codex sono flag-gated.

## NON inseguire (deliberato)
- **Chronicle** (registrazione schermo → memoria): privacy-heavy, contro l'etica local-first; la memoria Homun è
  già superiore senza spiare lo schermo.
- **Marketplace cloud / realtime voice**: non-core, server-backed.
- **Lock-in OpenAI (gpt-5.x)**: restare model-agnostic è un vantaggio, non un gap.

---

## Esecuzione
Programma multi-sessione. Si esegue **dall'alto**, un pezzo alla volta (spec/piano → subagent-driven + TDD →
review → validare eseguendo → commit/push/PR). STATO.md ⭐ RIPRESA traccia il pezzo corrente. Le Fasi 0-1 sono
indipendenti e si fanno subito; la Fase 2 (estrazione) va pianificata con un ADR-refresh; le Fasi 3+ poggiano su di essa.
