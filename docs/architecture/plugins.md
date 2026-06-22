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
