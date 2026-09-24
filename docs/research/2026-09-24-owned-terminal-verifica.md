# Terminale Homun: backend Docker proprio

Prima tranche H09/H10, verificata il 24 settembre 2026. Il backend è implementato
in Homun e non dipende dal runtime Hermes. Non è ancora uno strumento disponibile
alla chat: approvazioni applicative, registro agente, API e UI sono la prossima
integrazione, non una capacità attestata da questo rapporto.

## Contratto implementato

`engine/src/homun/execution/` contiene contratto immutabile, trasporto CLI con
output limitato e gestione del ciclo di vita dei container. L'identità comprende
workspace, run e chiamata; un intento esclusivo persistito prima dell'IO impedisce
la seconda esecuzione dopo timeout, ricreazione del backend o rimozione del
container. Un esito incerto resta tale: non viene interpretato come permesso di
riprovare. Il marcatore incompleto dopo un crash impedisce un nuovo avvio.

Immagine fissata tramite SHA256, nessun pull implicito o rete, directory dedicata
per run, limiti CPU/memoria/PID, capability rimosse e no-new-privileges. Non vengono
montati home o socket Docker né inoltrate variabili dell'ambiente host al job.
I percorsi devono essere sotto una radice privata controllata dal motore, priva
di symlink; non costituisce una difesa da un amministratore host ostile. Docker
deve essere locale: un daemon remoto non garantisce la stessa directory montata.

Log, arresto e rimozione verificano proprietà e contratto, quindi usano l'ID esatto
del container. I log dichiarano di essere la coda di massimo 1000 righe, con
ulteriore limite di byte e segnale di troncamento. Le directory e gli intenti
sopravvivono alla rimozione: gli artifact non vengono cancellati implicitamente.

## Prove

- 17 test mirati: recupero, replay di processi terminati, timeout prima/dopo effetto,
  daemon indisponibile, intento incompleto, avvio concorrente, proprietà,
  symlink, directory radice differente, immagine fissata, uscita/log e limiti del trasporto.
- Suite completa: 907 passati, 1 saltato prima dell’ultimo vincolo di directory;
  dopo quella modifica, ripetuti con successo i 17 test mirati e la prova Docker reale.
- Prova reale su Docker 29.4.3 con immagine Debian già in cache:
  `sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132`.
  Scrittura file una sola volta, stdout leggibile, exit 7 preservato, nuovo backend
  che ritrova il job senza ripeterlo, processo in background arrestabile senza
  modificare il precedente, rimozione che non consente redispatch. Pulizia dei soli
  container della fixture. [Evidenza JSON](evidence/2026-09-23-hermes-parity/owned_terminal_docker.json).
- Fixture riproducibile: `tools/verification/owned_terminal.py`, con `PYTHONPATH=engine/src`,
  Python del motore e argomenti `--image <ID in cache> --output <file JSON>`.
- Revisione indipendente senza blocchi critici/importanti; aggiunta la copertura
  suggerita per concorrenza e accesso a log/rimozione di container altrui.
- Architettura: 0 errori, 35 avvisi di dimensione preesistenti, con Python 3.13 del
  motore. Il Python di sistema non interpreta un f-string preesistente in
  `models/interpret.py`; quella prima esecuzione del controllo non è una verifica valida.

## Parità ancora aperta

Non sono verificati modello→approvazione→terminale→artifact né funzionamento dalla
app installata. Mancano integrazione con budget/autorità del lavoro, watchdog e
scadenza del processo, notifiche di completamento, PTY/stdin, strumenti file,
configurazione approvata di rete/immagini e gli altri backend Hermes. Il backend
non ammette rete e non scarica immagini; la selezione e la fiducia nell'immagine
restano responsabilità del futuro livello applicativo. Il trasporto CLI ha un
timeout, non una scadenza automatica del job Docker.

H09 e H10 sono **parziali** soltanto per questo backend; la parità completa H01–H46
resta l'obiettivo. Nessun push, distribuzione o aggiornamento dell'app installata.
