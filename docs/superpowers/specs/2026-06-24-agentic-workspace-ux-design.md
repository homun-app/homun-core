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

### Workspace Island: lavoro in corso

La direzione aggiornata prende Zcode/Zed come riferimento: lo stato operativo
vive in una piccola **Workspace Island** flottante, compatta di default e
contestuale al thread. La chat resta pulita; piano, activity e artifact non
devono diventare pannelli permanenti dentro il corpo dei messaggi.

La Workspace Island:

- mostra stato sintetico (`Plan`, `Activity`, `Artifacts`, stato streaming);
- resta una pill compatta nello stato chiuso;
- al click la pill si trasforma in una card flottante nello stesso anchor, senza
  pulsanti esterni disallineati;
- la card mostra riepilogo progressivo del piano e degli ultimi step;
- il menu `...` permette `Auto expand`, `Always expanded` e `Always collapsed`;
- la sezione `Progress` puo' comprimere/mostrare gli step completati, che restano
  barrati e meno prominenti rispetto al lavoro corrente;
- `Artifacts` mostra un elenco compatto dei file quando espanso; il conteggio da
  solo non e' sufficiente;
- non apre il Workbench come effetto collaterale dei controlli di espansione;
- resta per-thread: non mostra stato di un thread diverso;
- puo' restare visibile come riepilogo leggero quando ci sono artifact o piano
  utile, ma non deve lampeggiare o simulare lavoro attivo a task concluso.

Il computer e' una superficie separata: quando il browser/terminal locale e'
live, compare una **Computer Island** sotto la Workspace Island, con mini preview
del browser come oggi. Si espande per vedere il computer completo e scompare
quando l'attivita' termina. I log finali possono restare in `Activity`, non come
pannello computer persistente.

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
  semanticamente distinta da essi; il suo header e' il controllo di collapse,
  senza una seconda riga duplicata.
- **Projects**: lista diretta dei workspace/progetti, senza dropdown primario;
  ogni progetto si espande/collassa in modo indipendente e aprire l'albero non
  cambia workspace finche' l'utente non seleziona un thread.

Le chat nella sidebar si ordinano per ultima attività reale, non per ultimo
click di lettura. Il placeholder iniziale e' `New task` anche in locale italiano;
appena il primo prompt viene accettato, la sidebar deve mostrare un titolo breve
sintetizzato dal contenuto invece delle prime parole grezze.

Quando la sidebar e' chiusa su desktop, Homun non mostra una rail fissa e non
apre la sidebar con hover sul bordo. L'utente usa un opener esplicito nel footer
zone; la sidebar persistente resta una piccola isola con margine ridotto, bordo
arrotondato e ombra leggera, abbastanza vicina al bordo da includere
visivamente i controlli nativi macOS. Il toggle non vive nella titlebar:
Electron mantiene i controlli nativi della finestra e la UI usa solo strip di
drag esplicite, lasciando i controlli interattivi fuori dalle regioni
`-webkit-app-region: drag`. Su mobile/tablet la stessa superficie resta overlay
esplicito, senza dipendere dall'hover.

Settings usa la stessa geometria shell della sidebar persistente: contenitore a
isola con margini, radius e ombra coerenti. Questo non implica un redesign
completo delle pagine Settings; mantiene solo chrome e navigazione laterale
allineati al resto dell'app.

Gli addon dichiarano `navSection`, `promoted` e ordine nel manifest/registry. La
sidebar usa questi metadata per promuovere una capability senza hardcode.

## Fuori scope per la prima slice

- Redesign completo dei contenuti Settings.
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
