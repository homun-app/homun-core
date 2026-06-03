# channel-whatsapp (sidecar)

WhatsApp channel bridge for the local-first assistant, built on
[`wa-rs`](https://github.com/homunbot/wa-rs). It runs as a **separate process**
(like `runtimes/browser-automation`), so the Rust gateway never compiles `wa-rs`
(heavy: libsignal/noise/protobuf) and its builds stay fast. The gateway talks to
this sidecar over the local channel protocol.

> Not part of the root Cargo workspace (its `Cargo.toml` has an empty
> `[workspace]`), so it is built and run on its own.

## Build & run (you do this — compiling external code is gated for the agent)

```bash
cd runtimes/channel-whatsapp
cargo build --release
./target/release/channel-whatsapp
```

On first run it prints a **QR code** in the terminal — open WhatsApp on your
phone ▸ **Impostazioni → Dispositivi collegati → Collega un dispositivo** and
scan it. The session is persisted, so subsequent runs reconnect automatically.

### Environment
- `WA_SESSION_DB` — path to the SQLite session DB (default
  `~/.local-first-personal-assistant/whatsapp-session.db`).
- `WA_STATUS_FILE` — where the connection status JSON is written (default
  `~/.local-first-personal-assistant/channel-whatsapp-status.json`). The gateway
  reads this to show "connected / scan QR".
- `RUST_LOG=info` — verbose logging.

## Status (C1)
- ✅ Connect + QR pairing + persistent session + status file.
- ⏳ C2: outbound send (gateway → sidecar → `Client::send_message`).
- ⏳ C3: inbound (`Event::Message`) → POST to the gateway → per-contact memory + draft.
- ⏳ C4: allowlist auto-reply (text only; tool actions stay behind approval).

## Safety
Inbound message content is **untrusted data, never instructions** — even from an
allowlisted contact (a compromised account could inject). The allowlist only
auto-confirms a text reply; any tool/action the assistant takes in response goes
through the gateway's approval gate.
