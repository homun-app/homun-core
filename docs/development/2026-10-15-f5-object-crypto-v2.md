# F5 fetta 5 — protocollo `homun-object-transfer/v2`

15 ottobre 2026. Riformulazione del protocollo di trasferimento oggetti dopo
la **review indipendente di sicurezza** (pre-pilot): sei rilievi, tutti
trattati nella PR #449. Il formato v1 non è mai stato
usato da dati reali (nessuna directory `object-transfers` esisteva al
momento del cambio) ed è **rifiutato** con errore tipizzato
`object_transfer.protocol_unsupported`.

16 ottobre 2026: la **verifica indipendente della PR #449** ha prodotto sei
nuovi rilievi (A–F in questa pagina: sezione atomica di pubblicazione,
quota su dimensioni dichiarate, directory autori, protezioni destinatario
solo libreria, log versioni fail-closed, AAD non ambiguo).

Sostituisce `2026-10-09-f5-object-crypto-v1.md` come riferimento del formato;
le scelte crypto di base restano quelle (chiave per oggetto/versione, wrap
SealedBox Ed25519→X25519, secretstream XChaCha20-Poly1305).

## Formato v2

```json
{
  "protocol": "homun-object-transfer/v2",
  "project_id": "proj_…",
  "object_id": "obj_contratto",
  "version": 2,
  "chunk_size": 65536,
  "header_b64": "…secretstream header…",
  "chunks": [{ "index": 0, "sha256": "…ciphertext…", "size": 65553 }],
  "recipients": [{ "device_fingerprint": "sha256:…", "wrapped_key_b64": "…" }],
  "publisher_fingerprint": "sha256:…",
  "publisher_signature_b64": "…Ed25519 detached…"
}
```

Rispetto a v1: entra `project_id` (firmato), entrano `publisher_fingerprint`
e `publisher_signature_b64`; escono `plaintext_sha256` e `plaintext_size`
(review P4: l'hash del contenuto in chiaro non deve mai viaggiare fuori dal
ciphertext; l'integrità è garantita da AEAD + firma sugli hash dei chunk
cifrati). Se servirà un hash del contenuto, andrà dentro il payload cifrato.

## Firma dell'autore (review P2)

Chi pubblica firma il manifest con la chiave Ed25519 del **proprio
dispositivo**. La firma è staccata e copre la **forma canonica del manifest
senza la firma**: JSON UTF-8 con chiavi ordinate, nessuno spazio, interi
decimali senza zeri iniziali (sottoinsieme equivalente a RFC 8785/JCS;
implementata in `canonical_manifest_bytes` — stessa funzione su entrambi i
lati, quindi accordo byte per byte). Copre protocollo, `project_id`,
`object_id`, versione, header, hash/dimensioni di ogni chunk e destinatari.

- **Host, alla pubblicazione**: la firma deve verificarsi contro la chiave
  pubblica registrata per `publisher_fingerprint` (record di pairing), il
  dispositivo deve essere **confermato** e appartenere alla persona che fa
  la richiesta, e il progetto firmato deve coincidere con quello dichiarato.
  Rifiuti tipizzati: `publisher_signature_invalid`,
  `publisher_device_mismatch`, `declared_project_mismatch`.
- **Destinatario, in `open_object`**: verifica la firma contro
  `trusted_publisher_pems` — i dispositivi **confermati delle persone con
  grant `write` attivo** sul progetto, come esposti dal campo `devices`
  dello snapshot di replica (verifica C: chi ha solo `read` non può
  pubblicare e non è un autore di cui fidarsi). Publisher sconosciuto →
  `publisher_not_trusted`. `open_object` restituisce `OpenedObject` con
  plaintext e `publisher_fingerprint`: il destinatario sa **chi** ha
  prodotto il file.

## Dati aggiuntivi del secretstream (review P3)

Ogni `crypto_secretstream_xchacha20poly1305_push/pull` riceve come
additional data la codifica **canonica JSON** (stessa funzione della firma,
`canonical_manifest_bytes`) di
`(protocollo, project_id, object_id, versione, indice del chunk)`:

```
{"chunk":0,"object_id":"obj_…","project_id":"proj_…","protocol":"homun-object-transfer/v2","version":2}
```

(verifica F: niente separatori ambigui — valori di `project_id`/`object_id`
contenenti il separatore non possono collidere con un'altra coppia di
campi; `aad_context` è obbligatorio in `encrypt_payload`/`decrypt_payload`.)

Il destinatario la ricostruisce dai valori che **ha chiesto**
(`expected_object_id/version/project_id` in `open_object`), non da quelli
del manifest ricevuto: un manifest che non corrisponde è rifiutato
(`manifest_mismatch`). Conseguenza: chunk di un altro oggetto o di un'altra
versione — anche con hash di manifest coerenti e firma valida — falliscono
l'autenticazione AEAD.

**Anti-rollback**: il destinatario conserva per ogni oggetto la versione
massima aperta (`peers.object_crypto.ReceivedVersionLog`, file JSON) e la
passa come `last_opened_version`; una versione minore è rifiutata con
`version_rollback`.

## Proprietà e immutabilità delle versioni (review P1)

- un `object_id` appartiene al progetto della **prima pubblicazione**: ogni
  pubblicazione successiva deve dichiarare lo stesso progetto
  (`project_mismatch`) e richiede `write` su **quel** progetto;
- le versioni pubblicate sono **immutabili**: ripubblicare una versione
  esistente è ammesso solo come ripetizione identica (stesso manifest in
  forma canonica → risposta idempotente, nessun evento duplicato; la
  sequenza dell'annuncio è registrata in `meta.json`); altrimenti
  `version_immutable`;
- una nuova versione deve essere **maggiore** dell'ultima esistente
  (`version_not_increasing`);
- `put_chunk` autorizza sul progetto dell'oggetto letto da `meta.json`
  (test di regressione dedicato).

**Sezione atomica (verifica A)**: la decisione «di chi è l'oggetto / quale
versione è ammessa» e la scrittura del meta sono un'unica operazione — un
lock dello store transfer serializza verifica di proprietà + quota +
scrittura fra thread (e via flock anche fra processi che condividono la
data dir), e la directory di versione è creata in modo **esclusivo**
(`mkdir` senza `exist_ok`): chi perde la creazione ri-applica le regole
come ripetizione idempotente o conflitto (`version_immutable`;
`version_dir_stale` se la directory resta senza manifest). Pubblicazioni
concorrenti dello stesso `object_id` hanno quindi **esattamente un
vincitore**, anche in parallelo.

## Limiti (review P5)

`identity/transfer_limits.py`, configurabili via ambiente, letti a ogni
chiamata: `HOMUN_OBJECT_TRANSFER_MAX_CHUNK_BYTES` (default 1 MiB),
`…_MAX_CHUNKS_PER_OBJECT` (4096), `…_MAX_OBJECT_BYTES` (512 MiB),
`…_MAX_PROJECT_BYTES` (2 GiB). Il manifest è validato **prima** di scrivere
qualsiasi file; il corpo del chunk è letto a blocchi e interrotto oltre il
tetto (Content-Length controllato prima; anche il trasporto JSON è limitato).
Reason: `too_many_chunks`, `chunk_too_large`, `object_too_large`,
`project_quota_exceeded`.

**Quota su dimensioni dichiarate (verifica B)**: la quota del progetto
somma le dimensioni **dichiarate** nei manifest (meta su disco), valutata
dentro la stessa sezione atomica del publish — un manifest **riserva** il
suo spazio alla pubblicazione. Pubblicare manifest senza caricare i chunk
non aggira la quota, e `put_chunk` non serve un controllo ulteriore: la
dimensione di ogni chunk è già vincolata all'hash del manifest verificato.

## Annuncio senza hash in chiaro (review P4)

L'evento `object_transfer.published` — visibile a chiunque abbia grant di
lettura, anche senza wrap — porta solo: progetto, oggetto, versione,
`chunk_count` e `approx_size_bytes` = totale ciphertext **arrotondato per
eccesso a multipli di 64 KiB** (`rounded_size_bytes`). L'arrotondamento
impedisce di confermare la dimensione esatta di un file noto; la granularità
è un compromesso tra utilità informativa e oracle di conferma. Niente
`plaintext_sha256`, niente dimensione esatta, né nell'evento né nel manifest
in chiaro né in `meta.json`.

## Verifiche lato destinatario: oggi SOLO libreria (verifica D)

Firma del publisher, mismatch dei valori attesi e anti-rollback esistono
**solo a livello di libreria** (`peers.object_crypto`): nessun codice in
`engine/src` fuori dai test né nelle app chiama oggi `open_object` o
`ReceivedVersionLog`. Il client che scarica gli oggetti **non esiste ancora**.

Il futuro client di download (da costruire) **DEVE** usare, obbligatoriamente:

- `open_object` con i **valori attesi** (`expected_object_id`,
  `expected_version`, `expected_project_id`) richiesti dall'utente/UI,
  mai i valori letti dal manifest ricevuto;
- `trusted_publisher_pems` costruita dalla directory `devices` dello
  snapshot **filtrata per grant `write` attivo** (verifica C), finché non
  ci sarà il pinning TOFU delle chiavi (limite noto, vedi modello di
  minaccia);
- `ReceivedVersionLog` persistente per oggetto, con `last_opened_version`
  passato a ogni `open_object` (anti-rollback; il log è fail-closed:
  `version_log_corrupt` se il file è corrotto, verifica E).

**Il pilot NON deve trasferire oggetti fra macchine** finché quel client
non esiste: le protezioni lato destinatario non sono "collegate al
prodotto" e un peer che scarica senza passare da `open_object` +
`ReceivedVersionLog` non ha nessuna delle garanzie P2/P3.

## Stessa chiave per firmare e cifrare (review P6 — scelta documentata, NON cambiata)

La chiave Ed25519 del dispositivo è convertita in X25519 per i wrap
SealedBox (conversione libsodium `crypto_sign_ed25519_sk_to_curve25519`).
Usare la stessa chiave per firma e key agreement è considerato accettabile
**solo** con le garanzie di libsodium sulle conversioni Domain-Separated;
la pratica migliore resta una chiave per funzione. **Condizione per
revisione**: alla prossima versione del protocollo (v3) o dopo un audit
esterno della crypto, introdurre una sottochiave di cifratura derivata o
affiancata (fingerprint separato nel pairing), con migrazione dei wrap.

## Modello di minaccia

Avversari considerati:

| Avversario                                     | Protezione                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Relay/rete** (vede tutto il traffico)        | Ciphertext opaco senza wrap; manifest firmato (alterazioni → firma invalida); chunk legati a oggetto/versione via AAD; niente hash in chiaro da confermare.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Host compromesso** (serve dati falsi/vecchi) | Manifest servito al posto di un altro → `manifest_mismatch` (valori attesi); versione vecchia al posto di nuova → AAD + `version_rollback`; contenuto sostituito → hash chunk + AEAD. **La firma del publisher protegge da membri e relay, NON da un host che controlla la directory delle chiavi** (verifica C): l'host che serve lo snapshot potrebbe inserire una propria chiave tra i `devices` e firmare manifest arbitrari — il destinatario che si fida solo dello snapshot non può distinguerlo. Limite noto; lavoro futuro insieme al client di download: **pinning TOFU** delle chiavi dei dispositivi alla prima vista, con avviso all'utente in caso di cambio. Un host può comunque **rifiutarsi di servire** (DoS): non protetto. |
| **Host curioso** (legge il disco)              | Vede solo ciphertext, wrap e hash ciphertext; la chiave oggetto è nei wrap SealedBox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Membro malevolo con `write`**                | Può pubblicare solo: nel proprio progetto di appartenenza dell'oggetto (P1, sezione atomica con creazione esclusiva della directory di versione), con manifest firmato dal proprio dispositivo attivo (P2), entro i limiti/quota su dimensioni dichiarate (P5, verifica B). Può creare contenuti per un destinatario, ma il destinatario vede **chi** ha pubblicato (`publisher_fingerprint`) e la firma è verificata contro i dispositivi confermati dei grant `write` dello snapshot (revoca → `publisher_not_trusted`). Può dichiarare destinatari arbitrari (wrap verso chiunque) — limite noto: l'annuncio non equivale a consenso.                                                                                                        |
| **Peer con grant di lettura ma senza wrap**    | Vede evento di annuncio (senza hash/dimensione esatta) e listing; manifest e chunk richiedono grant + wrap per un proprio dispositivo. Non compare nella directory `devices` (verifica C).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Cosa questo protocollo **NON** protegge:

- **copie già decifrate** su un dispositivo (dopo la revoca non si cancellano
  da remoto — limite dichiarato anche in Impostazioni → Persone);
- un **host che rifiuta di servire** o cancella dati (DoS/disponibilità);
  l'integrità e l'autenticità sono garantite, la disponibilità no;
- un **host che controlla la directory delle chiavi**: se il destinatario
  verifica la firma solo contro i `devices` ricevuti dall'host nello
  snapshot, un host compromesso può inserire una chiave propria e firmare
  manifest arbitrari (verifica C). La firma protegge da membri malevoli e
  relay, non dall'host. Mitigazione futura, da costruire insieme al client
  di download: **pinning TOFU** delle chiavi alla prima vista, con avviso
  in caso di cambio chiave;
- la **metafora del timing**: evento e dimensione arrotondata viaggiano in
  chiaro; la granularità di 64 KiB riduce ma non azzera la classe di
  size-fingerprinting.

## Test

- Libreria: `engine/tests/test_object_crypto_f55.py` (firma, fiducia
  publisher, AAD, valori attesi, rollback, assenza hash in chiaro).
- HTTP/host: `engine/tests/test_object_transfer_http_f55.py` (attacchi
  cross-project, immutabilità, firma/revoca, progetti, limiti, quota,
  annuncio senza leak). Ogni fix è entrato con il test d'attacco rosso
  sul codice precedente.
- Seconda verifica (A–F): `engine/tests/test_object_transfer_security_f55.py`
  (publish concorrenti con un solo vincitore, quota su dimensioni
  dichiarate, directory autori write-only, più i test P1–P5 della prima
  review).

## Pilot

Il pilot con utenti reali può riprendere gli scenari già dimostrati (pair,
grant, sync read-only, contributi conversazione/delega), ma **NON deve
trasferire oggetti fra macchine** finché non esiste il client di download
che usa le verifiche lato destinatario (verifica D, sezione precedente).
Aggiornare anche `docs/SVILUPPO.md` quando quel client sarà costruito.
