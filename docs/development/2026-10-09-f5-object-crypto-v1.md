# F5 fetta 5 — object-transfer crypto v1 (library slice)

9 ottobre 2026. Prima fetta verticale di F5.3: primitive e prove di
biblioteca. **Nessuna rotta HTTP e nessuna UI** in questo passo.

## Protocollo `homun-object-transfer/v1`

| Elemento | Scelta | Note |
|---|---|---|
| Chiave oggetto | 32 byte casuali / oggetto+versione | Mai riusata tra versioni |
| Wrap destinatario | libsodium SealedBox su X25519 | Chiave dispositivo Ed25519 convertita (libsodium) |
| Payload | `crypto_secretstream_xchacha20poly1305` | Chunk autenticati, tag FINAL obbligatorio |
| Manifest | JSON con hash plaintext + hash per chunk ciphertext | Ripresa dopo disconnessione |
| Credenziali | Escluse | Non compaiono in manifest né in plaintext di transfer |

Il relay (o un peer senza wrap) vede solo ciphertext + metadati del
manifest: non ottiene la chiave oggetto.

## API

Modulo: `engine/src/homun/peers/object_crypto.py`

- `seal_object(plaintext, object_id, version, recipient_public_pems)` →
  `TransferManifest` + chunk ciphertext
- `open_object(manifest, chunks, recipient_private_pem, fingerprint)` →
  plaintext (fail-closed su corruzione / wrap assente)
- `missing_chunk_indices` / `verify_chunk` per resume

Test: `engine/tests/test_object_crypto_f55.py`.

## Prove §5 coperture in questa fetta

- ✅ File cifrato corrotto/troncato rifiutato
- ✅ Peer non autorizzato senza wrap non decifra
- ✅ Relay material (manifest+ciphertext+wrap rubato) non decifra
- ✅ Resume: chunk già verificati saltati; chunk alterati richiedere

## Resto di F5.3 (non in questo PR)

1. Rotte host/peer per pubblicare e riprendere transfer (`/v1/remote/objects…`)
2. Integrazione con replica/outbox e grant di progetto (solo destinatari col grant)
3. Revoca: nuove versioni non wrappano dispositivi revocati; UX dichiara i
   limiti sulle copie già scaricate
4. Credenziali: assert esplicito che secret store non entra nei transfer
5. Review indipendente del protocollo prima della beta con dati sensibili
6. D-CRYPTO-01 (cifratura a riposo del profilo) resta separata

## Pilot due Mac

Il pilot VPN (`development/2026-10-08-pilot-runbook.md`) **non** dipende da
questa fetta. Resta bloccato solo da operatività (Tailscale + due installazioni),
non da codice di cifratura oggetti.
