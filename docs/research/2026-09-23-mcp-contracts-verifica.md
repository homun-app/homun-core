# Contratti MCP verificati prima della chiamata

## Risultato

Le proposte di strumenti esterni scoprono ora il descrittore reale fuori dalla
transazione SQLite. Lo strumento deve comparire una sola volta e gli argomenti
devono rispettare il suo JSON Schema, senza coercizioni. Lo schema deve usare un
dialetto supportato e non richiedere riferimenti esterni: nessuna risoluzione di
URL durante la validazione. Errori restituiti senza valori privati degli argomenti.

Il descrittore completo viene conservato privatamente e incluso nel digest
approvato. La descrizione è visibile nella proposta; le annotazioni MCP non
concedono autorità. Una modifica alla configurazione durante la discovery
invalida la preparazione. Un replay dello stesso comando restituisce la proposta
precedente senza nuova discovery; creare una proposta nuova su un contratto
cambiato invalida quella precedente ancora ineseguita.

Prima di `tools/call`, nella stessa sessione MCP, Homun riscopre e confronta il
descrittore completo, poi rivalida gli argomenti. Contratto mutato, tool mancante
o ambiguo e guasti prima dell'invio diventano un blocco noto senza chiamata.
Un timeout dopo l'ingresso in `session.call_tool` resta invece un esito incerto;
non viene ritentato. Il confine è conservativo: anche un errore interno all'SDK
prima dell'effettiva scrittura sul socket, dopo quel punto, resta incerto.

JSON Schema e referencing sono ora dipendenze dirette con le versioni già
presenti nel lockfile; nessun aggiornamento delle versioni transitive.

## Evidenza

`test_mcp_contracts.py` copre schema e tipi, valori privati negli errori, tool
mancanti/duplicati, riferimenti remoti, descrizione modificata, configurazione
mutata durante discovery, replay senza IO e blocco preflight distinto da
incertezza. La fixture stdio registra le richieste reali: discovery precede la
chiamata valida (una sola); descrizione cambiata produce **zero tools/call**.

La revisione indipendente ha rilevato che timeout in initialize/tools/list erano
classificati come incerti. Tre regressioni coprono la correzione, distinguendoli
dal timeout di tools/call. La suite mirata di contratti, protocollo, ricevute,
consegna e strumenti supervisionati conta **52 test passati**.

Riferimento esaminato: `tools/mcp_tool_schema.py` nello snapshot Hermes già fissato
dalla matrice. Questo passaggio mantiene i descrittori del protocollo nel motore
Homun; non incorpora Hermes né normalizza silenziosamente lo schema approvato.

Verifica finale: **791 test engine passati, 1 saltato**; **216 test web passati**,
typecheck e build riusciti, OpenAPI allineato, architettura 0 errori (35 avvisi
dimensionali preesistenti). Dipendenze installate compatibili; lockfile invariato
nelle versioni. Revisione finale della classificazione preflight senza rilievi.

## Limiti

Il server può cambiare comportamento dopo la discovery: questo controllo non è
un'attestazione del suo codice né una transazione distribuita. I riferimenti JSON
Schema remoti non sono supportati. Le proposte precedenti prive di descrittore
richiedono nuova approvazione; il consenso non viene ricostruito retroattivamente.

Il collegamento degli strumenti MCP al registro del ciclo agente resta aperto:
selezione autorizzata, esposizione al modello, proposta di azione e ripresa con
ricevuta sono il prossimo percorso da integrare. Non c'è ancora parità completa
H07/H36/H40, né delle altre righe della matrice. Nessun push o deployment.
