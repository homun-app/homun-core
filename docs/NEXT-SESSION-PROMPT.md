# Prompt per la prossima sessione: Migrazione Config → DB

Copia e incolla questo come primo messaggio nella nuova sessione Claude Code:

---

## Obiettivo

Migrare TUTTE le sezioni config di Homun dalla persistenza TOML-only alla persistenza DB-backed (SQLite). Il DB diventa la source of truth, il TOML resta come bootstrap/backup umano-leggibile.

## Contesto — cosa è già stato fatto

Nella sessione precedente abbiamo migrato 3 sezioni (`security.execution_sandbox`, `security.exfiltration`, `permissions`) stabilendo il pattern completo e testandolo end-to-end. Il pattern funziona ed è verificato (DB override TOML confermato al restart).

### Infrastruttura già implementata

1. **Tabella `settings`** — `migrations/052_settings.sql`:
   - Schema: `section TEXT PK, value_json TEXT, updated_at TEXT`
   - Una riga per sezione config, blob JSON con la struct serializzata

2. **DB operations** — `src/storage/db.rs`:
   - `db.get_settings_section(section) -> Option<String>` — legge JSON blob
   - `db.set_settings_section(section, json)` — INSERT OR REPLACE

3. **Overlay al boot** — `src/config/mod.rs`:
   - `overlay_db_settings(&mut config, &db)` — per ogni sezione in DB, deserializza JSON e sostituisce il campo in Config struct. Errori di deserializzazione = warn + fallback TOML
   - Section constants: `SECTION_SANDBOX`, `SECTION_EXFILTRATION`, `SECTION_PERMISSIONS`

4. **Save centralizzato** — `src/web/server.rs`:
   - `AppState::save_config_section(section)` — serializza la sezione corrente dell'Arc<RwLock<Config>>, scrive nel DB (primary), scrive TOML (backup best-effort)

5. **Startup** — `src/main.rs` (gateway mode, ~riga 1002):
   - Ordine: `Config::load()` → `Database::open()` → `overlay_db_settings()` → `Arc::new(RwLock::new(config))`

### Pattern per aggiungere una nuova sezione (3 modifiche)

**A.** `src/config/mod.rs` — aggiungi constant + match arm in `overlay_db_settings()`:
```rust
pub const SECTION_AGENT: &str = "agent";
// dentro overlay_db_settings():
if let Some(json) = load_section(db, SECTION_AGENT).await {
    match serde_json::from_str::<AgentConfig>(&json) {
        Ok(val) => { config.agent = val; applied.push(SECTION_AGENT); }
        Err(e) => tracing::warn!(section = SECTION_AGENT, error = %e, "DB settings overlay: corrupt JSON, using TOML default"),
    }
}
```

**B.** `src/web/server.rs` — aggiungi match arm in `save_config_section()`:
```rust
crate::config::SECTION_AGENT => serde_json::to_string(&config.agent)?,
```

**C.** Ogni API endpoint che scrive quella sezione — sostituisci `config.save()` o `state.save_config()` con `state.save_config_section(SECTION_X)`:
```rust
// Prima (TOML only):
let mut config = state.config.write().await;
config.agent = new_value;
config.save()?;
// Dopo (DB primary + TOML backup):
{
    let mut config = state.config.write().await;
    config.agent = new_value;
}
state.save_config_section(crate::config::SECTION_AGENT).await?;
```

## Sezioni da migrare (13 sezioni)

| # | Sezione TOML | Section key | Struct Rust | File API che scrive |
|---|---|---|---|---|
| 1 | `agent` | `agent` | `AgentConfig` | `providers.rs` |
| 2 | `channels.telegram` | `channels.telegram` | `TelegramConfig` | `channels.rs` |
| 3 | `channels.whatsapp` | `channels.whatsapp` | `WhatsAppConfig` | `channels.rs` |
| 4 | `channels.discord` | `channels.discord` | `DiscordConfig` | `channels.rs` |
| 5 | `channels.slack` | `channels.slack` | `SlackConfig` | `channels.rs` |
| 6 | `channels.email` | `channels.email` | `EmailConfig` | `email_accounts.rs` |
| 7 | `channels.web` | `channels.web` | `WebConfig` | `onboarding.rs` |
| 8 | `tools.exec` | `tools.exec` | `ExecConfig` | `main.rs` (CLI) |
| 9 | `browser` | `browser` | `BrowserConfig` | `browser.rs` |
| 10 | `mcp` | `mcp` | `McpConfig` | `mcp/crud.rs` |
| 11 | `providers` | `providers` | provider sub-configs | `providers.rs` |
| 12 | `storage` | `storage` | `StorageConfig` | `main.rs` (CLI) |
| 13 | `ui` | `ui` | `UiConfig` | `onboarding.rs` |

## Approccio consigliato

1. Inizia dai **canali** (2-7) — sono tutti simili, stabiliscono il ritmo
2. Poi **agent + providers** (1, 11) — i più usati dalla UI
3. Poi **browser + mcp** (9, 10) — hanno più endpoint
4. Infine **tools.exec, storage, ui** (8, 12, 13) — pochi o nessun endpoint API
5. Per i **CLI commands** (`main.rs` — `config set`, `provider add/remove`): passa il DB handle e chiama `db.set_settings_section()` direttamente

Per ciascuna sezione: `cargo check` dopo ogni modifica, poi verifica che l'endpoint API scriva nel DB.

## Verifica finale

Per ogni sezione migrata:
1. `cargo check` + `cargo test` passano
2. Modifica un valore dalla Web UI → `sqlite3 ~/.homun/homun.db "SELECT section, length(value_json) FROM settings"` mostra la riga
3. Modifica il TOML a mano a un valore diverso → restart → l'API restituisce il valore DB (non TOML)
4. Elimina la riga dal DB → restart → TOML viene usato come fallback

Al termine: tutti gli endpoint API usano `save_config_section()`, e `config.save()` non viene più chiamato direttamente da nessun handler (solo come backup dentro `save_config_section`).

## Riferimenti

- Pattern completo: `src/config/mod.rs`, `src/web/server.rs` (save_config_section)
- Config struct: `src/config/schema.rs` — cerca le struct per trovare i tipi esatti
- Tutti i punti di mutazione: `grep -rn "config.save\|save_config" src/web/api/ src/main.rs`
- Doc di riferimento: `docs/features/17-permission-grant-ux.md` sezione 12.1
