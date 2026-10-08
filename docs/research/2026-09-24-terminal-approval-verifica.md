# Terminale nativo: consenso e ripresa applicativa

Seconda tranche H09/H10. Il backend ora è raggiungibile tramite proposte e API
Homun autenticate; nessun server MCP intermedio e nessun runtime Hermes.

## Comportamento verificato

La proposta persistente espone comando, immagine fissata, versione lavoro e
policy offline. Non avvia Docker. Il digest lega l'approvazione alla proposta
esatta; soltanto una persona proprietaria o revisore del lavoro può approvare.
Modifiche del lavoro o archiviazione impediscono un nuovo avvio. Il job usa una
directory derivata dal contesto del motore e dal lavoro: il client non può
scegliere mount host, rete o variabili ambiente.

Lo stato `dispatching` viene salvato prima dell'IO. Ripetere l'approvazione non
ripete l'avvio, nemmeno dopo un crash. Refresh usa solo inspect e log: può
riconciliare un container avviato prima del crash senza creare un nuovo job.
Lo stop richiede autorità di proprietario/revisore e si applica al processo già
ritrovato; un avvio non ancora verificato richiede prima refresh. Il risultato
viene salvato anche se l'accesso è revocato durante l'IO, ma non viene restituito
all'attore revocato. Epoch di osservazione impediscono che una risposta precedente
sovrascriva una richiesta successiva.

I log sono una coda limitata e la risposta ne dichiara il perimetro. Un errore
log non rende ignoto uno stato di processo verificato; un errore di ispezione
invece espone `outcome_unknown`, non successo. Nessun ritentativo automatico
esegue un effetto una seconda volta.

API sotto `/v1/workspaces/{workspace_id}/works/{work_id}/terminal-jobs`:
proposta POST, elenco GET, e POST `/{proposal_id}/approve`, `/refresh`, `/stop`.
Contratti request/response tipizzati ed esportati nello snapshot OpenAPI.

## Evidenza

- 10 test applicativi/API e 17 del backend: consenso, versione, proprietario,
  bot non autorizzato ad approvare, collisioni ID, crash, ripresa, arresto,
  esito incerto, errore log, revoca durante IO e sessione autenticata.
- Docker reale più SQLite chiuso e riaperto, su immagine Debian già presente:
  proposta inerte, comando approvato, uscita 7, log recuperati e file scritto una
  sola volta dopo riapprovazione. [Evidenza](evidence/2026-09-23-hermes-parity/terminal_approval_docker.json).
  Non è una prova modello/chat/UI. Fixture: `tools/verification/terminal_approval.py`,
  con `PYTHONPATH=engine/src`, Python del motore, `--image <SHA256 locale>` e
  `--output <JSON>`. Nessun download immagine o pulizia di container altrui.
- Revisione indipendente: nessun problema critico/importante rilevato; 27 test
  mirati passati anche nel controllo del revisore.
- Suite completa motore: 918 passati, 1 saltato; snapshot OpenAPI coerente.
- Architettura: 0 errori, 35 avvisi di dimensione preesistenti.

## Seguito necessario

Il registro del modello e la UI non espongono ancora queste operazioni. Restano
configurazione immagine e consenso leggibile, legame del job con la chiamata
canonica dell'agente, ritorno dell'esito al modello, limiti temporali/watchdog,
artifact/file, PTY/stdin, notifiche e altri backend. L'approvazione qui è umana
via API; non esiste ancora autonomia concessa all'agente per il terminale.
Nessun rilascio o aggiornamento dell'app installata. Parità H01–H46 aperta.
