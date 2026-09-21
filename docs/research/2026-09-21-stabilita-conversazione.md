# Stabilità della conversazione — scroll e attese oneste — 21 settembre 2026

> Seconda tranche del 21 settembre: chiude la priorità 2 del prompt di ripresa
> («scroll che salta durante i caricamenti, attese mute di 30-90s senza stato
> di avanzamento onesto») e la priorità 3 («409 su prepare con versione stantia
> senza recupero guidato»). Solo frontend: nessun modulo del motore toccato.

## Cosa è cambiato

### 1. Scroll che non interrompe la lettura

L'effetto in `ConversationWorkspace.tsx` forzava lo scroll al fondo a ogni
variazione di `work.messages.length` (con animazione smooth concatenata al
cambio lavoro): qualunque ricarica del transcript, caricamento o completamento
trascinava via chi stava leggendo più sopra.

Ora la decisione vive in una policy pura (`apps/web/src/lib/chat-autoscroll-policy.ts`,
testata) applicata dal nuovo hook `useChatAutoScroll`:

- cambio lavoro → un solo salto istantaneo sull'ultimo messaggio (niente doppio smooth);
- contenuto nuovo o ricaricato → segue solo se chi legge è ancorato al fondo
  (soglia 96 px, misurata sugli eventi di scroll dell'utente);
- chi legge sopra non viene mai trascinato: caricamenti, refresh e completamenti
  non spostano la posizione;
- il proprio messaggio in uscita segue sempre;
- i follow sono istantanei di proposito: un follow smooth riavviato a ogni token
  di streaming si legge come un salto.

### 2. Attese del modello oneste, dentro il transcript

Prima: il segnaposto «Homun sta elaborando…» veniva rimosso appena il routing
decideva per la proposta — per tutta la sintesi (30-90 s) non compariva nulla;
e in percorso chat restava una riga statica senza misura del tempo.

Ora il messaggio in volo porta uno stato strutturato
(`ConversationMessage.wait: { phase, startedAt }`) renderizzato dal nuovo
componente `ConversationAgentWait`:

- «Homun sta leggendo il messaggio…» durante classificazione e routing;
- «Homun sta preparando la proposta di accordo…» durante la sintesi del brief
  (il segnaposto non viene più rimosso: l'attesa resta visibile finché la scheda
  non è durevole);
- secondi trascorsi sempre visibili; oltre 45 s compare «Il modello può
  impiegare circa un minuto»;
- nessuna percentuale o progresso finto: solo fasi vere e tempo reale;
- al primo token la bubble cede il posto allo streaming, come prima;
- se il turno fallisce, il messaggio della persona resta visibile con una nota
  onesta («nessuna risposta applicata») invece di scomparire.

### 3. 409 a versione stantia con recupero guidato

Prima: un'azione dei tool (confronto, lettura, catena) con `expected_version`
stantia produceva l'errore secco «Qualcun altro ha aggiornato lo stesso
oggetto».

Ora la decisione è condivisa (`engine-conflict-recovery.ts` + `useConflictRecovery`)
sui tre hook tool (`usePriceComparison`, `useMaterialRead`, `useToolChain`):

- su `version_conflict` lo stato viene ricaricato automaticamente, gli id
  operazione vengono rinnovati (il retry è un comando nuovo) e compare una nota
  guidata invece dell'errore;
- i due casi hanno messaggi diversi e corretti: il **prepare** si può ripetere
  subito; l'**approve** respinto è permanentemente non approvabile (il motore
  lega l'approvazione alla versione congelata nella proposta: «Work changed;
  create a new proposal»), quindi la nota dice di preparare di nuovo l'azione
  **e la proposta stantia viene nascosta localmente**, riportando la scheda
  alla selezione;
- nessun retry automatico silenzioso: il comando respinto potrebbe essere
  applicato parzialmente, la ripetizione è sempre una scelta della persona;
- se il refresh stesso fallisce, l'errore tipizzato originale resta visibile.

## Prove realmente eseguite

Separate per tipo, come da metodo:

- **Test automatici (fake/deterministici):** frontend 192 superati (183
  precedenti + 6 della policy autoscroll + 3 del recupero 409, incluso il
  messaggio differenziato approve/prepare); typecheck pulito; build web e
  prototipo riuscite; controllo architettura 0 errori — il budget legacy di
  `ConversationWorkspace.tsx` è stato **abbassato** da 1442 a 1437 righe in
  `tools/architecture-baseline.json` (mai alzato).
- **Motore:** suite invariata e verde **453 superati, 1 saltato** (nessun file
  del motore modificato in questa tranche).
- **Modello reale + GUI (browser su profilo usa-e-getta, motore 8767 con
  `HOMUN_DATA_DIR` temporaneo, app servita via proxy same-origin 4187 per
  evitare il fix CORS del motore; il profilo reale su 8765 non è mai stato
  toccato):**
  - prima richiesta di lavoro → bubble «sta leggendo… 1 s» → proposta
    compare; raffinamento in chat → fase «sta preparando la proposta di
    accordo…» con contatore 1→9 s fino alla scheda;
  - durante la preparazione, scroll portato a 0: la posizione **è rimasta a 0**
    quando la proposta aggiornata e il transcript sono arrivati (con il codice
    precedente sarebbe stato forzato al fondo); da ancorato al fondo, la
    crescita del contenuto è stata seguita (top 1648→1672 con altezza
    1933→1957);
  - risposta invalida del modello (`intake_invalid_response`, riprodotta due
    volte per nondeterminismo del cloud): scheda «DA RIPRENDERE» con ripristino
    riuscito via polling (segnaposto `intake_interrupted` → proposta
    confermabile);
  - conferma accordo → Bruno responsabile, scheda/riepilogo/sidebar coerenti;
  - 409 reale: confronto preparato dai materiali di progetto, rinomina del
    lavoro (versione avanzata), approvazione → nota guidata senza errore secco,
    proposta stantia rimossa, selezione ripristinata; nuova preparazione e
    approvazione → **report eseguito con i numeri dell'oracolo demo** (16/15
    righe, 4 aumenti, 3 ribassi, 2 invariati, 3 nuovi, 3 rimossi, 3 esclusi,
    4 anomalie);
  - domanda pura in lavoro confermato → classificazione in chat, attesa onesta
    fino a 80 s (nota dei 45 s comparuta), risposta in streaming ancorata al
    risultato («4 aumenti di prezzo»), nessun lavoro o collaboratore creato.

## Limiti rimasti

- Il follow durante lo streaming è istantaneo, non animato (scelta: la
  smooth ripetuta per token è la causa del salto che si voleva eliminare).
- L'upload di file nel browser in-app resta non automatizzabile (file chooser
  non supportato): il percorso 409 è stato verificato con i materiali di
  progetto, non con upload diretti.
- La nota di recupero nasconde la proposta respinta solo in memoria: dopo un
  reload completo la proposta stantia riappare nell'elenco finché non viene
  superata da una più recente (approvarla di nuovo produce lo stesso recupero
  guidato, verificato).
- Il pannello destro mostra «Da concordare» per un lavoro in bozza con accordo
  confermato: etichetta preesistente dello stato `draft`, non toccata in
  questa tranche (da raffinare con il piano multi-fase).
- Nessun test mount/unmount React dedicato per l'ancoraggio dello scroll: la
  policy è testata come modulo puro e il comportamento verificato in GUI; il
  debito resta registrato come per il ciclo di refresh.
- Il pacchetto desktop non è stato ricostruito (tranne frontend-only): la
  build di riferimento resta `dist/desktop/2026-09-21T08-01-10-928Z`, che non
  incorpora queste modifiche web.

## File toccati

- Nuovi: `apps/web/src/lib/chat-autoscroll-policy.ts`,
  `apps/web/src/hooks/useChatAutoScroll.ts`,
  `apps/web/src/components/builder/ConversationAgentWait.tsx` (+ css),
  `apps/web/src/lib/engine-conflict-recovery.ts`,
  `apps/web/src/hooks/useConflictRecovery.ts`,
  `apps/web/src/components/HomunGuidanceNotice.tsx`,
  `tests/chat-autoscroll-policy.test.ts`, `tests/engine-conflict-recovery.test.ts`.
- Modificati: `ConversationWorkspace.tsx` (effetto scroll sostituito dall'hook),
  `ConversationWorkspaceChatStage.tsx` (render dell'attesa),
  `conversation-types.ts` (`AgentWait`), `useEngineWorkspace.ts` (fasi di attesa
  e messaggio preservato sull'errore), i tre hook tool, le tre schede tool
  (nota guidata), `engine-status-bar.css`, `tools/architecture-baseline.json`
  (budget abbassato).
