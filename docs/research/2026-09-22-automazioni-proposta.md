# Proposta di design — Automazioni (lavori ripetibili a motore)

> Stato: **bozza da validare** (nessun codice scritto, come da regola).
> Riferimenti: roadmap «Loop operativo multi-tool»; gap analysis punto 6;
> proposta piano multi-fase (§9–11) di cui questa è la continuazione naturale.

## 1. Il gap, in una frase

Ogni lavoro finisce e muore: per rifarlo bisogna riscrivere tutto in chat.
Manca il **lavoro ripetibile** — «ogni lunedì alle 9 rifai il confronto listini
e portami la sintesi da verificare» — con la supervisione che già governa i
lavori singoli.

## 2. Cosa riusiamo così com'è (non si inventa nulla)

| Pezzo | Dove esiste già | Note |
|---|---|---|
| Scheduler cron persistito | **DBOS** (`create_schedule` / pause / resume / trigger / backfill) nel runtime già adottato | sopravvive ai riavvii; il fuso è per-schedule |
| Il lavoro da ripetere | lavori motore con **fasi** (piani multi-fase §9–11), materiali di progetto, budget | la routine è un *modello* di lavoro, non un nuovo tipo di esecuzione |
| Supervisione | conferma accordo → avvio fase → revisione esito → chiusura con esito | identica per ogni ricorrenza |
| «Il lavoro propone» | annuncio materiali pronti (plan_readiness) | la routine eredita l'attesa esplicita |
| Budget | `WorkBudget` per lavoro | ogni ricorrenza ha il proprio; la routine può avere un tetto mensile |
| Notifica | messaggi onesti in chat + centro notifiche | la scadenza vera (§7b) fa il resto |

**Principio guida invariato**: l'automazione ripete *l'affidamento*, mai
*l'approvazione*. Ogni ricorrenza produce un lavoro che aspetta le stesse
conferme esplicite dell'originale — a meno che la persona abbia dichiarato,
fase per fase, autonomia di consegna (già campo del profilo).

## 3. Il percorso utente (cosa vede, cosa approva, come si arresta)

### 3a. Creare la routine da un lavoro riuscito

Sul pannello di un lavoro **completato** (o su un accordo confermato) compare
«**Rendi ripetibile**». Lo apre una scheda con:

- **cosa** si ripete: titolo, fasi, materiali attesi, responsabile — copiati
  dal lavoro di partenza, modificabili prima di salvare (usa gli stessi editor
  delle fasi, § punto 5);
- **quando**: cadenza in linguaggio naturale («ogni lunedì alle 9»,
  «il primo del mese», «ogni giorno feriale alle 8:30»), tradotta in cron
  con anteprima delle prossime 3 esecuzioni; fuso del territorio;
- **approvazione**: due regimi dichiarati fase per fase, ereditati dal
  profilo/accordo — «ogni ricorrenza aspetta il mio via» (default) oppure
  «avvia da solo, l'esito arriva comunque in revisione».

- **Cosa approva**: un'unica conferma («Crea la routine») che crea il modello
  e la prima ricorrenza pianificata (visibile con data e ora).

### 3b. Ogni ricorrenza è un lavoro vero

All'ora prefissata la routine crea un **nuovo lavoro** con le stesse fasi e
lo stesso responsabile, collegato alla **stessa conversazione della routine**
(non mille chat: la chat della routine è il diario delle ricorrenze, con
separatori «Ricorrenza di lunedì 28 settembre»).

- **Cosa vede**: il messaggio in chat «Ricorrenza pronta: “Confronto listini
  settimanale”. Servono i listini aggiornati nel progetto» (o, in regime
  autonomo, «avviata: l'esito arriverà in revisione»); il lavoro in Compiti
  con la sua scadenza; il conteggio nella vista Oggi.
- **Cosa approva**: esattamente ciò che approverebbe rifacendo il lavoro a
  mano: il via alle fasi (se in regime supervisionato), l'esito in revisione,
  la chiusura. Nessuna esecuzione senza le stesse conferme.

### 3c. Fermare, saltare, modificare

- **Pausa** («Ferma per ora»): la routine si sospende (DBOS pause), le
  ricorrenze già pianificate restano, niente nuove; **Riprendi** le reinnesta.
- **Salta la prossima**: la prossima esecuzione slitta di un ciclo.
- **Modifica**: cambiare fasi/cadenza/autonomia crea una **revisione del
  modello** (versionata come i piani): le ricorrenze future usano la nuova
  versione, quelle passate restano storia.
- **Arresta** («Termina routine», due click): niente nuove ricorrenze; i
  lavori in corso restano e si chiudono per conto loro; la chat resta.

### 3d. Dove vive

Le routine hanno la loro **sezione in Automazioni** (già dichiarata onesta
nelle Impostazioni, che verrà aggiornata): elenco con stato (attiva / in
pausa / prossima esecuzione), ultima ricorrenza, link alla chat. La sidebar
«Automazioni N» conta le attive.

## 4. Modello a motore (cosa serve davvero di nuovo)

1. **`Routine`** (entità dominio): id, nome, `cron` + fuso, modello di lavoro
   (titolo, obiettivo, `plan_steps` come l'intake, materiali attesi,
   responsabile per fase), regime di supervisione per fase, stato
   (active/paused/stopped), `last_run_work_id`, revisione modello.
   Comandi: `routine.create` (da lavoro o da zero), `routine.update`
   (revisione modello/cadenza), `routine.pause/resume/skip_next/stop`.
2. **Workflow DBOS per ricorrenza**: `@DBOS.scheduled`-equivalente creato a
   runtime con `create_schedule`; il workflow è minimo e deterministico:
   crea il lavoro dalla revisione corrente del modello e posta il messaggio
   onesto. Tutta la logica di dominio resta nei comandi transazionali.
3. **Politica di recupero** (app chiusa al momento dello scatto): DBOS
   offrirebbe backfill automatico — **lo teniamo spento**: se la app era
   chiusa, alla riapertura la routine propone **una sola** ricorrenza
   recuperata («lunedì è stato saltato: la preparo ora?»), mai una coda di
   settimane. (default sicuro, dichiarato; backfill esplicito in seguito)
4. **Collegamento routine ↔ lavoro**: campo `origin_routine_id` sul lavoro +
  conversazione dedicata della routine; letture: routine con ultime ricorrenze.

Niente di nuovo per: esecuzione fasi, revisioni, budget, scadenze (già fatte).

## 5. Prima fetta (da validare)

**«Da un lavoro completato a due fasi, una routine settimanale che ogni
settimana crea il lavoro e aspetta il mio via.»**

1. Entità `Routine` + comandi create/pause/resume/stop (niente revisione
   modello né skip nella fetta 1: ferma=stop).
2. Workflow di ricorrenza DBOS: crea lavoro da modello, posta messaggio.
3. UI: «Rendi ripetibile» sul pannello del lavoro completato → scheda
   (cadenza in linguaggio naturale con traduzione cron + anteprima, conferma);
   sezione Automazioni con elenco/pausa/stop.
4. Recupero una-tantum alla riapertura.
5. Test: creazione da modello con fasi/assegnatario corretti; pausa che non
   scatta; messaggio onesto; permessi (solo la persona crea/ferma).

**Fuori dalla fetta 1**: revisione del modello, salta-prossima, regime
autonomo per routine (nella fetta 1 ogni ricorrenza è supervisionata),
budget mensile di routine, routine da zero (senza lavoro di partenza),
bacheca cronologia ricorrenze.

## 6. Casi limite

- **App chiusa a lungo**: nessuna coda; proposta singola di recupero (§4.3).
- **Materiali mancanti alla ricorrenza**: il lavoro nasce e resta in attesa
  con «Cosa serve ora» (eredita plan_readiness); nessuna esecuzione.
- **Fallimento di una fase**: errore tipizzato sul lavoro (come oggi); la
  routine **non** si ferma da sola: alla ricorrenza dopo riparte pulita, ma
  il pannello Automazioni mostra «ultima ricorrenza: non riuscita».
- **Responsabile eliminato**: la creazione della ricorrenza fallisce con
  errore onesto; la routine va in pausa automatica con notifica.
- **Budget esaurito**: la ricorrenza nasce con l'errore tipizzato di budget
  (già esistente), la routine resta attiva ma il pannello lo dice.
- **Ora legale/fuso**: cron con fuso esplicito (DBOS `cron_timezone`).
- **Concorrenza**: due riavvii non duplicano ricorrenze (workflow id
  deterministico per schedule+istante, garantito da DBOS).

## 7. Domande aperte per la validazione

1. Confermi il principio **«l'automazione ripete l'affidamento, mai
   l'approvazione»** con default tutto-supervisionato (autonomia opt-in
   fase per fase)?
2. La chat unica della routine (diario con separatori «Ricorrenza di…») ti
   sta bene, o preferisci una conversazione per ricorrenza?
3. Recupero alla riapertura: una sola proposta, o vuoi la coda completa come
   opzione esplicita?
4. Nella fetta 1 la routine nasce **solo da un lavoro esistente**: confermi,
   o vuoi subito anche «crea routine da zero» in Automazioni?
5. Le ricorrenze non riuscite: la routine prosegue (con avviso) come proposto,
   o preferisci la pausa automatica dopo N fallimenti?
