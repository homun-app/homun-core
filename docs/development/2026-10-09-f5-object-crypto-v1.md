# F5 fetta 5 — object-transfer crypto + HTTP transfer routes

9 ottobre 2026. Fette verticali di F5.3: libreria crypto, poi rotte HTTP
host/peer per pubblicare e riprendere i transfer (grant + wrap).

## Protocollo `homun-object-transfer/v1`

| Elemento | Scelta | Note |
|---|---|---|
| Chiave oggetto | 32 byte casuali / oggetto+versione | Mai riusata tra versioni |
| Wrap destinatario | libsodium SealedBox su X25519 | Chiave dispositivo Ed25519 convertita (libsodium) |
| Payload | `crypto_secretstream_xchacha20poly1305` | Chunk autenticati, tag FINAL obbligatorio |
| Manifest | JSON con hash plaintext + hash per chunk ciphertext | Ripresa dopo disconnessione |
| Credenziali | Escluse | Schema allowlist + assert: secret store / workspace key mai nei transfer |

Il relay (o un peer senza wrap) vede solo ciphertext + metadati del
manifest: non ottiene la chiave oggetto.

## API

Modulo: `engine/src/homun/peers/object_crypto.py`

- `seal_object(plaintext, object_id, version, recipient_public_pems)` →
  `TransferManifest` + chunk ciphertext
- `open_object(manifest, chunks, recipient_private_pem, fingerprint)` →
  plaintext (fail-closed su corruzione / wrap assente)
- `missing_chunk_indices` / `verify_chunk` per resume

Test libreria: `engine/tests/test_object_crypto_f55.py`.

## Rotte HTTP (host)

Modulo store: `engine/src/homun/identity/object_transfer.py`  
Router: `engine/src/homun/routes/object_transfer_api.py`

| Metodo | Path | Auth |
|---|---|---|
| POST | `/v1/workspaces/{ws}/remote/objects` | grant **write** sul `project_id` |
| PUT | `…/remote/objects/{id}/versions/{v}/chunks/{i}` | grant **write** |
| GET | `…/remote/objects/{id}/versions/{v}` | grant **read** + wrap destinatario |
| GET | `…/remote/objects/{id}/versions/{v}/chunks/{i}` | grant **read** + wrap (octet-stream) |
| GET | `…/remote/objects?project_id=` | grant **read** + wrap (elenco) |

Lo snapshot replica (`GET …/remote/snapshot`) include `object_transfers`
filtrato allo stesso modo (grant + wrap). Nessun fallback in simulazione.

Alla publish, l'host emette anche `object_transfer.published` sull'aggregato
`project` (payload: object_id, version, hash/size plaintext, chunk_count —
niente wrap né ciphertext). I peer con grant lo vedono su
`GET …/remote/events?cursor=…`. Il fetch dei chunk resta gated da grant+wrap.

Test HTTP: `engine/tests/test_object_transfer_http_f55.py`.

## Prove §5 coperture

- ✅ File cifrato corrotto/troncato rifiutato (libreria + upload HTTP)
- ✅ Peer non autorizzato senza wrap non decifra / non legge manifest
- ✅ Relay material (manifest+ciphertext+wrap rubato) non decifra
- ✅ Resume: chunk già verificati saltati; host riporta `missing_chunks`
- ✅ Senza grant di progetto → 403 tipizzato
- ✅ Revoca dispositivo: publish di nuove versioni rifiuta wrap verso
  fingerprint revocati (`permission_denied`); sessioni del device muoiono
- ✅ UX Impostazioni → Persone dichiara il limite sulle copie già scaricate
  e decifrate (Homun non le cancella da remoto)
- ✅ Credenziali / secret store: manifest/meta/announce con allowlist;
  campi `api_key`/`credentials`/… rifiutati; valori del secret store non
  compaiono negli artefatti del transfer (`assert_no_credentials_in_transfer`)

## Revoca e copie già scaricate

Alla `POST …/remote/objects` l'host confronta i `recipients` del manifest
con i dispositivi `status=revoked` nello store: se un wrap punta a un
fingerprint revocato, la publish fallisce. Le versioni già pubblicate
prima della revoca restano sul disco host; il device revocato perde il
token di trasporto e non ottiene più chunk. **Limite dichiarato**: una
copia già scaricata e decifrata sul device non può essere cancellata da
remoto — lo stesso testo è in Impostazioni → Persone.

Test: `test_revoked_device_cannot_be_wrapped_on_new_versions`.

## Resto di F5.3

1. ~~Rotte host/peer per pubblicare e riprendere transfer~~ ✅
2. ~~Integrazione outbox (annuncio transfer come evento di dominio)~~ ✅
   listing snapshot + `object_transfer.published` sul feed eventi/cursor
3. ~~Revoca: nuove versioni non wrappano dispositivi revocati; UX dichiara i
   limiti sulle copie già scaricate~~ ✅
4. ~~Credenziali: assert esplicito che secret store non entra nei transfer~~ ✅
   allowlist schema + rifiuto campi credential; test che i valori del
   secret store non compaiono in meta/API/eventi del transfer
5. Review indipendente del protocollo prima della beta con dati sensibili
6. D-CRYPTO-01 (cifratura a riposo del profilo) resta separata

## Pilot due Mac

Il pilot VPN (`development/2026-10-08-pilot-runbook.md`) **non** dipende da
questa fetta. Resta bloccato solo da operatività (Tailscale + due installazioni),
non da codice di cifratura oggetti.
