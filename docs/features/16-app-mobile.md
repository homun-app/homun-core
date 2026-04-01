# Feature 16 — App Mobile

> Documento di specifica funzionale per il dominio **App Mobile** del progetto Homun.
> Versione: 2026-04-01

---

## 1. Mobile Pairing (QR Code flow, sessioni di pairing)

### Comportamento Atteso
- L'utente admin crea una **sessione di pairing** dalla Web UI. Il backend genera un QR code SVG contenente un payload JSON firmato.
- L'app mobile scansiona il QR code e **reclama** la sessione inviando i propri dati dispositivo (nome, piattaforma, chiave pubblica opzionale, push token).
- L'admin **approva** la sessione dalla Web UI. All'approvazione viene generato un bearer token dedicato (`hm_mobile_*`) e un device ID (`mob_*`).
- L'app mobile **riceve** il token e le credenziali tramite polling sull'endpoint di risultato.
- Ogni passo ha validazione temporale (TTL 2-10 minuti, default 5) e nonce crittografico per prevenire replay.
- Se il dispositivo approvato e l'unico attivo, viene automaticamente impostato come **notify target**.
- **Input:** TTL opzionale, base URL preferito (admin); nome dispositivo, piattaforma, chiave pubblica, push token (app).
- **Output:** QR SVG + payload JSON; token e credenziali dopo approvazione.
- **Stati:** `created` -> `claimed` -> `approved` -> `completed`. Sessioni scadute diventano `expired`.
- **Edge case:** nonce invalido restituisce 403. Sessione gia reclamata restituisce 409. Sessione scaduta restituisce 410.

### Dettagli Tecnici
- **Moduli:** `src/web/api/mobile.rs`
- **Tipi principali:** `PairingQrPayload` (v1, type `homun_mobile_pair`), `MobilePairingSessionRow`, `ClaimPairingRequest`
- **Sicurezza:**
  - Nonce: 32 byte random (base64url), salvato come SHA-256 hash nel DB. Validazione timing-safe.
  - Server fingerprint: SHA-256 di un seed persistente nel vault (`mobile.server_fingerprint_seed`). Permette al client di verificare l'identita del server.
  - Token: formato `hm_mobile_{uuid}`, scope `mobile` o `mobile_stop` (con permesso E-Stop).
- **Tabelle DB:** `mobile_pairing_sessions`, `mobile_devices`, `api_keys`
- **Endpoint API (autenticati — Web UI):**
  - `POST /v1/mobile/pairing/sessions` — crea sessione di pairing (admin)
  - `GET /v1/mobile/pairing/sessions/{id}` — stato sessione (admin)
  - `POST /v1/mobile/pairing/sessions/{id}/approve` — approva dispositivo (admin)
- **Endpoint API (pubblici — app mobile):**
  - `POST /api/v1/mobile/pairing/claim` — reclama sessione con dati dispositivo
  - `GET /api/v1/mobile/pairing/sessions/{id}/result?nonce=...` — polling risultato

### Dipendenze
- **Da cosa dipende:** `storage::Database` (tabelle mobile_*), `ring` (crypto), `qrcodegen` (QR SVG), vault (`global_secrets`).
- **Cosa dipende da questa feature:** gestione dispositivi, bootstrap mobile, tunnel config.

---

## 2. Gestione Dispositivi Mobile

### Comportamento Atteso
- L'admin puo visualizzare la lista dei dispositivi mobile associati al proprio account.
- Ogni dispositivo mostra: nome, piattaforma (ios/android), versione app, data creazione, ultimo accesso, permesso E-Stop, stato notify target.
- L'admin puo eliminare un dispositivo (hard delete: rimuove anche il bearer token associato).
- L'admin puo impostare un dispositivo come **notify target** per ricevere notifiche push.
- **Input:** device ID per operazioni singole; flag `enabled` per notify target.
- **Output:** lista dispositivi; conferma operazione.
- **Edge case:** eliminare un dispositivo di un altro utente restituisce 404 (non 403, per non rivelare l'esistenza).

### Dettagli Tecnici
- **Moduli:** `src/web/api/mobile.rs`
- **Tipi principali:** `MobileDeviceRow`, `MobileDeviceSummary`
- **Tabelle DB:** `mobile_devices`, `api_keys` (token associato)
- **Endpoint API:**
  - `GET /v1/mobile/devices` — lista dispositivi (admin)
  - `DELETE /v1/mobile/devices/{id}` — elimina dispositivo e token (admin)
  - `POST /v1/mobile/devices/{id}/notify-target` — set/unset notify target (admin)

### Dipendenze
- **Da cosa dipende:** pairing (crea i dispositivi), `storage::Database`.
- **Cosa dipende da questa feature:** push notifications, E-Stop mobile.

---

## 3. Mobile Bootstrap

### Comportamento Atteso
- All'avvio, l'app mobile chiama il bootstrap per ottenere le informazioni iniziali: dati dispositivo, account utente, URL server, fingerprint, e capabilities abilitate.
- Richiede un bearer token mobile valido (scope `mobile` o `mobile_stop`).
- Le capabilities dipendono dallo scope del token:
  - `mobile`: chat attiva, approvals/activity_feed disattivi, E-Stop disattivo.
  - `mobile_stop`: come sopra, ma con E-Stop attivo.
- **Input:** bearer token nell'header Authorization.
- **Output:** oggetto bootstrap con device, account, server, capabilities.
- **Edge case:** token senza device associato restituisce 401.

### Dettagli Tecnici
- **Moduli:** `src/web/api/mobile.rs`
- **Tipi principali:** `MobileBootstrapResponse`, `MobileCapabilities`
- **Endpoint API:**
  - `GET /v1/mobile/bootstrap` — bootstrap iniziale (scope mobile richiesto)

### Dipendenze
- **Da cosa dipende:** dispositivi registrati, bearer token, `AppState.public_base_url`.
- **Cosa dipende da questa feature:** inizializzazione app mobile.

---

## 4. Tunnel Configuration

### Comportamento Atteso
- Per rendere il server raggiungibile dall'app mobile su rete esterna, l'utente puo configurare un tunnel (Cloudflare, ngrok, o comando custom).
- La Web UI mostra lo stato attuale: provider, URL pubblico corrente, se il pairing e pronto (URL disponibile).
- L'utente puo abilitare/disabilitare il tunnel, cambiare provider, configurare auth token, URL riservato, comando custom.
- Le modifiche richiedono un restart di Homun per essere applicate.
- **Input:** provider (`cloudflare` | `ngrok` | `custom`), auth_token, reserved_url, custom_command, custom_args.
- **Output:** configurazione tunnel corrente; stato pairing readiness.
- **Edge case:** provider `custom` senza `custom_command` quando abilitato restituisce 400. URL ngrok senza protocollo restituisce 400.

### Dettagli Tecnici
- **Moduli:** `src/web/api/mobile.rs`, `src/config/schema.rs` (`TunnelConfig`)
- **Endpoint API:**
  - `GET /v1/mobile/tunnel` — leggi configurazione tunnel (admin)
  - `PUT /v1/mobile/tunnel` — salva configurazione tunnel (admin)

### Dipendenze
- **Da cosa dipende:** `Config` (sezione `channels.web.tunnel`), `AppState.save_config()`.
- **Cosa dipende da questa feature:** pairing (richiede URL pubblico raggiungibile).

---

## 5. Chat Profile API (profilo attivo per conversazione)

### Comportamento Atteso
- Il client mobile (o web) puo **leggere** il profilo attivo di una conversazione e la lista dei profili disponibili.
- Il client puo **cambiare** il profilo attivo di un thread senza inviare un messaggio `/profile` nella chat.
- Il cambio e **persistente** sulla sessione: i turni successivi della stessa conversazione usano il nuovo profilo.
- Il cambio **non influenza** altre conversazioni: ogni thread ha il proprio profilo indipendente.
- Nessun messaggio viene scritto nella conversazione al cambio profilo.
- Per i thread nuovi (senza override esplicito), il backend restituisce il profilo risolto dalla catena di default.

### Risoluzione Profilo Attivo (GET)
Il backend determina il profilo attivo con questa cascata:
1. **Session override** (`sessions.profile_id`) — impostato via PUT o comando `/profile`
2. **Global config default** (`config.profiles.default` slug) — configurato nel TOML
3. **Default hardcoded** — il profilo con `is_default = 1` (sempre presente)

> **Nota:** la catena completa del `profile_resolver.rs` (5 livelli con contact/gateway override) non si applica alla web/mobile chat, che non ha il concetto di contact o gateway override. La cascata ridotta a 3 livelli e corretta per questo contesto.

### Coerenza Cross-Componente
Tre componenti consumano `sessions.profile_id` e devono concordare sulla risoluzione:

| Componente | Modulo | Comportamento |
|---|---|---|
| **Agent loop** | `agent_loop.rs` | Legge `session.profile_id` **prima** della cascata del resolver. Se presente e valido, usa quello. Altrimenti fallback a contact → channel → global → default. |
| **Comando `/profile`** | `gateway.rs` | Usa `resolve_session_profile()` — stessa cascata della API. |
| **API GET /chat/profile** | `chat.rs` | Usa `resolve_session_profile()` — stessa cascata del comando. |

La funzione condivisa `resolve_session_profile()` vive in `src/agent/profile_resolver.rs` ed e la **singola source of truth** per la risoluzione profilo sessione web/mobile.

**Invariante**: dopo un PUT che setta `profile_slug = "work"`, tutti e tre i consumatori devono restituire/usare il profilo "work" per quella sessione. Altre sessioni non sono influenzate.

### Contratto API

**GET /api/v1/chat/profile?conversation_id=...**

Risposta 200:
```json
{
  "conversation_id": "conv_123",
  "active_profile": {
    "id": 2,
    "slug": "personal",
    "display_name": "Personale",
    "avatar_emoji": "\ud83c\udfe0",
    "color": "#10B981",
    "is_default": false
  },
  "available_profiles": [
    {
      "id": 1,
      "slug": "default",
      "display_name": "Default",
      "avatar_emoji": "\ud83d\udc64",
      "color": "#64748B",
      "is_default": true
    }
  ]
}
```

**PUT /api/v1/chat/profile**

Body:
```json
{
  "conversation_id": "conv_123",
  "profile_slug": "work"
}
```

Risposta 200:
```json
{
  "ok": true,
  "conversation_id": "conv_123",
  "active_profile": {
    "id": 3,
    "slug": "work",
    "display_name": "Work",
    "avatar_emoji": "\ud83d\udcbc",
    "color": "#2563EB",
    "is_default": false
  }
}
```

### Errori
| Status | Condizione |
|--------|-----------|
| 400 | `conversation_id` o `profile_slug` vuoti/assenti |
| 401 | Utente non autenticato |
| 403 | Conversazione di un altro utente |
| 404 | Conversazione non esistente, o profilo slug non trovato (PUT) |
| 503 | Database non disponibile |

### Dettagli Tecnici
- **Moduli:** `src/web/api/chat.rs`, `src/agent/profile_resolver.rs`
- **Funzioni principali:**
  - `get_chat_profile()` — handler GET, valida accesso, risolve profilo attivo, carica lista profili
  - `set_chat_profile()` — handler PUT, valida accesso + write permission, trova profilo per slug, persiste con `set_session_profile_id`
  - `resolve_session_profile()` (`profile_resolver.rs`) — cascata condivisa a 3 livelli, usata da API e `/profile` command
- **Tipi:** `ProfileSummary`, `ChatProfileResponse`, `SetChatProfileRequest`, `SetChatProfileResponse`
- **Tabelle DB:** `sessions` (campo `profile_id`), `profiles`
- **Accesso:** `ensure_chat_conversation_access()` per validare ownership della conversazione
- **Persistenza:** `db.set_session_profile_id(session_key, profile_id)` — aggiorna solo il campo `profile_id` della sessione, non scrive messaggi

### Dipendenze
- **Da cosa dipende:** `ensure_chat_conversation_access` (ownership chat), `profiles::db` (CRUD profili), `storage::Database` (session profile_id).
- **Cosa dipende da questa feature:** client Flutter (profile picker UI), agent loop (usa `session.profile_id` per determinare personalita e scoping).

---

## Mappa Endpoint

| Metodo | Endpoint | Auth | Scopo |
|--------|----------|------|-------|
| POST | `/v1/mobile/pairing/sessions` | Admin | Crea sessione pairing |
| GET | `/v1/mobile/pairing/sessions/{id}` | Admin | Stato sessione |
| POST | `/v1/mobile/pairing/sessions/{id}/approve` | Admin | Approva dispositivo |
| POST | `/api/v1/mobile/pairing/claim` | Pubblico | App reclama sessione |
| GET | `/api/v1/mobile/pairing/sessions/{id}/result` | Pubblico | App polling risultato |
| GET | `/v1/mobile/devices` | Admin | Lista dispositivi |
| DELETE | `/v1/mobile/devices/{id}` | Admin | Elimina dispositivo |
| POST | `/v1/mobile/devices/{id}/notify-target` | Admin | Set notify target |
| GET | `/v1/mobile/bootstrap` | Mobile | Bootstrap iniziale |
| GET | `/v1/mobile/tunnel` | Admin | Leggi config tunnel |
| PUT | `/v1/mobile/tunnel` | Admin | Salva config tunnel |
| GET | `/v1/chat/profile` | Session | Profilo attivo conversazione |
| PUT | `/v1/chat/profile` | Session+Write | Cambia profilo conversazione |
