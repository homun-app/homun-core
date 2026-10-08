# Modifiche file del run: ricerca, patch e approvazione

Seconda tranche H11. I run nuovi con terminale usano `_workspace_files_version=2`.
I run già salvati restano alla versione 1 e non ricevono gli strumenti nuovi.
La directory resta quella del run; non è il filesystem host.

## Contratto

L'elenco versione 2 è ordinato e continua con `next_cursor`. Oltre 5000 voci il
risultato è `scan_limited`: non è una pagina che si può completare. La lettura
per caratteri della versione 1 resta. `read_workspace_lines` pagina per righe,
al massimo 6000 caratteri visibili al modello, e registra la copertura usata
prima di una scrittura. PDF e DOCX restituiscono il testo estratto, oppure uno
stato esplicito se l'estrazione manca o fallisce. I documenti con DTD sono rifiutati.
XLSX, immagini e database non vengono trascritti.

`search_workspace_files` cerca testo con un'espressione regolare o nomi con un
glob. Salta symlink, hardlink e file non regolari. Un risultato troncato non è
completo.

`write_workspace_file` rifiuta una sostituzione integrale se il file esiste e
questa esecuzione non ne ha letto tutto il contenuto attuale. `patch_workspace_file`
rifiuta hash diversi da quello letto. La catena di corrispondenza, derivata da
Hermes `tools/fuzzy_match.py`, prova prima il testo esatto e poi variazioni di
spazi, indentazione e Unicode; un match ambiguo non scrive. JSON e TOML non
validi non vengono proposti. Python riporta solo gli errori di sintassi nuovi.
Non c'è un language server: il campo `lsp` vale `unavailable`.

La proposta conserva i byte approvati in un blob immutabile. Il file cambia
solo dopo l'approvazione esatta. Se nel frattempo è cambiato, l'esito è
`conflict` e non si riscrive. Se i byte approvati sono già presenti, la ripresa
non esegue una seconda scrittura. Un esito non verificabile resta
`outcome_unknown`. Annullare il run prima dell'approvazione impedisce la scrittura.

## Prove

- Motore: 964 passati, 1 saltato. Inclusi i test di paginazione, ricerca,
  rifiuto di sovrascrittura non letta, patch approvata una sola volta, conflitto
  concorrente, annullamento e ripresa senza seconda scrittura.
- Architettura: 0 errori, 35 avvisi dimensionali preesistenti.
- Web: typecheck passato; 226 test, compresi diff e digest della proposta.
- OpenAPI allineato alle route `file-edits`.
- Ollama `qwen3.5:4b`, profilo temporaneo, nessun container avviato. Sequenza
  reale: ricerca, lettura righe, patch ferma fino all'approvazione, scrittura
  unica di `return 7`, consegna con gli stessi byte.
  Evidenza: [agent_edits_ollama.json](evidence/2026-09-23-hermes-parity/agent_edits_ollama.json).

## Ancora aperti in H11

Language server, patch V4A multi-file, linter esterni, estrazione XLSX/SQLite e
OCR. La sessione browser dell'app installata non è stata ripetuta: il pannello
è verificato dal renderer dei componenti, come il consenso del terminale.
