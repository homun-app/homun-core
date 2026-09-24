# Scadenze persistenti del terminale

Nuove proposte terminale: durata 1–3600 secondi, predefinita 300. La durata è
inclusa nel digest del consenso ed è visibile nel pannello prima dell'approvazione.
Il modello può proporla con il contratto terminale v2. Contratto v1 e proposte
precedenti senza durata conservano compatibilità, digest e assenza di limite
retroattivo. L'approvazione fissa una scadenza UTC: la riapprovazione non la sposta.
Il tempo comprende l'avvio del container, non soltanto la sua esecuzione utile.

Il watchdog del motore ispeziona i job scaduti già approvati, indipendentemente
dallo stato dell'agente e dai permessi attuali del suo attore. Non può lanciare
comandi: può solo recuperare lo stato e fermare il container con proprietà e
contratto verificati. Il controllo è invocato dalla consegna periodica del motore,
anche senza DBOS avviato. I tentativi sono limitati a quattro job per passaggio,
ordinati per controllo meno recente; un job non raggiungibile non affama gli altri.

Il motivo dell'arresto è salvato prima dell'IO. Errori lasciano un esito incerto
ritentabile mediante ispezione. Una risposta precedente non sovrascrive una
osservazione successiva; se nel frattempo il processo è stato osservato terminato,
il watchdog non lo arresta né marca erroneamente timeout. Processi terminati
prima del controllo non sono marcati come scaduti. La receipt nativa contiene
`timed_out` e considera errore il superamento anche con exit code zero.

## Evidenze

- 10 test di scadenza: arresto, nessun intervento anticipato o senza approvazione,
  uscita spontanea, durata nel consenso, deadline immutabile, legacy, riavvio e
  revoca, stop incerto, contratto v1, equità e osservazione concorrente.
- Test aggiuntivo del ciclo agente: scadenza e arresto con exit zero restano un
  errore esplicito per il modello. Test UI: durata e significato del timeout visibili.
- Prova reale su Docker locale e orologio reale, durata 2 secondi, database chiuso
  e riaperto prima della scadenza: container terminato con exit 143, `timed_out=true`,
  file scritto una sola volta anche dopo ulteriore controllo e riapprovazione.
  [Evidenza](evidence/2026-09-23-hermes-parity/terminal_deadline_docker.json).
  Fixture `tools/verification/terminal_deadline.py`, con `PYTHONPATH=engine/src`,
  Python motore, `--image <SHA256 locale> --output <JSON>`.
- Revisione indipendente senza blocchi; aggiunti i casi suggeriti per più job
  del lotto e sovrapposizione con refresh. Typecheck e due test UI riusciti.
- Suite completa motore: 936 passati, 1 saltato.
- Architettura: 0 errori, 35 avvisi di dimensione preesistenti; OpenAPI aggiornato.

## Limiti del contratto

Il watchdog opera quando il motore Homun è acceso e il dispatcher può avanzare.
**Non è un timer autonomo del daemon Docker**: con motore spento, un processo può
superare la scadenza fino alla riapertura. I tempi di polling e la grazia dello
stop aggiungono latenza; non è un limite real-time. La UI espone questo perimetro.
La persistenza permette di recuperare una scadenza trascorsa, non di eseguire
codice quando Homun è spento. Un'autorità host ostile non rientra nel contratto.

La prova non certifica app installata né interazione completa in browser. Restano
file/artifact, PTY/stdin, background non bloccante per il modello, altri backend,
timer indipendente e il resto della matrice H01–H46. Nessun push o distribuzione.
