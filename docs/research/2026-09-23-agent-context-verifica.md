# Contesto persistente del ciclo nativo — 23 settembre 2026

Homun conserva la cronologia canonica e prepara una proiezione più corta per il
modello quando il limite configurato si avvicina. Questo è un avanzamento parziale
H05 della [matrice Hermes](2026-09-23-hermes-parity-matrix.md), non parità completa.

## Implementazione e provenienza

Estimatore ASCII/UTF-8/CJK e regole del riepilogo derivano da
`agent/model_metadata.py` e `agent/context_compressor.py` del riferimento Hermes
`c9dca726514b709cf6e677d236a79fc8d0627f37`, con attribuzione e testo MIT in
`engine/src/homun/notices/hermes-agent.txt`. Nessuna dipendenza runtime Hermes.

Il pianificatore puro `models/context_plan.py` conserva sistema, obiettivo iniziale,
ultima sequenza di correzioni e gruppi recenti completi di chiamate/risultati.
Il checkpoint separato contiene hash SHA256 del prefisso canonico, copertura e
stime prima/dopo; la proiezione non cancella i messaggi originali. Tagli del testo
fornito al riepilogatore sono espliciti nella copertura, mai dichiarati lettura
integrale. Il riepilogo è memoria storica, non una nuova istruzione di sistema.

Le nuove proposte native fissano `context_window` e `max_output_tokens`. Per Ollama
locale Homun richiede esplicitamente 16384 token se non configurato altrimenti;
per cloud senza configurazione il limite resta sconosciuto. Non si deduce la
capacità effettiva dal nome del modello. I run precedenti conservano il contratto
legacy. Le connessioni possono essere configurate tramite POST `/v1/models/connections`;
l'omissione dei limiti mantiene quelli salvati, `context_window: null` rimuove il pin.

La chiamata di riepilogo non offre strumenti; il suo consumo è contabilizzato
separatamente dalla decisione successiva. Stime di contesto e consumo fatturato
rimangono distinti. Cronologia e checkpoint precedente restano disponibili se
il riepilogo fallisce, è vuoto, troncato o non riduce abbastanza il contesto.
Epoch, lease e correzioni ricevute proteggono sia la pubblicazione del checkpoint
sia la transizione terminale: una risposta superata non fa fallire il nuovo turno.

## Verifiche automatiche

- Suite completa finale: **688 passati, 1 saltato**, un avviso di deprecazione
  Starlette/AnyIO. La verifica comprende la correzione finale della concorrenza.
- Test dedicati: pianificazione, hash, confini degli strumenti, limiti/pin,
  trasporto senza strumenti, input malformati, riavvio del contesto di processo,
  budget e consumi separati, steering/redirect/pausa/annullamento durante riepilogo.
- La regressione del risultato superato è stata osservata rossa e poi verde;
  anche la correzione arrivata durante la validazione del candidato è coperta.
- Revisione indipendente: nessun rilievo residuo sulla compattazione; segnalato e
  corretto il ritorno non conforme di `_claim` per epoch superato.
- Typecheck passato, OpenAPI rigenerato, architettura: **0 errori, 35 avvisi**
  preesistenti sulle dimensioni. Nessuna UI nuova o build desktop in questa tranche.

## Prova Ollama reale

[Esecutore riproducibile](evidence/2026-09-23-hermes-parity/context_ollama.py),
[traccia](evidence/2026-09-23-hermes-parity/context_ollama.json).

Fixture ibrida dichiarata: le sei scelte iniziali di lettura sono programmate,
ma le letture attraversano gli strumenti e le autorizzazioni reali. Riepilogo e
risposta finale usano davvero Ollama `qwen3.5:4b`, senza mock. La prova dimostra
compattazione e prosecuzione, non pianificazione autonoma di un lavoro lungo.

- Prima prova: output massimo512; Ollama termina con `done_reason=length`.
  Il motore rifiuta correttamente il riepilogo incompleto. Conservate
  [evidenza iniziale](evidence/2026-09-23-hermes-parity/context_ollama_initial_failure.json)
  e [diagnostica provider](evidence/2026-09-23-hermes-parity/context_ollama_failure_diagnostic.json).
- Prova riuscita: finestra12288, output massimo1536; riepilogo massimo1228.
  Stima richiesta **10780 → 6600**, nessun taglio del testo di riepilogo.
- Uso effettivo: riepilogo **3869 input / 666 output**; risposta finale
  **5681 input / 178 output**. Esattamente due registrazioni.
- Cronologia canonica conservata; artifact in revisione con tutti i sei codici,
  responsabili e date corretti. Nessuna fonte reale aziendale usata.

## Limiti aperti

Non ancora presenti micro-compattazione, flush di memoria prima del taglio,
compressione manuale, semantiche complete di cache e provider ausiliari,
recupero automatico da overflow/troncamento. Un limite di output troppo basso può
far terminare il lavoro con errore esplicito; non viene ampliato silenziosamente.
Le stime non sono un tokenizer esatto: il provider resta l'autorità sul limite
reale. Copertura generalista di shell/web/browser, skill, memoria e integrazioni
rimane aperta nella matrice. L'app installata e il remoto non sono aggiornati.
