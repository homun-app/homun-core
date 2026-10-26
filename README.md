# SandBot

Clone locale di **Grok Bot** (xAI) con **modelli personalizzati**, costruito su Electron + TypeScript + React replicando l'architettura reverse-engineered dell'originale (vedi `../GROKBOT_ANALYSIS.md` e `../docs/`).

**Tutte le 9 fasi del piano (F0–F9) sono completate e verificate end-to-end.**

## Avvio

```bash
cd sandbot
npm install
npm run dev        # sviluppo
npm run build      # build di produzione
npm run dist       # DMG firmato (dist/SandBot-*.dmg)
```

## Cosa c'è già (MVP F1–F3 + F4/F5 verificati)

- **Multi-agente**: roster in sidebar, stati (online/thinking/running/paused-for-approval), unread, creazione bot
- **Chat streaming** con markdown, messaggi di avanzamento, blocco "Pensiero" per modelli reasoning (delta `reasoning`)
- **Loop agentico**: messaggio → LLM → tool-call → permessi → esecuzione → risultato → iterazione fino a completamento (max 24 passi), interrupt
- **Tool** (nomi identici all'originale): `run-command`, `read-file`, `write-file`, `list-directory`
- **Sistema permessi** replicato dall'originale: `always_allow | needs_approval | blocked` per tool+pattern, **standing grants** persistenti ("Consenti sempre"), card di approvazione inline (Consenti una volta / Consenti sempre / Nega), timeout 5 min, notice al modello su rifiuto
- **Transcript event-sourced** su SQLite (`node:sqlite`, zero rebuild nativi): `message | tool-call | tool-result | notice | approval | event`
- **Provider di modelli personalizzati**: autodiscovery al boot di **Ollama** (:11434) e **LM Studio** (:1234); qualsiasi endpoint **OpenAI-compatible** (Z.ai, OpenRouter, Mistral, xAI, DeepSeek, Groq, OpenAI...) + **Anthropic** nativo. Trasporto via SDK ufficiali (`openai`, `@anthropic-ai/sdk`), normalizzazione interna unica → aggiungere un provider = base URL + API key, zero codice
- **Sandbox**: backend `host` (cartella `~/SandBot/<agente>/box`, cap output 10k righe con avviso trimmed) + backend `docker` (container per agente, volume persistente `/home/box`) — il backend si sceglie con l'impostazione `sandbox.mode`
- **Tray menubar** (F5): lista bot con unread e stato, click → apre e seleziona il bot, Apri/Esci
- **Deep link** (F5): `sandbot://agent/<id>` apre l'app e seleziona il bot (registrato come protocol handler)
- **Draft recovery** (F5): il testo non inviato sopravvive a cambio agente e riavvii (localStorage per agente)
- **Notifiche native** (F4): "Bot ha risposto" quando la finestra non è a fuoco — nota: in dev macOS le scarta (app non firmata); attive al packaging con bundle id proprio
- **Computer use** (F6) — mirror di `CUGrokBotService`: tool `use-app` con azioni `screenshot | click | double_click | right_click | type | key | open_app`; screenshot retina → **vision** (gemma4:31b / minimax-m3 via Ollama, coordinate convertite in punti schermo); azioni via AppleScript System Events; permessi **per azione** (screenshot auto-consentito, le altre con approvazione); nomi app localizzati (Calcolatrice→Calculator) con fallback Spotlight. Verificato: il bot guarda lo schermo, apre app, digita tasti e **ri-screenshot per auto-verificarsi**. Click/type/key richiedono il permesso Accessibility per l'app (macOS lo chiede al primo uso o in System Settings → Privacy → Accessibility)
- **Routine** (F7): attività ricorrenti per bot su schedule cron (node-cron), tab dedicato nelle impostazioni con crea/abilita/elimina, `last_run` tracciato, turni automatici prefissati `[routine ricorrente: …]`; **suggerimento automatico** delle routine dai comportamenti ricorrenti del transcript (prompt originale "repeated user behaviors"). Verificato: routine ogni-minuto scattata puntuale due volte
- **Quick-ask** (F7): pannello "⚡ Chiedi al volo" — domanda effimera sul contesto della chat, risposta immediata, **non inquina il transcript** (prompt originale "ephemeral question")
- **Allegati immagine** (F7): 📎 nel composer → file picker → immagine base64 inviata al modello vision insieme al messaggio
- **MCP client** (F8): server MCP esterni (stdio o HTTP) diventano tool dinamici `mcp__<server>__<tool>` con schema automatico, cache connessioni, ogni chiamata richiede approvazione (regola `mcp__*`). Tab MCP nelle impostazioni con add/test/elimina. Verificato con server di prova (`test-mcp/weather.mjs`)
- **Vault credenziali** (F8): AES-256-GCM con envelope `sandVault:1` (iv||authTag||ct) come i sealed file dell'originale; chiave master nel **Keychain macOS** (mai su disco col dato); tool `read-credential` con approvazione e **redazione nel transcript** (il valore arriva al modello, mai alla UI). Verificato: risposta bot "SK-1234 e 9876" con transcript pulito
- **Packaging** (F9): electron-builder → `dist/SandBot-0.1.0-arm64.dmg` **firmato con Developer ID** (com.fabio.sandbot), avvio verificato. Notifiche: il codice è corretto; i banner appaiono quando macOS non è in Focus (durante i test il Focus Lavoro con Smart Activation li sopprimeva a livello di sistema)

## Struttura

```
src/
├── main/            # processo Electron: finestra, IPC, store SQLite, tray, deep-link
│   ├── agent/       # loop.ts, llm.ts (2 adapter + normalize + vision), providers.ts, tools.ts, permissions.ts, prompts.ts
│   ├── computeruse/ # use-app: screenshot (vision) + click/type/key/open_app via AppleScript
│   ├── sandbox/     # host.ts + docker.ts
│   └── store/db.ts  # schema e query
├── preload/         # contextBridge "sandbot" (contextIsolation ON)
├── renderer/        # React: Sidebar, Chat, ApprovalCard, Settings (provider/modelli/permessi)
└── shared/types.ts  # contratto IPC tipizzato
```

## Note tecniche

- Con `"type": "module"` il preload esce come `.mjs`: il main prova `.mjs` poi `.js` (bug risolto in testing)
- I tool-calls in streaming vanno catturati **durante** l'iterazione dello stream (i chunk finali portano i tool-call completi)
- Modelli Ollama consigliati per tool-calling veloce: `glm-5.3-flash:cloud`, `deepseek-v4-pro:cloud` (kimi-k2.7-code è lento nel reasoning); **vision**: `gemma4:31b-cloud`, `minimax-m3:cloud` (qwen3-vl e glm-5 sono stati ritirati)
- Le approval scadute aggiornano lo status della card (expired) — fix applicato dopo test
- `approvals:resolve-latest` è un hook IPC di test/debug per risolvere l'approval pending più recente

## Estensioni future (oltre il piano)

Voice input, iMessage (escluso per scelta), sandbox Docker (backend pronto, richiede Docker), marketplace template agenti, i18n.
