# File del run: lettura e consegna immutabile

Prima tranche H11 collegata al terminale nativo. Nuovi run con terminale ricevono
un manifest fissato con `list_workspace_files`, `read_workspace_file` e
`deliver_workspace_file`. Run precedenti non acquisiscono automaticamente strumenti.
La directory è quella del run approvato, non il filesystem host.

## Contratto implementato

Lettura ancorata a file descriptor di directory, percorsi relativi, nessun
symlink/intermedio o hardlink, soli file regolari; FIFO aperti in modalità non
bloccante e rifiutati prima della lettura. Limite 25 MiB, stat prima/dopo e hash
sui byte completi. Modifiche durante la lettura o prima della consegna diventano
un errore recuperabile dal modello. L'elenco dichiara l'eventuale incompletezza;
la lettura UTF8 è paginata in caratteri, mentre i binari restituiscono dimensione
e hash senza inventare una rappresentazione testuale.

La consegna richiede SHA256 atteso. Riusa il lock e il blob store immutabile dei
materiali e registra una receipt `work.output` con work, run, chiamata, percorso
sorgente, hash e dimensione. I riferimenti sono inclusi nel recovery dei materiali,
quindi la pulizia non cancella i file consegnati. Una ripresa della stessa chiamata
recupera la receipt salvata anche se il file originale nel frattempo è cambiato.
Autorità, lease ed epoch sono verificate prima e dopo la lettura, prima di salvare.

API autenticate `/works/{work_id}/outputs` e `/{output_id}/download`, con permessi
del lavoro, verifica integrità e ricontrollo accesso dopo lettura. Il download è
un attachment `application/octet-stream`, con `nosniff`, `no-store` e hash negli
header. Non viene eseguito o visualizzato inline. Nessun percorso di archivio
interno è esposto.

UI “File prodotti” nel dettaglio lavoro: filename, dimensione, download e
provenienza. Sono copie da verificare, non allegati automaticamente approvati
con la review testuale. Non sono caricamenti impliciti nella libreria Materiali
né invii esterni. La fonte resta motore, senza fallback a simulazione.

## Prove

- 16 test file/output: traversal, symlink, FIFO, hardlink, dimensioni e mutazione,
  lista incompleta, lettura nativa paginata e binaria, copia immutabile dopo modifica
  e recovery, crash fra snapshot e cronologia canonica, revoca durante lettura,
  API autenticata, download attachment e corruzione hash.
- Due test web di rendering/trasporto: provenienza e stato non approvato visibili,
  download binario tramite trasporto autenticato. Typecheck riuscito dopo aver
  corretto il raggruppamento JSX del nuovo pannello.
- Revisione indipendente senza blocchi; i 16 test mirati passano anche nel controllo
  del revisore.
- Prova reale con `qwen3.5:4b` locale e Docker Debian già presente: comando esatto
  approvato, lettura del file e consegna usando l'hash ottenuto dal tool, artifact
  finale. File `result.txt`, 14 byte, contenuto `HOMUN_FILE_OK` con newline.
  Modifica dell'originale, recovery materiali e riapertura SQLite non modificano
  il download. [Evidenza](evidence/2026-09-23-hermes-parity/agent_files_ollama.json).
  Fixture `tools/verification/agent_files.py`, Python motore, `PYTHONPATH=engine/src`,
  `--image <SHA256 locale> --output <JSON>`. Il codice della fixture approva solo
  l'esatto comando previsto. Non è una prova del click umano in browser.

Suite completa: 952 test motore passati, 1 saltato; 224 test web passati; build
web riuscita con gli avvisi preesistenti sui chunk. Architettura: 0 errori e
35 avvisi dimensionali; snapshot OpenAPI coerente.

## Ancora aperto

H11 resta parziale: ricerca nei file del workspace, scritture/patch controllate,
LSP e diagnostica, estrazione documentale e scansioni/paginazioni complete di grandi
cartelle. Hermes `tools/file_tools.py` e `tools/file_operations.py` del riferimento
fissato usano anche paginazione per righe, budget di caratteri e riconoscimento
binario per tipo: questa prima lettura Homun usa offset in caratteri, come i suoi
material tools, e non certifica equivalenza dell’intero contratto upstream.
I file modificabili possono ancora essere creati con comandi approvati.
Restano quota/retention delle consegne, legame esplicito della review ai file,
integrazione nella libreria Documenti e importazione Materiali. Snapshot ≤25 MiB;
nessuna attestazione di sicurezza del contenuto generato. Nessun aggiornamento
dell'app installata, push o deploy; parità complessiva H01–H46 ancora aperta.
