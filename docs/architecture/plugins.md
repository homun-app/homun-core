# Architettura — Skill, Capability & Addon

> Diagramma vivo. Decisioni: [ADR 0011 (core agnostico + ecosistema addon)](../decisions/0011-agnostic-core-addon-ecosystem.md),
> [ADR 0009 (capability execution containment)](../decisions/0009-capability-execution-containment.md),
> [ADR 0013 (connector auth & routing)](../decisions/0013-connector-auth-and-capability-routing.md).

## Principio

**Core agnostico** (invarianti bloccate) + **ecosistema addon** sopra. Le capability
sono "cosa l'agente può fare"; le skill/plugin estendono il comportamento senza
toccare il core. Tre origini per gli addon: **installati · scritti · generati**.

## La pila

```mermaid
flowchart TD
  subgraph CORE[Core agnostico — INVARIANTI bloccate]
    ENG[Agent engine · memoria · piano]
  end
  subgraph CAP[Tool / Capability layer]
    BR[Browser granulare<br/>navigate/snapshot/act]
    LC[Local Computer / sandbox<br/>shell · file · exec + policy]
    SK[Skills<br/>skill-runtime + sandbox]
    MCP[Connettori<br/>MCP · Composio OAuth]
    ART[Artifacts / deliverable<br/>create · versioning]
  end
  ENG --> CAP
  subgraph ADDON[Ecosistema Addon — ADR 0011]
    PS[Process Skill<br/>trigger canale/schedule/evento<br/>→ passi deterministici/agente → approval]
    PC[Contratto di personalizzazione<br/>zona BLOCCATA invarianti + zona APERTA<br/>overlay-dato via prompt · validato · versionato]
  end
  CAP --> ADDON
  ADDON -->|3 origini| ORI[installati · scritti · generati]
```

## Skill vs Plugin (forma)

- **Skill** = istruzioni + risorse che il modello carica via `use_skill` (oggi
  prosa; in evoluzione: skill **dichiarative** → workflow runner, ADR 0016 Fase 3).
  Seeding in `~/.homun/skills/`; *gotcha noto*: una skill editata a mano (hash
  desync) non viene più auto-aggiornata → da irrobustire (WS4).
- **Plugin / Addon** (ADR 0011) = capability + Process Skill + contratto di
  personalizzazione (upgrade-safe: manutenzione centrale, overlay-dato dell'utente).

## Capability Registry Unico

La direzione SOTA per Homun non è “più tool nel prompt”, ma **un registry grande
e un toolset live piccolo**. Tutto ciò che Homun sa fare entra nello stesso
registry logico:

- workflow nativi end-to-end (`make_deck`, `make_document`, futuri `make_*`);
- MCP/Composio connector tools;
- skill/addon installati o generati;
- strumenti atomici interni (PDF, filesystem, browser, artifact, memoria).

Il turno deve:

1. interrogare semanticamente il registry per capability candidate;
2. decidere in modo strutturato se usare un workflow end-to-end, un tool atomico,
   una skill/addon, un piano o un chiarimento;
3. loggare la scelta e il perché;
4. esporre al modello solo le capability minime per quel turno.

Le keyword/euristiche sono ammesse solo come prefilter economico, fallback offline
o guardrail di sicurezza. Non sono la verità primaria di routing. Esempi:

- “voglio creare un pitch per Homun” → recupera `make_deck` anche senza `slide`;
- “crea un report PDF” → workflow `make_document`;
- “estrai testo da questo PDF” → tool atomico/MCP PDF;
- “unisci questi PDF” → tool atomico/MCP PDF, non `make_document`.

Stato corrente (2026-06-23): prime slice locali/verdi su workflow nativi. Le
entry `make_deck` e `make_document` vivono in un registry nativo usato sia dal
router workflow/agent sia dal corpus `find_capability`; i workflow non sono
duplicati nel corpus deferred generico. La decisione interna è strutturata
(`Workflow`, `AtomicTool`, `AgentLoop`) e porta un `reason`: la prima policy di
conflitto distingue creazione report PDF (`make_document`) da operazioni atomiche
PDF come estrazione, unione o conversione (`pdf_atomic`). Il loop agente usa la
stessa decisione per system prompt, route workflow e trace runtime (`ACT` +
`tool_trace`). `pdf_atomic` è ora una capability atomica nativa nel registry e
mappa a `run_in_sandbox`; un tool PDF dedicato resta opzionale se serve uno
schema più guidato.

## Esecuzione contenuta (ADR 0009/0010)

Le capability rischiose girano **contenute**: sandbox skill, `ShellCommandPolicy`,
**Contained Computer** (Linux containerizzato: browser reale + shell per
verify-by-execution del codice). Approval gate per le azioni rischiose; contenuto =
**dato**, mai istruzioni.

## Distribuzione & ciclo di vita (WS9 — futuro vicino)

Da "app con plugin" a **piattaforma**: ogni plugin ha versioning proprio, canali,
è scaricabile dal **sito Homun** e si auto-aggiorna; alcuni saranno **a pagamento**.

```mermaid
flowchart LR
  DEV[Autore plugin] --> MAN[Manifest<br/>semver · channel stable/beta<br/>min_homun_version · entitlement free/paid · firma]
  MAN --> REG[Registry sul sito Homun<br/>indice JSON + pacchetti FIRMATI]
  REG -->|catalogo| PM[Plugin manager in-app<br/>installa · beta opt-in · auto-update]
  PM -->|verifica firma Ed25519| INST[Installato<br/>esecuzione contenuta ADR 0009]
  PM -->|entitlement paid| LIC[Token licenza firmato<br/>verifica OFFLINE + ri-check]
  LIC -.account+pagamenti.-> CLOUD[(backend store — lega cloud/always-on)]
```

- **Versioning/compat**: semver + `min_homun_version` (come `engines` di VS Code).
- **Canali**: stable (firmato/revisionato) · beta (opt-in per-plugin).
- **Sicurezza**: firma verificata all'install/update; contenimento + `skill_security`.
- **Paid**: predisporre ora (`entitlement` + token firmato offline); paywall dopo
  (account + pagamenti = cloud/always-on).

## Direzione

North-star prodotto = deliverable in stile **Manus** per le PMI (presentazioni →
documenti → ricerca…), come **workflow dichiarativi** che il runtime guida e il
modello riempie. Vedi [agent-loop.md](agent-loop.md) (Fase 3) e il
[backlog](../plans/2026-06-22-batch-1042-artifacts-memory.md).
