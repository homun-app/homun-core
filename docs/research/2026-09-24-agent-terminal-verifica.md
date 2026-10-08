# Terminale nativo nel ciclo agente

H09/H10 restano parziali, ma ora esiste un percorso modello → proposta comando →
consenso → Docker → receipt → modello → artifact. Homun mantiene motore e
persistenza propri; nessuna dipendenza runtime Hermes.

## Contratto

`terminal_image` è opzionale nella proposta del run. Fissa un ID SHA256 e abilita
`terminal_execute` nel manifest nativo approvato. Run precedenti o privi di questa
opzione non acquisiscono lo strumento. Il modello sceglie il comando, non
l'immagine, il mount o la rete. L'abilitazione del run consente soltanto proposte:
ogni comando richiede consenso umano separato.

La proposta terminale è legata a run/epoch/lease/call ID e al comando canonico;
il consenso rivalida autorità, versione, immagine e chiamata ancora attesa. Il
job usa la directory del run. Il runtime gestisce l'attesa con un riferimento
terminale distinto da MCP, riconcilia il container senza avviarlo e riprende
soltanto con stato finale e log disponibili. Una indisponibilità temporanea dei
log conserva l'attesa; una revisione indipendente ha individuato e fatto coprire
questo caso. La receipt entra una sola volta nella cronologia, conservando call
ID, uscita nonzero, errore e informazioni sulla coda/troncamento.

Annullare prima del consenso impedisce l'avvio. Annullare durante l'IO registra
esito incerto nella chiamata interrotta, conserva il job e impedisce la consegna.
L'arresto del processo resta un comando esplicito separato. La UI lo dichiara e
mantiene il pulsante di arresto per il job collegato al run annullato.

## Interfaccia e prove

Nel pannello di esecuzione è presente una configurazione terminale opzionale
avanzata (ID immagine già presente in Docker locale); consenso separato con
comando esatto e ambiente, stato/log e arresto. Il caricamento della proposta
non approva automaticamente. Errori di lettura eliminano il contenuto precedente.
TypeScript verificato e build web riuscita. Due test di rendering/trasporto
verificano consenso, annullamento, uscita nonzero, coda log e richieste HTTP;
12 test web mirati includono regressioni del client agente e consenso MCP;
suite web completa: 222 test passati.
Non è stata svolta in questa tranche una sessione interattiva completa in browser
o nell'app installata; l'ergonomia della configurazione immagine richiede lavoro.

7 test specifici del collegamento agente verificano consenso separato,
annullamento prima/durante IO, riapertura SQLite e receipt singola, assenza dello
strumento senza opt-in, consegna runtime e recupero log transitorio. I test adiacenti
coprono ulteriormente backend, API e MCP.

Prova reale con Ollama locale `qwen3.5:4b` e Docker Debian già in cache: il modello
ha proposto il comando atteso, nessun file prima del consenso, file scritto una
sola volta, database chiuso e riaperto, receipt singola e artifact finale con
stdout `HOMUN_TERMINAL_OK` ed exit 0. [Evidenza](evidence/2026-09-23-hermes-parity/agent_terminal_ollama.json).
Fixture `tools/verification/agent_terminal.py`, Python motore, `PYTHONPATH=engine/src`,
`--image <SHA256 locale> --output <JSON>`. Il consenso della fixture è emesso dal
codice di verifica soltanto dopo aver confrontato il comando generato con quello
esatto previsto. Non attesta il click umano in browser.

Il controllo architetturale ha trovato cicli d'importazione nella prima stesura:
contratto puro, validazione binding e coordinamento sono stati separati. Verifica
successiva: 0 errori, 35 avvisi dimensionali preesistenti. OpenAPI coerente.
Suite completa ripetuta dopo la separazione: 925 passati, 1 saltato.

## Ancora aperto

Deadline/watchdog, PTY/stdin, lavoro in background senza bloccare il modello,
file tools e importazione degli artifact prodotti, gestione/cancellazione dei
container, altri backend e configurazione ambiente più semplice. Il runtime
attuale attende il completamento del processo; non dichiarare supporto interattivo
completo o parità Hermes raggiunta. Nessun push, deploy o aggiornamento dell'app.
