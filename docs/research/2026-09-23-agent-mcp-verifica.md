# MCP nel ciclo agente nativo: verifica end-to-end

## Risultato

Homun può usare strumenti MCP nel ciclo nativo. La persona seleziona fino a quattro
server dichiarati (massimo 32 strumenti esposti); discovery e descrittori vengono
fissati nel contratto del run. Il registro comune fornisce gli schemi al modello,
la ricerca e la validazione degli argomenti. Il nome di trasporto usa namespace e
suffisso hash stabile, derivati dal disegno Hermes con attribuzione.

Il modello sceglie strumento e argomenti. Homun persiste insieme la proposta
esatta e l'attesa `waiting_external`; l'avvio del run non autorizza l'azione.
La UI mostra descrizione e argomenti e richiede approvazione esplicita. Il server
viene chiamato attraverso il contratto MCP già verificato, con ricevuta salvata
prima di ogni prosecuzione. La ricevuta alimenta una sola volta il tool result
nativo; la riconciliazione DBOS riavvia il ciclo con una nuova epoca. Solo il
risultato finale dell'agente diventa artifact in revisione.

Proposte esterne e run sono legati da epoca, call id, configurazione, descrittore
e argomenti. Annullamento prima del consenso impedisce l'IO; durante l'IO conserva
la ricevuta indipendentemente dal run e registra l'interruzione come incerta.
Un intento esterno scaduto viene marcato incerto e poi blocca il run senza retry.
Errori noti e argomenti malformati diventano osservazioni che il modello può
correggere. Proposte manuali esistenti non possono essere associate implicitamente
al run, nemmeno con collisioni di ID durante la discovery.

## Evidenza reale

[Script](evidence/2026-09-23-hermes-parity/agent_mcp_ollama.py) e
[traccia](evidence/2026-09-23-hermes-parity/agent_mcp_ollama.json): Ollama locale
`qwen3.5:4b` sceglie un vero tool stdio `lookup_order` per `OR-93`. Prima del
consenso non esiste alcuna chiamata; il consenso umano è fornito esplicitamente
dalla fixture usando l'operazione applicativa, non dall'agente. Dopo la ricevuta,
il contesto viene chiuso e ricreato dalla stessa SQLite, poi il modello riprende.

Risultato: `waiting_external` → `completed`, **una sola chiamata esterna**, **un
solo artifact**, codice OR-93, responsabile Marta e consegna 8 ottobre 2026
corretti. Nessuna scelta di tool o risposta del modello è simulata. La prova non
attesta la UI installata: i componenti sono coperti da rendering statico,
typecheck/build e test; non è stata eseguita una sessione browser interattiva.

I test coprono anche ripresa senza consumo duplicato, due chiamate nello stesso
round con consensi separati e ordine preservato, annullamento durante IO,
argomenti malformati, intento scaduto, proposta manuale preesistente e collisione
concorrente di ID. La revisione ha individuato e corretto i percorsi di deduplica
e un controllo collocato nel ramo destinatario umano invece che nella proposta.

Verifica finale: **800 test engine passati, 1 saltato**, più **9 controlli mirati**
sulle ultime correzioni; **220 test web passati**, typecheck/build riusciti, OpenAPI
allineato e architettura 0 errori (35 avvisi dimensionali preesistenti). Revisione
finale senza ulteriori rilievi.

## Limiti

- Solo run con protocollo nativo; i run JSON precedenti conservano il loro catalogo.
- L'approvazione è per ogni chiamata, anche se il server la annota come read-only.
- Nessuna attivazione pigra o spill automatico dei risultati grandi. Resources,
  prompts, sampling/elicitation, OAuth e mTLS restano fuori da questa tranche.
- Un risultato arrivato dopo annullamento rimane conservato e visibile come stato
  esterno, ma non viene consegnato automaticamente né reinserito nel run annullato.
- Esiti incerti richiedono riconciliazione; non c'è exactly-once distribuito né
  promessa che un server non cambi comportamento dopo aver dichiarato uno schema.

H01/H07/H36/H40 avanzano ma restano parziali. Tutte le altre righe della matrice
rimangono nell'obiettivo; questa prova non equivale alla parità completa.
Nessun push, deployment o aggiornamento dell'app installata.
