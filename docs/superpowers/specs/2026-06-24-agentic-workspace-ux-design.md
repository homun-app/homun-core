# Homun Agentic Workspace UX Design

Data: 2026-06-24

## Decisione di prodotto

Homun non deve essere una chat con funzioni aggiunte, ne' una dashboard generica.
Il modello UX vincolante e' un **workspace agentico operativo con chat al centro**:
l'utente formula obiettivi in linguaggio naturale, Homun pianifica, seleziona
capability dal registry unico, esegue lavoro locale/cloud secondo policy, mostra
stato ed evidenze, produce artifact e permette revisione/ripresa.

Questa direzione combina tre riferimenti di mercato senza copiarne la UI:

- **Codex** per task agentici, lavoro in background, ambienti di esecuzione,
  verifica e ripresa.
- **Claude Code** per trasparenza del lavoro, tool activity leggibile,
  controllo esplicito e contesto verificabile.
- **Manus** per l'idea di action engine che consegna risultati end-to-end.
- **Z.ai** per template/deliverable belli: catalogo, preview, design conventions
  e output professionale.

## Principi UX

1. **Chat al centro, non chat come unico contenitore.** La conversazione resta il
   comando naturale e la timeline narrativa, ma piano, computer, artifact e
   capability devono avere superfici dedicate quando diventano stato operativo.
2. **Stato per-thread.** Activity, computer, piano e artifact devono essere
   contestuali al thread/workflow che li ha generati. Non devono apparire come
   stato globale ambiguo mentre l'utente cambia chat.
3. **Progressivita' reale.** Markdown, plan, tool activity e file generati devono
   emergere durante lo stream appena esistono, non solo a fine risposta.
4. **Esecuzione spiegabile.** Ogni lavoro non banale deve chiarire: cosa sta
   facendo, quale capability ha scelto, perche', cosa aspetta, cosa ha prodotto.
5. **Deliverable di prima classe.** Artifact, versioni, template usati, origine e
   provenance non sono allegati passivi: sono output gestibili, richiamabili e
   collegati alla memoria canonica.
6. **Un solo registry mentale.** L'utente non deve distinguere make, MCP, skill,
   plugin o connector. Homun deve cercare capability, scegliere il tool piu'
   adatto e poter spiegare la scelta.
7. **Densita' operativa, non marketing UI.** Homun e' uno strumento di lavoro:
   deve essere quieto, leggibile, denso quanto basta, con superfici prevedibili.
   Evitare hero, card decorative e palette mononota.

## Struttura target

### Sinistra: orientamento

La sidebar deve aiutare a capire dove sono e cosa e' attivo:

- navigazione primaria: Search, Automations, Proactivity, Presentations,
  Settings/Capabilities dove necessario;
- workspace/persona;
- thread list;
- indicatori piccoli ma chiari per running, waiting approval, failed, completed;
- niente duplicazioni o lampeggi persistenti se un task e' concluso.

La sidebar non deve diventare il pannello operativo principale: segnala stato e
permette navigazione.

### Centro: conversazione

La chat resta la superficie primaria:

- messaggi leggibili e progressivi;
- composer stabile, non espanso in modo imprevedibile;
- azioni messaggio discrete;
- plan card inline solo quando serve al contesto della conversazione;
- artifact links sempre visibili quando un output e' prodotto.

La chat non deve ospitare dock globali o stati di tool non appartenenti al thread
attivo.

### Dock contestuale: lavoro in corso

Il dock Computer/Activity/Plan deve essere contestuale, collassabile e con stato
chiaro:

- appare appena una capability/tool execution parte;
- mostra solo il lavoro del thread attivo, o segnala esplicitamente che un altro
  thread sta lavorando;
- si chiude o passa a stato completato quando il lavoro finisce;
- distingue browser/computer, shell, filesystem, approvals, artifact generation;
- non resta visibile come "Computer 2 commands" se non c'e' attivita' rilevante.

Il dock puo' diventare laterale o bottom panel in una fase successiva, ma la
prima slice deve sistemare proprieta', timing e stati prima del layout.

### Destra futura: artifact/task inspector

Una colonna destra stabile puo' essere valutata dopo la prima slice, ma non e'
il primo intervento. Sarebbe utile per:

- dettagli artifact/versioni;
- stato piano espanso;
- template preview;
- provenance e "perche'".

Va introdotta solo se non appesantisce la chat.

## Prima slice UX

La prima slice deve essere piccola e verificabile, non un redesign globale:

1. **Activity ownership**
   - Computer/Activity mostra stato solo se appartiene al thread attivo.
   - Se un altro thread lavora, la sidebar mostra un indicatore e il thread puo'
     essere aperto, ma il dock non invade la chat corrente.

2. **Lifecycle del dock**
   - Running: appare appena parte il tool/workflow.
   - Waiting approval: mostra richiesta e azione attesa.
   - Completed/failed: resta come sintesi compatta o scompare secondo il tipo di
     output; non resta come pannello operativo aperto a lavoro finito.

3. **Progressive rendering**
   - Plan e markdown devono usare lo stesso renderer progressivo del messaggio
     finale.
   - Le card plan non devono comparire solo alla fine se il marker e' gia'
     presente nello stream.

4. **Sidebar state cleanup**
   - Indicatori running/waiting/completed coerenti.
   - Nessun lampeggio persistente dopo completamento.
   - Titoli thread non duplicati a causa di replay/stale state.

5. **Visual coherence pass leggero**
   - Spaziature, stati, contrasto e densita' su sidebar/chat/dock.
   - Nessuno stravolgimento di navigazione finche' ownership/lifecycle non sono
     solidi.

## Sidebar direction

La sidebar aperta prende Linear come riferimento di pulizia: righe dense,
sezioni semantiche e active state sobrio. La classificazione visibile non deve
riflettere la natura tecnica degli addon, ma il loro ruolo operativo.

- **Work**: attività operative e automazioni.
- **Create**: capability creative/promosse, per esempio Presentations.
- **Workspace**: risorse del workspace come Projects, Artifacts, Memory quando
  hanno una superficie diretta.
- **More**: addon, connector o strumenti abilitati ma non promossi.
- **Personal**: categoria di chat non legate a un progetto, pari ai progetti ma
  semanticamente distinta da essi.
- **Projects**: lista diretta dei workspace/progetti, senza dropdown primario;
  il progetto attivo si espande e mostra i thread recenti.

Gli addon dichiarano `navSection`, `promoted` e ordine nel manifest/registry. La
sidebar usa questi metadata per promuovere una capability senza hardcode.

## Fuori scope per la prima slice

- Redesign completo di Settings.
- Nuova colonna destra permanente.
- Nuovo marketplace/plugin UI.
- Template gallery definitiva.
- Nuovi workflow make/research/meeting.

## Test e gate attesi

- Unit test/view-model dove possibile per ownership e lifecycle.
- UI contract test per:
  - dock visibile solo per thread owner;
  - stato completed non lascia pannello operativo aperto;
  - plan marker renderizzato progressivamente;
  - sidebar busy indicator coerente.
- Smoke manuale in-app:
  - avvia task lungo in thread A;
  - cambia thread B;
  - verifica che B non mostri il dock di A;
  - torna ad A;
  - verifica progress/completion e artifact links.

## Criterio di successo

La UX deve far capire in ogni momento:

- quale lavoro e' in corso;
- a quale thread appartiene;
- quale capability/tool sta usando;
- cosa aspetta dall'utente;
- cosa ha prodotto;
- come riprendere o correggere.

Se una modifica rende questi punti meno chiari, non appartiene al redesign.
