# Recupero da contesto eccessivo — 23 settembre 2026

Homun ora può recuperare un rifiuto di contesto eccessivo del provider compattando
la richiesta prima di ritentare. La capacità estende H05/H06 della
[matrice Hermes](2026-09-23-hermes-parity-matrix.md), che resta parziale.

## Comportamento e provenienza

`application/agent_overflow.py` adatta la logica di `agent/turn_overflow.py`
del commit Hermes `c9dca726514b709cf6e677d236a79fc8d0627f37`, con attribuzione MIT
nel notice del motore. Il pianificatore del contesto ha una modalità forzata:
un rifiuto reale del provider prevale sulla stima locale anche quando questa è
sotto la soglia ordinaria. Il checkpoint deve ridurre la richiesta stimata di
oltre5%, mantenendo sistema, obiettivo, correzioni recenti e gruppi di tool integri.

L'intento di compattazione è persistente e protetto da epoch, lease e steering.
Non cancella la cronologia originale e non ritenta la stessa richiesta senza
modificarla. Sono ammessi al massimo due recuperi per decisione non accettata,
sempre entro tre tentativi della fase decisionale e il budget globale. Prima di
spendere il riepilogo si verifica che resti un tentativo per proseguire.
I controlli dell'utente invalidano gli intenti superati. Il marker si rimuove
solo dopo un checkpoint valido; la decisione accettata chiude il proprio ciclo.

Nessuna capacità del modello viene indovinata: serve una finestra configurata.
L'output massimo non viene ampliato. Se non esiste un prefisso comprimibile,
il motore termina prima di una richiesta identica. Un overflow del riepilogatore
non avvia un recupero ricorsivo.

## Evidenza con provider reale e errore iniettato

Il comando riproducibile usa [la fixture condivisa](evidence/2026-09-23-hermes-parity/context_ollama.py)
con argomento `--overflow`; [traccia salvata](evidence/2026-09-23-hermes-parity/overflow_ollama.json).

La prima richiesta incontra HTTP400 `context_length_exceeded` da un server locale
di test: il rifiuto è intenzionalmente iniettato, non un errore spontaneo di Ollama.
Le letture iniziali sono scelte dalla fixture e passano dagli strumenti autorizzati.
Riepilogo e risposta finale usano realmente Ollama `qwen3.5:4b`, senza risposte mock.

- Finestra32768, output massimo1536: la richiesta iniziale non attiva la soglia
  ordinaria, quindi il checkpoint dimostra il percorso forzato dopo il rifiuto.
- Stati `running → completed`, lavoro in revisione, tre tentativi totali.
- Contesto stimato **10780 → 5182**, cronologia originale invariata.
- Riepilogo reale **5098 input / 1116 output**; finale **4955 input / 178 output**.
- Artifact con tutti e sei i codici, responsabili e date corretti.

Questa prova certifica il percorso errore→compattazione→prosecuzione, non la
pianificazione autonoma delle sei letture né una copertura di tutti i provider.

## Test e limiti

Regressioni: intento ripreso da un nuovo contesto di processo, nessun taglio sicuro,
finestra sconosciuta, steering concorrente, overflow ripetuto e numero massimo di
recuperi, assenza di ricorsione nel riepilogo, budget globale e decisionale esaurito.
Revisione indipendente conclusa senza rilievi residui dopo la correzione della
compattazione inutile quando non restava un tentativo decisionale.

Restano fuori da questa tranche: correzione specifica dei limiti di output,
continuazione del testo troncato, riduzione di immagini/payload413, tokenizer
esatti, modelli ausiliari, fallback e refresh credenziali. Il recupero può fallire
esplicitamente se le istruzioni protette o i risultati recenti non sono comprimibili.
App installata e remoto non aggiornati.

Verifica finale: **729 test engine passati, 1 saltato**, un avviso di deprecazione
Starlette/AnyIO; OpenAPI allineato; architettura 0 errori / 35 avvisi preesistenti.
Nessuna modifica UI in questa tranche; la precedente includeva 216 test web,
typecheck e build passati.
