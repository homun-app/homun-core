# Review UX — Homun vs Codex (osservazione visiva delle app reali)

> Data: 2026-07-03. Metodo: screenshot **delle app reali installate** (Codex.app + Homun.app) affiancate, non del
> bundle minificato. Osservate: home/empty-state, un thread, il composer, il pannello di contesto. Riferimento anche
> a `confronto-zcode-vs-homun.md` (struttura) e `codex-fluidity-map.md` (motore). Focus: UI/UX, non contenuto utente.

## Verdetto di fondo
Le due app condividono la **stessa lineage** (dark, sidebar sinistra + composer centrale, stile ChatGPT/Codex — Homun
l'ha preso come riferimento). **Homun è già rifinita e on-brand**, non "indietro" come qualità visiva. Le differenze
sono **feature/superfici**, e riflettono **identità diverse**: Codex = *coding agent* (repo/git/diff/PR); Homun =
*assistente personale local-first* (deliverable/memoria/automazioni/canali). La review non è "copia Codex" ma "quali
superfici di Codex alzano la UX di Homun **senza** tradirne l'identità".

## Cosa fa Codex che Homun non fa (gap UX)
1. **Pannello "Ambiente" a destra (la cabina di regia).** Nel thread Codex mostra a destra: **diff live "Modifiche
   +1493 −0"**, ambiente (Locale/cloud), **branch git**, **"Esegui commit o push"**, **stato PR**, "Fonti". Dà
   *situational awareness* costante: cosa l'agente ha cambiato, dove, e le azioni git a un click. **Homun non ha
   pannello di contesto** — la conversazione è a tutta larghezza, nessuna cabina di regia.
2. **Composer ricco.** Codex nel composer ha, inline: selettore **approval-mode** ("Accesso completo"),
   **modello + reasoning-effort** ("5.5 Medio/Elevato"), e chip **progetto / "Lavora in locale" / branch git**. Il
   composer di Homun ha **solo il selettore modello** (es. `deepseek-v4-pro`). Mancano: effort, approval-mode
   surfacato, contesto di scope.
3. **Organizzazione per Progetti.** Codex ordina la sidebar per **progetti (repo)** con thread annidati + età. Homun
   usa **Work/Create/Personal** (assistant-centrico) — ottimo per l'identità assistente, ma senza il senso di
   "progetto/repo attivo" che Codex dà al lavoro coding.
4. **Git/diff/PR di prima classe** (= roadmap Fase 3.1, non iniziata). È il cuore del coding-agent Codex; Homun non
   ha integrazione git in UI.

## Cosa fa Homun che Codex non fa (forze da NON perdere)
1. **Chip di deliverable nell'empty-state:** "Create a presentation / Write a document / Research & report / Meeting
   minutes / Search something" — un "cosa posso *fabbricarti*" (nord Manus-like) che Codex (solo-codice) non ha.
2. **Identità local-first esplicita:** "I'm ready. Just write to me: I reply locally." — messaggio di posizionamento
   che Codex non fa.
3. **Ampiezza da assistente:** Automations, Proactivity, memoria, canali (Gmail/etc. — visto un task email reale),
   presentazioni. Superfici che Codex non ha.
4. **Rendering markdown pulito** (liste annidate, bold, inline-code) — alla pari di Codex.

## Miglioramenti UX proposti (ordinati per ROI/rischio, coerenti con l'identità Homun)
| # | Miglioramento | Perché (da Codex) | Nota |
|---|---|---|---|
| **U1** | **Pannello di contesto a destra** — ma in versione Homun: *cosa sto facendo / cosa so*. Es. piano corrente + **artefatti prodotti** (deliverable) + memoria/fonti rilevanti + (quando c'è coding) diff/git. | La cabina di regia di Codex dà situational awareness | Alto valore. Riusa i deliverable come "artifacts panel". Coding-git = Fase 3.1 |
| **U2** | **Reasoning-effort nel composer** (accanto al modello) | Codex "5.5 Medio/Elevato" | = roadmap Fase 4.4; piccolo, alto impatto percepito |
| **U3** | **Approval-mode surfacato nel composer** (non solo in Settings) | Codex "Accesso completo" inline | Homun ha già l'asse approval (Fase 0.1) — va solo esposto |
| **U4** | **Scope/progetto nel composer** (workspace/progetto attivo come chip) | Codex progetto/branch chip | Homun ha già i workspace; surfacare il contesto attivo |
| **U5** | **Streaming a item tipizzati** (tool "in esecuzione…") | = §5 fluidity-map | UX responsiva durante i tool; ortogonale ma UX |

**Debito d'igiene collegato (non UX ma UI-code):** `ChatView.tsx` **9.398 righe** + `SettingsView.tsx` **6.893** —
enormemente sopra i limiti (soft 1500/hard 2500). Vanno splittati (come `main.rs` lato backend), a piccoli passi.

## Priorità onesta
**U1 (pannello di contesto)** è il gap UX più visibile e di maggior valore — dà a Homun la "cabina di regia" che oggi
manca, riusando i deliverable/memoria che Homun *già ha* (non serve il git per la prima versione). **U2/U3** sono
piccoli e ad alto impatto percepito (effort + approval nel composer). Il coding-cockpit completo (git/diff/PR) è
Fase 3.1 e va con l'identità coding-agent, non prima. **NON** perdere le forze differenzianti (deliverable chip,
local-first, ampiezza assistente): sono ciò che rende Homun *non* un clone di Codex.
