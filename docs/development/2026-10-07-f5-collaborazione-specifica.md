# F5 — Collaborazione tra applicazioni: specifica esecutiva

7 ottobre 2026. Traduce in fette di consegna il piano F5 e i due documenti
di architettura del 17 settembre ([rete tra applicazioni](../architecture/2026-09-17-rete-tra-applicazioni.md),
[distribuzione dati](../architecture/2026-09-17-distribuzione-dati.md)),
agganciandole al codice che esiste oggi. Le decisioni D1–D3 aperte sono in
fondo (§6): questa specifica non le assume risolte, propone un default per
ciascuna e prosegue con la fetta 1 che non dipende da nessuna di esse.

**Principio architetturale ereditato (non ridecidere qui):** un'autorità per
spazio, peer con delega esplicita, nessun server centrale Homun obbligatorio.
Replica completa e failover sono fuori dal perimetro (F11).

## 0. Gate di accettazione (dal piano, scomposto in test)

Pilot: **due Mac su reti diverse**. Successo quando:
1. Il contributo di Giulia al progetto condiviso è visibile a Fabio (replica).
2. Un terzo nodo non invitato non ottiene nulla (pairing + revoca).
3. Un file si riprende dopo disconnessione (transfer riprendibile).
4. Una delega produce un solo risultato con ricevuta (assignment unico).
5. L'host del lavoro resta esplicito in ogni vista (Fonte: motore/locale/remoto).

## 1. Fondamenta esistenti su cui si costruisce (verificate 2026-10-07)

| Fondamenta | Dove | Ruolo in F5 |
|---|---|---|
| `Actor{id, workspace_id, kind}` su ogni comando ed evento | `domain/models.py` | la persona autenticata diventa reale, non un header |
| `AccessGrant` deny-by-default con `subject_id`, capability read/write/admin, status revocabile | `policy/`, B2 | già il modello membership: subject = persona, resource = progetto |
| Event log con `sequence` monotona per workspace + SSE con cursor | `storage/`, rotte `events` | la replica F5.2 è subscribe-by-cursor, già quasi interamente scritta |
| `SessionAuthMiddleware` con token effimero legato a un actor | `routes/session_auth.py`, desktop | sessione singola da estendere a persone multiple |
| Contribution portal con inviti scoped monouso | `routes/contribution_invitations.py` | pattern d'invito da generalizzare in F5.1 |
| Engine lease + `X-Homun-Actor-Id` dev-insecure | `storage/lease.py` | il dev locale resta così; il pilot gira a sessioni |
| Desktop con motore incorporato e sessione | `apps/desktop` | il "peer" è l'app installata sull'altro Mac |

## 2. Le fette

### Fetta 1 — Persone, ruoli e sessioni vere (F5.1a, nessuna rete)

**Contratto dominio** (`identity/` nuovo modulo, entità nel workspace store):
- `Person{id, workspace_id, display_name, role: owner|admin|member, status: active|revoked, created_at}`
  — l'owner di bootstrap è chi crea lo spazio (oggi `person_fabio`).
- `Device{id, workspace_id, person_id, name, key_fingerprint, status: pending|confirmed|revoked, last_seen_at}`
  — il device è proprietà della persona, revocabile da solo.
- Comandi: `person.invite` (genera invito monouso con scadenza),
  `person.revoke`, `device.confirm`, `device.revoke`. Eventi versionati come
  tutto il resto; gli id compaiono negli `actor_id` dei comandi futuri.
- **Grants**: alla conferma di una persona, emettere `AccessGrant` per i
  progetti condivisi (subject_id = person id). Nessun accesso implicito.

**Contratto sessioni**: `POST /v1/session` con invito → token di sessione
legato alla persona (non più a un actor fisso come oggi). La rotta esiste
già in forma embrionale nel desktop: generalizzare. `--dev-insecure` resta
per lo sviluppo locale con banner esplicito.

**UI**: impostazioni spazio → Persone: elenco con ruolo, invito (codice
monouso da mostrare/condividere), revoca persona e revoca device separati.

**Test**: invito scaduto rifiutato; persona revocata perde sessioni e grant;
due persone con ruoli diversi vedono progetti diversi (compiti filtrati per
persona vera — prerequisite della rifacitura Compiti); audit: ogni comando
registra la persona.

**Dimensione**: ~3-4 giorni. È anche la fetta che sblocca il rifacimento di
Compiti con filtri reali.

### Fetta 2 — Pairing tra app e trasporto (F5.1b)

**Contratto pairing** (dal doc rete §Identità):
- Il peer presenta `device_id`, chiave pubblica, versione protocollo,
  capacità dichiarate (indicative fino a prova).
- L'host conferma (binding device↔persona già creata in fetta 1) e risponde
  con i permessi di sottoscrizione iniziali.
- Handshake autenticato con la chiave del device; ogni richiesta remota
  porta attore, nodo, workspace, command_id, versione.

**Trasporto = adattatore**: prima implementazione **HTTPS autenticato
(mutual TLS o token di device)** su LAN/VPN — nessuna libreria p2p nel
motore. Spike separato (non blocca la fetta) per iroh vs libp2p sul
rendezvous oltre NAT; il relay inoltra solo traffico cifrato.

**Test**: terzo nodo senza invito rifiutato al handshake; device revocato
non completa handshake; downgrade di versione rifiutato con errore leggibile.

**Dimensione**: ~4-5 giorni + spike trasporto in parallelo.

### Fetta 3 — Replica selettiva in lettura (F5.2a)

**Contratto**: `GET /v1/remote/events?project_id=…&cursor=…` — gli stessi
eventi autorizzati che la policy già filtra, in ordine di sequence, per
progetto (perimetro distribuzione dati: mai tutte le chat). Snapshot
iniziale per progetto nuovo. Il peer proietta localmente in uno store
read-only marchiato **Fonte: motore remoto** (mai mescolato col locale).

**Test**: cursor riprende dopo disconnessione senza gap né duplicati; un
evento di progetto revocato interrompe lo stream con errore tipizzato;
l'ordinamento non dipende dall'orologio del client.

**Dimensione**: ~3-4 giorni.

### Fetta 4 — Contributi remoti e outbox (F5.2b + F5.4)

**Contratto**: il peer invia comandi con `command_id` deduplicato e
`expected_version`; l'host risponde **ACK ≠ accepted ≠ completed** (il doc
rete §3). Bozze e comandi non consegnati vivono in un outbox locale con UI
onesta; host assente = "in attesa di consegna", mai "salvato".

**Test**: comando duplicato non ha doppio effetto; conflitto di versione
esplicito al peer; outbox svuotato alla riconnessione in ordine.

**Dimensione**: ~3-4 giorni.

### Fetta 5 — Cifratura end-to-end (F5.3)

Chiave per oggetto/versione, protetta per destinatari autorizzati (libsodium
secretstream, nessun protocollo inventato); transfer con manifest/hash
riprendibile; credenziali mai replicate. Le prove obbligatorie sono quelle
del doc distribuzione §5 (corrotto/rifiutato, relay che non decifra, revoca
e limiti delle copie già scaricate dichiarati in UX).

**Dimensione**: ~5-6 giorni con review del protocollo.

### Fetta 6 — Delega ai peer (F5.5 + F5.6)

`assignment_id` con input hash, capacità concessa, scadenza e **budget
riservato dall'autorità** (aggancio al ledger esistente); il peer acquisisce
l'autorizzazione corrente prima di azioni esterne; reconcile dopo timeout
senza riassegnazioni cieche; peer lento/revocato gestiti.

**Dimensione**: ~4-5 giorni. Dipende dalle fette 2-4.

## 3. Cosa NON si costruisce in F5

Replica completa dello spazio, failover automatico, consenso distribuito,
merge di documenti peer-to-peer, blockchain (esclusa nel doc distribuzione),
copie del database SQLite via rete, accesso da browser senza app (vedi D2).

## 4. Sequenza e primo pilota utile

Fetta 1 → 2 → 3 → 4 (pilota minimo: due Mac, LAN/VPN) → 5 → 6 (pilota
completo su reti diverse col relay). Dopo la fetta 1 si rifà Compiti.
Le fette 5 e 6 possono procedere in parallelo alla stabilizzazione delle
precedenti se serve comprimere i tempi.

## 5. Rischi aperti dichiarati

- Trasporto oltre NAT non ancora scelto (spike iroh/libp2p).
- D-CRYPTO-01 (cifratra a riposo) resta aperta: la fetta 5 la copre in
  transito/condivisione, non automatizza il riposo.
- Il contribution-portal esistente va riconciliato con gli inviti di
  persona (stesso meccanismo, due superfici: decidere se unificare in fetta 1).
- Copie già scaricate non cancellabili con garanzia: la UX lo dichiara.

## 6. Decisioni per Fabio (D1–D3 + una nuova)

| # | Domanda | Default proposto |
|---|---|---|
| D1 | Chi ospita lo spazio nel pilot: il Mac di Fabio come autorità e Giulia client? Un "host aziendale" sempre acceso? | Mac di Fabio autorità nel pilot; l'host headless è già previsto dall'architettura, si valuta dopo |
| D2 | Un collega senza l'app installata può entrare dal browser? | No nella prima versione: app-only (il browser resta della persona che possiede l'installazione). Il contribution-portal copre i contributi occasionali senza app |
| D3 | Per il gate "reti diverse" usiamo una VPN esistente (es. Tailscale) o sviluppiamo subito il relay? | VPN esistente per il primo gate; il relay iroh entra dopo, quando il valore è dimostrato |
| D4 (nuova) | La condivisione **memorie** tra peer (dal tuo feedback: "condividono memorie, azioni") segue il perimetro del doc distribuzione — solo voci pertinenti/consentite per progetto con provenienza, mai l'archivio intero? | Sì: memoria di progetto replicata selettivamente come qualunque altro dato; memoria personale mai |

---

**Prossimo passo concreto**: fetta 1 al via delle decisioni (o subito col
default proposto, dato che non ne dipende).
