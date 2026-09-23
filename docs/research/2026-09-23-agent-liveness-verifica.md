# Recupero delle risposte che promettono ancora un'azione

H06 resta parziale. Nei nuovi run nativi, una risposta breve (massimo 400
caratteri) che termina con una stretta forma di intenzione futura viene trattata
come intermedia. Homun conserva il testo canonico e aggiunge un invito a
completare il lavoro, entro gli strumenti e le autorizzazioni esistenti.
Massimo due inviti, persistenti anche dopo riavvio; ulteriore stallo produce
`agent_model_stalled`, senza artifact. Nessun nuovo budget o output cap.

Il controllo adatta `trailing_continue_intent` e il recupero di
`turn_final_response.py` di Hermes c9dca726. Alle forme inglesi sono aggiunte
quelle italiane osservate (`ora/adesso posso`, `procedo a`, `vado a`). Non è
routing per dominio o classificazione del lavoro. Citazioni con delimitatori,
code span e righe Markdown di citazione sono escluse conservativamente.

Il controllo avviene nella transazione di pubblicazione, dopo autorità e lease.
Una correzione umana ha precedenza; steering/redirect azzerano il conteggio
precedente. I consumi della generazione sono già addebitati. I run precedenti
restano invariati grazie al marker `_liveness_version` nel digest approvato.

## Evidenze

- RED iniziale: tre promesse pubblicate come artifact e limite non persistente.
- **885 test engine passati, 1 saltato**. Dopo la correzione finale, **64 controlli
  mirati passati**, inclusi tutti i **20 test liveness** e le regressioni dei
  controlli/continuazioni.
- Test di errore terminale al terzo stallo senza artifact, riavvio, legacy,
  consumo noto di tutti i tentativi, strumenti dopo invito, correzione durante
  generazione e reset dopo due inviti precedenti.
- Revisione indipendente: falso positivo su traduzioni/citazioni riprodotto e
  corretto. Seconda verifica: 20 test passati, nessun ulteriore rilievo.
- Architettura 0 errori, 35 avvisi dimensionali preesistenti; OpenAPI invariato.
- [Prova reale Ollama + stdio](evidence/2026-09-23-hermes-parity/agent_liveness_ollama.json):
  ricerca → descrizione → approvazione → chiamata MCP → risposta che annuncia
  ancora la preparazione → un invito automatico → nota italiana completa.
  Un solo effetto esterno e un artifact con OR-93, Marta e 8 ottobre 2026.
  Il recupero si è attivato sulla risposta reale, non su testo iniettato.
  Consenso umano simulato programmaticamente; riapertura SQLite dopo ricevuta
  come nella fixture MCP. Modello: `qwen3.5:4b` locale.
  Riproduzione: `agent_mcp_ollama.py <output.json> --bridge` con PYTHONPATH=engine/src;
  la formulazione prodotta dal modello può cambiare tra esecuzioni.

## Limiti

Non valuta semanticamente se ogni requisito dell'utente è soddisfatto. Non copre
tutte le lingue, gli acknowledgement generici, i frammenti degenerati, risposte
lunghe o altri stalli. L'euristica può ancora avere falsi positivi/negativi;
escludere i finali tra virgolette favorisce la conservazione delle citazioni.
Richieste di capability o formulazioni ambigue possono richiedere riformulazione.
Restano revisione umana e budget del run. Nessuna parità completa H06/H01–H46.
Notice MIT aggiornata, motore Homun senza dipendenza runtime Hermes.
