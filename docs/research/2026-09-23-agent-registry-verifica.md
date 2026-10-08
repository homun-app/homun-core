# Registro strumenti e trasporto MCP: verifica circoscritta

## Risultato

Registro Homun per esecuzione, derivato dal disegno di `tools/registry.py` di
Hermes al commit di riferimento della matrice, con attribuzione MIT conservata.
Schema, ricerca, validazione e dispatch condividono le stesse registrazioni.
Le nuove proposte includono nel digest un manifest deterministico con hash dello
schema e della definizione completa, versione e politica di replay. Cambiamenti
bloccano l'esecuzione prima dell'IO; i run precedenti conservano il catalogo
precedente senza ricevere automaticamente `tool_search`.

Registrati materiali, consultazione della squadra approvata, chiarimento umano
e ricerca nel catalogo approvato. La ricerca non concede accessi, non esegue
strumenti e non attiva strumenti nascosti. Gli handler conservano i controlli
su fonti, revoche, squadra, lease e budget. Validazione rigorosa senza riportare
valori sensibili negli errori di argomento.

Il client MCP usa il ciclo di sessione dell'SDK: inizializzazione e notifica,
risposte correlate, paginazione limitata, descrittori completi, contenuto
strutturato e non testuale, Streamable HTTP con risposte JSON o SSE. Una risposta
mancante non diventa più un successo vuoto. Timeout complessivo di 10 secondi;
nessun ritentativo automatico delle chiamate. Dipendenze dirette MCP e httpx2
esplicitate, senza aggiornare le versioni già bloccate nel lockfile.

## Prove

- Test del registro: snapshot immutabili, modifica descrizione, deriva manifest,
  tipi rigorosi, errori originali, ricerca senza IO e assenza di valori privati.
- Integrazione: modello → ricerca → lettura → artifact; deriva prima del modello;
  run precedenti; collaboratori non approvati esclusi dai risultati.
- 20 test MCP con veri processi stdio e server HTTP locali JSON/SSE: handshake,
  sessione/header, paginazione, errori correlati, inizializzazione rifiutata,
  risposta assente e timeout. Nessun servizio MCP pubblico usato.
- Prova reale Ollama `qwen3.5:4b`: su richiesta esplicita di cercare prima lo
  strumento, il modello genera `tool_search`, poi `read_material`, poi il finale.
  Tre chiamate reali; codice HX-73Q, responsabile Marta e scadenza 8 ottobre 2026
  corretti nell'artifact con fonte. Nessuna scelta di tool simulata.
  [Script](evidence/2026-09-23-hermes-parity/registry_ollama.py) e
  [traccia](evidence/2026-09-23-hermes-parity/registry_ollama.json).
- Revisione indipendente senza rilievi funzionali; un ciclo di import rilevato
  dal controllo architetturale è stato risolto estraendo i contratti condivisi.

Verifica finale: **759 test engine passati, 1 saltato**; **216 test web passati**;
typecheck e OpenAPI allineati; architettura 0 errori (35 avvisi dimensionali
preesistenti). Dipendenze installate compatibili e lockfile senza cambi di versione.

## Limiti e passo successivo

H07 e H36 sono **parziali**. Non c'è ancora collegamento adattivo dei tool MCP,
attivazione pigra, spill dei risultati, resources/prompts, sampling/elicitation,
OAuth/mTLS o recupero delle sessioni. SSE indica risposte Streamable HTTP,
non il vecchio trasporto HTTP+SSE.

Prima delle chiamate esterne adattive serve un journal durevole: intento prima
dell'IO, ricevuta prima della pubblicazione, ripresa senza ridispatch e stato
incerto dopo interruzioni. L'SDK può validare lo schema dopo la chiamata;
un errore in questa fase non prova che l'effetto esterno non sia avvenuto.
Il percorso `external_tools` preesistente conserva lacune di recupero e binding
delle approvazioni: non attestiamo esecuzione esterna exactly-once.

App installata, push e deployment non modificati. Questo rapporto non attesta
parità completa, che resta definita dalle 46 righe della matrice.
