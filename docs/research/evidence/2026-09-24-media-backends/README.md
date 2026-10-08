# Evidence: real media backends (2026-09-24)

## Proven locally

- Ollama vision via `gemma4:latest` on `http://127.0.0.1:11434` — red 8x8 PNG → description `Red`, tokens > 0.
- macOS `say` TTS — writes a real AIFF under `HOMUN_DATA_DIR/media/artifacts/` (`file://` URL).
- macOS computer-use probe via ApplicationServices (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`); `ready` stays false without an input/capture driver.

## Persistence (H25/H30)

- `GoalStore` SQLite replaces process dict for goals.
- `SessionStorage` product default is `HOMUN_DATA_DIR/sessions.sqlite` (not `:memory:`).

See `ollama-vision-macos-tts.json`.
