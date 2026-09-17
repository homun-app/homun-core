# Progetti con conversazioni separate

Direzione approvata: progetto facoltativo con più chat, compiti e materiali; gruppi rimandati.
Implementato:
- Rimozione gruppi dalla navigazione.
- Chat di progetto separate, titoli modificabili, allegati locali.
- Creazione esplicita di un compito da un messaggio, con scelta collaboratore e collegamento al risultato.
- Creazione progetto dalla conversazione di un incarico, mantenendo incarico e storico.
- Viste Chat, Compiti e Materiali.
Verifiche: TypeScript, lint (warning Fast Refresh preesistente), build, browser con conversione e due chat; creazione incarico Vera e ritorno alla chat.
Limiti: stato di sessione; nessun modello, memoria condivisa o selezione token. Chat di progetto non ancora indicizzate nella ricerca globale. Le chat libere sono interne al progetto; conversione dalla home disponibile sugli incarichi esistenti. Collegamento a progetti esistenti e gestione accessi restano da estendere. Eliminare un progetto elimina le chat libere interne; gli incarichi sono conservati e scollegati.

## Azioni conversazione e spostamento
- Menu condiviso accanto alla chat e alle righe degli incarichi nella sidebar: ricerca destinazione, sposta, togli dal progetto, crea progetto, rendi ricorrente (incarichi).
- Drag degli incarichi sui progetti o sulla voce Senza progetto.
- Chat libere spostabili dal menu, anche fuori dal progetto; conservate in detachedChats e raggiungibili da Senza progetto.
- Lo spostamento cambia l'organizzazione, non i permessi e non la condivisione dei documenti della raccolta. I riferimenti e gli allegati della conversazione restano invariati.
- Verificato browser: menu, chat libera fuori/dentro progetto con messaggio conservato, drag incarico fuori/dentro progetto. TypeScript, lint e build passano (warning preesistenti).

## Associazione materiali in blocco
- Selezione persistente durante ricerca, tutti i risultati, caricamento progressivo 30 righe, selezione dei file già importati per cartella.
- Overlay condiviso Collega a con ricerca per progetto/conversazione di lavoro/collaboratore, filtri tipo, selezione multipla, contesto e recenti della sessione della raccolta.
- Aggiornamento atomico e senza duplicati di materiali/progetti/incarichi.
- Accessi limitati conservati: avviso e conferma nel dialogo; nessuna estensione automatica. Il motore dovrà valutare permessi effettivi dei destinatari.
- Fixture opt-in: conversations.html?materials-demo=large, 100 file dimostrativi, 50 progetti, 100 conversazioni di lavoro. Non altera sessioni normali, nessuna persistenza.
- Browser: 100 materiali su due destinazioni, ricerca progetto con chat associate, selezione attraverso filtri, annullamento, Escape, cartella di 10 file, visualizzazione dialogo.
- Limiti: cartelle importate come snapshot; nuove aggiunte non collegate automaticamente. Ricerca destinazioni copre progetti e conversazioni di incarichi; chat libere non ancora incluse.
