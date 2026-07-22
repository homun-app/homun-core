# Homun Presentation Transcript and Functional Demo Tour Design

**Date:** 2026-07-22
**Status:** Approved for production planning
**Related presentation design:** `docs/superpowers/specs/2026-07-21-homun-launch-video-presentation-design.md`

## Purpose

Prepare the Italian spoken narrative and the live demonstration for Homun's
technical product presentation. The presentation must explain why Homun exists,
show that it is broader than a coding agent, distinguish current capabilities
from future direction, and leave enough time for informed audience questions.

Slides and generated deliverables remain in English. Fabio speaks in Italian and
enters live prompts in Italian. The target format is a 42–45 minute presentation
followed by 10–15 minutes of questions.

## Approved communication model

The transcript is a hybrid script rather than either a rigid speech or a list of
talking points. Each slide section contains:

- target duration;
- what the audience sees;
- a natural Italian script that can be spoken verbatim;
- a small set of anchor words for recovering the thread without reading;
- an optional paragraph that can be omitted without breaking the narrative;
- a transition to the next slide or demonstration step;
- non-spoken stage directions;
- the most likely question linked to that section.

The slide narrative occupies approximately 23–25 minutes. The functional tour
occupies approximately 18–20 minutes. A shortened route must fit into 35 minutes
by removing only clearly marked optional paragraphs and optional demonstration
steps.

## Presentation structure

1. **Why Homun exists — about 8 minutes.** Autonomy, provider dependency,
   replaceable models and a stable user-owned system.
2. **What Homun can do now — about 3 minutes.** Introduce the product surface and
   explain the demonstration contract.
3. **Functional tour — 18–20 minutes.** Understand, Remember, Act, Continue and
   Deliver.
4. **Verticalization and ecosystem — about 7 minutes.** Plugins, professional
   capabilities, registered developers and a governed marketplace.
5. **Business model and roadmap — about 5 minutes.** Free Core, Personal and Team;
   one-time plugins; paid major upgrades; support; customization; future
   marketplace commission.
6. **Closing — about 1 minute.** Return to the independence promise.
7. **Questions — 10–15 minutes.** Use the prepared question bank and bounded live
   requests.

## Demonstration architecture

The demonstration is a modular tour with one common project. `Project Atlas` is
the sanitized internal launch project for Homun. It contains no personal,
customer or confidential data. Every chapter can be skipped without invalidating
the remaining chapters.

The five chapters form a single work cycle:

> Understand information, preserve decisions, act through controlled tools,
> continue work over time and channels, and deliver a professional result.

Software development is one capability within the cycle, not the organizing
identity of the product.

## Project Atlas materials

The production plan must create and verify these sanitized materials:

- `homun-launch-brief.pdf`: goals, audience and product thesis;
- `audience-notes.md`: objections expected from a technical audience;
- `launch-constraints.csv`: requirements, priority, owner and verification state;
- a small TypeScript dashboard repository with deterministic tests and a
  reset-to-baseline mechanism;
- a Homun Brand Kit suitable for the generated presentation;
- a Filesystem MCP server named `Project Files`, restricted to the Project Atlas
  directory;
- one allowlisted Telegram destination and, only if it passes the reliability
  gate, one sanitized WhatsApp test contact.

## Chapter 1 — UNDERSTAND

This chapter proves document analysis, heterogeneous project data, explicit MCP
tool use, web research and source-aware synthesis.

### Prompt 1 — Combined document and MCP analysis

> Analizza `homun-launch-brief.pdf`. Attraverso il server MCP Project Files leggi
> anche `audience-notes.md` e `launch-constraints.csv`. Estrai problemi, pubblico,
> differenziatori, obiezioni e prove disponibili. Per ogni conclusione mostra la
> fonte esatta. Evidenzia contraddizioni e affermazioni ancora prive di prova. Non
> proporre ancora una strategia.

The visible result must distinguish PDF, Markdown and CSV sources, cite them
individually, and flag contradictions or missing evidence rather than only
summarizing content.

### Prompt 2 — Official-source web verification

> Verifica sul web le affermazioni emerse dall'analisi usando soltanto fonti
> ufficiali: homun.app, documentazione e repository pubblico di Homun. Restituisci
> una tabella con: affermazione, fonte interna, fonte pubblica, stato della verifica
> e aggiornamento necessario. Ignora snippet e fonti secondarie.

The result must contain accessible links, distinguish internal from public
evidence, and avoid unsupported conclusions.

### Prompt 3 — Controlled recommendation

> Sulla base delle informazioni verificate, proponi tre opzioni di posizionamento
> per Project Atlas. Per ciascuna indica vantaggio, rischio e prova disponibile.
> Raccomandane una, ma non registrare alcuna decisione finché non la approvo.

The chapter enters the live route only after the complete analysis and research
finish within four minutes in three consecutive rehearsals. If the live web
research remains slower or unstable, document and MCP analysis stay live while a
recording of web verification from the same build replaces only that step.

## Chapter 2 — REMEMBER

This chapter proves that analysis does not silently become project memory, that
an approved decision retains provenance, and that another conversation can reuse
the decision without copied context.

### Prompt 4 — Explicit decision capture

> Approvo il posizionamento che presenta Homun come workspace AI indipendente:
> modelli sostituibili, memoria ispezionabile, azioni controllate e plugin per
> verticalizzare il lavoro. Registralo come decisione di Project Atlas,
> collegandolo alle fonti utilizzate nell'analisi. Non trasformare le altre opzioni
> in decisioni.

The demonstration opens the Project Atlas memory record and shows the readable
decision, original source links, relevant document relationships, and the
available correction or forget controls.

### Prompt 5 — Recall from a new conversation

> Quale posizionamento abbiamo approvato per Project Atlas? Spiega quali prove lo
> sostengono e mostrami la decisione e le fonti da cui lo ricordi.

The visible result must recover the four approved themes, distinguish the chosen
decision from rejected options, and expose the source from a new project
conversation. Capture and recall must succeed three consecutive times without
cross-project information. If immediate indexing is not reliable, the decision
is prepared before the event; provenance inspection and new-chat recall remain
live.

## Chapter 3 — ACT

This chapter proves repository understanding, user approval before mutation,
bounded software modification, tests, diff inspection and verification through
the controlled computer.

The demo dashboard contains a deterministic defect: it reports `Ready` when
project memory has not been indexed.

### Prompt 6 — Analysis without mutation

> Analizza il repository di Project Atlas. La dashboard segnala `Ready` anche
> quando la memoria non è indicizzata. Individua la causa, controlla i test
> esistenti e proponi un piano minimo. Non modificare alcun file finché non approvo
> il piano.

### Prompt 7 — Approved change

> Approvo il piano. Correggi soltanto il difetto, aggiungi un test di regressione,
> esegui i test e mostrami il diff finale. Non effettuare refactoring non
> necessario.

### Prompt 8 — Controlled-computer verification

> Avvia l'anteprima locale di Project Atlas e usa il computer controllato per
> verificare il comportamento della dashboard. Controlla prima il caso con memoria
> non indicizzata e poi quello con memoria indicizzata. Non visitare siti esterni e
> non interagire con altre applicazioni. Restituisci le evidenze dei due risultati.

The computer must show `Not ready` before indexing and `Ready` after the prepared
state control is changed. The repository must be restorable to its exact initial
state after every rehearsal. The complete chapter has a five-minute limit. If
controlled-computer interaction is intermittent, analysis, approval, change,
tests and diff remain live; visual verification is replaced by an authentic clip
recorded from the same build.

## Chapter 4 — CONTINUE

This chapter proves scheduled work, MCP-backed input, filtering, explicit
activation and delivery through a channel.

Telegram is the primary live channel. WhatsApp is eligible for the live route
only after three complete sanitized rehearsals without exposing personal chats or
contacts.

### Prompt 9 — Automation proposal

> Crea una proposta di automazione per Project Atlas chiamata "Atlas Launch
> Monitor". Ogni cinque minuti deve leggere `launch-constraints.csv` attraverso
> Project Files MCP. Se trova un requisito P0 o P1 bloccato, deve inviare su
> Telegram un messaggio con requisito, responsabile, blocco e prossima azione. Se
> non ci sono blocchi prioritari, non deve inviare nulla. Mostrami regola, filtro,
> destinazione e permessi richiesti, ma non attivarla senza approvazione.

### Prompt 10 — Activation and immediate proof

> Approvo questa automazione. Attivala ed eseguila una volta adesso come prova.
> Mostrami il risultato, il messaggio inviato e la prossima esecuzione programmata.

The CSV contains one fictional blocked priority item so the message is
deterministic. The automation is disabled immediately after the demonstration.
The complete proposal, approval, execution and Telegram delivery must finish
within three minutes.

### Optional WhatsApp continuity proof

The allowlisted test contact sends:

> Qual è lo stato di Project Atlas e qual è il blocco prioritario?

Homun must route the message to Project Atlas, use project state, respond on the
same channel and keep the conversation visible in the application. No personal
chat list or notification may appear. If this path does not pass the gate, the
live route shows Telegram and uses a short WhatsApp clip.

## Chapter 5 — DELIVER

This chapter proves multilingual instruction, project continuity, source-aware
content, use of a professional vertical plugin and a reusable artifact.

### Prompt 11 — English launch presentation

> Prepara una presentazione in inglese di cinque slide per il lancio di Project
> Atlas, destinata a un pubblico tecnico. Usa la decisione approvata e soltanto le
> affermazioni verificate presenti nel progetto. La struttura deve coprire:
> problema, principio architetturale, prova disponibile, roadmap e call to action.
> Applica il Brand Kit Homun e un template pitch pulito. Mostra le fonti utilizzate
> e non introdurre funzionalità non dimostrate. Presentami prima il piano, poi
> genera il deliverable.

The prompt intentionally does not repeat the approved positioning. The output
must recover it from Project Atlas, remain in English, use verified claims, apply
the selected Brand Kit and template, and generate openable PPTX, PDF and HTML
artifacts. The presentation proof opens the cover, architecture, evidence,
roadmap and artifact entry.

The plan must appear within 30 seconds and the preview within four minutes. If
rendering exceeds the limit, plan and tool activity stay live and the artifact
from the immediately preceding verified rehearsal is opened.

## Audience questions

The production package contains a question bank grouped into:

- positioning and the relationship with Claude, Codex and other engines;
- local-first architecture, provider data flow, memory, provenance, project
  isolation, MCP security, controlled computer, plugins and automation failure;
- current product, experimental surfaces, supported platforms and providers,
  official plugins, developer tooling and marketplace roadmap;
- FSL terminology and limitations, the Apache 2.0 future license, free Team
  access, one-time plugins, major upgrades, services and future commission.

Every question has a 20–30 second answer, an optional technical expansion, a
demonstrable current fact, and an explicit future-only boundary where needed.

## Unplanned live requests

Only requests meeting all of these conditions may be accepted:

- confined to Project Atlas;
- read-only or safely reversible;
- expected to complete within two minutes;
- no new credentials, accounts, providers or MCP connections;
- no package installation or infrastructure change;
- no messages to destinations other than the prepared demo contact;
- no access to files, contacts or applications outside the sanitized project.

Prepared safe examples include source comparison, decision recall, a short
English executive summary, and explaining the prepared repository test without
modifying code. A request to connect a new account or service is answered by
showing the path without entering credentials.

## Verification and rehearsal protocol

Before any reset, create and verify a private backup of the existing Homun demo
profile. Reset only after confirming the backup contents, SQLite integrity and a
recorded restore path.

For each prompt record:

- response duration;
- selected model, tools and capabilities;
- expected and actual visible result;
- source and project isolation;
- errors, ambiguity and privacy concerns;
- required product fix or data adjustment;
- stable alternative and fallback boundary.

Each module must pass three consecutive independent rehearsals. The entire route
must pass twice with a single timer. A product defect is fixed only when it blocks
an approved current capability and the correction can be verified safely before
the event. An intermittent path is replaced rather than represented as stable.

Fallback recordings must be silent, use the same current build and sanitized
Project Atlas state, and show only the failed step. They are not edited to imply a
continuous live action that did not occur.

## Deliverables

- full Italian hybrid transcript;
- shortened 35-minute route;
- one-page timing and anchor-word sheet;
- final prompt catalogue;
- click-by-click demo runbook with expected results and fallbacks;
- sanitized Project Atlas document and repository package;
- rehearsal log and readiness gate;
- technical, product, licensing and business Q&A bank;
- verified fallback clips for approved unstable paths.

## Out of scope

- exposing personal or customer data;
- publishing the launch videos or presentation collateral;
- connecting new third-party accounts during the event;
- claiming the future marketplace or developer ecosystem is currently available;
- presenting a flaky capability as live-ready;
- broad product refactoring unrelated to an observed presentation blocker.
