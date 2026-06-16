# Decision 0014: Multilingual — English default with self-contained plugin i18n

Date: 2026-06-16

## Status

Accepted (direction). Implemented for the personal assistant + the Proactivity
addon. Extensible to all plugins and additional languages.

## Context

The app was Italian-only in practice: all system prompts, tool descriptions, UI
strings and plugin panels were hardcoded in Italian. `PROJECT.md` declared
"language-agnostic and multilingual by default" but the implementation was the
opposite — Italian was wired into every layer.

Three forces made this urgent:

1. **English is the neutral substrate for LLM instructions.** Models follow
   English system prompts more reliably than Italian ones, and produce better
   output in the requested language when the instructions are in English. Keeping
   Italian in the prompts was leaving quality on the table.
2. **The product targets international users.** The personal assistant is the
   adoption wedge; addons are the business. Both must be able to speak any
   language the user chooses.
3. **Plugins must be self-contained (ADR 0011 §6).** If a plugin's translations
   live in the host's central JSON, the plugin is not self-contained: a
   third-party author would have to edit the host files, and detaching the plugin
   would orphan keys. The i18n architecture had to respect the addon boundary.

## Decision

**1. English is the default and neutral instruction language.**

All system prompts and tool descriptions are written in English. The output
language is driven by a single dynamic instruction: `Reply in {language}`, where
`{language}` is the user's chosen ISO-639-1 code (default `en`). The model sees
English instructions and produces output in the requested language — this is the
pattern that maximizes instruction-following fidelity across model families.

**2. The user's language is a persisted preference.**

`UserPrefs.language` (ISO-639-1) lives in `user-prefs.json`, alongside the
existing `timezone` preference. It is read fresh on every scheduler tick and
injected into every system prompt. Endpoint `GET/POST /api/prefs/language`
exposes it to the UI. Supported languages: `en` (default), `it`, `es`, `fr`, `de`.

**3. Language propagates to subagents.**

`OrchestratorRequest.language` carries the user's language into the orchestrator.
The subagent workflow injects it into `task.input`, and the runner appends
`Reply in {language}.` to the subagent prompt. The dormant `IntentClassifyRequest.locale`
field is wired to the same value.

**4. The UI uses `react-i18next` with English as fallback.**

`i18n/index.ts` initializes with `fallbackLng: "en"` and resources from
`locales/en.json` + `locales/it.json`. The language picker (`LanguageRow` in
Settings → General) persists to both the backend pref (for prompts) and
`localStorage` (for the UI), then calls `i18n.changeLanguage()`.

**5. Plugins carry their own translations as i18next namespaces.**

This is the key architectural decision for the addon ecosystem. Each plugin is
a self-contained folder with its own `locales/{en,it}.json`. The `PluginManifest`
declares an optional `registerI18n?: (i18n) => void` callback that registers the
plugin's translations as a dedicated i18next namespace via `addResourceBundle`.

Structure:
```
src/plugins/proattivita/
  index.tsx              # manifest + registerI18n callback
  locales/en.json        # flat keys: { "title": "Proactivity", ... }
  locales/it.json
```

The host calls `registerPluginI18n()` once at bootstrap (after `i18n.init()`).
Plugin panels use the native namespace syntax: `t("proattivita:title")`.

This means:
- A plugin's translations live **with the plugin**, not in the host's central JSON.
- Detaching a plugin (removing it from the registry) makes its translations vanish too.
- A third-party plugin (path B) declares the same `registerI18n` callback — the
  conversion is mechanical, no new API needed.
- The host's `translation` namespace stays clean and domain-neutral.

## Consequences

- Adding a language = adding a `{lang}.json` file per plugin + the host. No code changes.
- Plugin authors are responsible for their own translations; the host does not
  translate on their behalf.
- The `en.json`/`it.json` files are the single source of truth for the host's
  strings; plugin namespaces are the single source for plugin strings. No overlap.
- In path B (external plugins), the `registerI18n` callback becomes the typed
  `postMessage` bridge equivalent: the plugin publishes its resource bundles to
  the host's i18next instance via the capability API.

## What changed in the codebase

- All ~34 system prompts translated to English (`crates/desktop-gateway/src/main.rs`, `lib.rs`).
- All ~90 tool descriptions translated to English.
- `UserPrefs.language` + `effective_user_language()` + `GET/POST /api/prefs/language`.
- `OrchestratorRequest.language` + runner injection.
- `react-i18next` setup + `en.json`/`it.json` (~350 host keys).
- 10 UI components fully migrated to `t()` (Shell, ChatView, SettingsView, Sidebar,
  ContactsView, AutomationsView, TasksView, MemoryView, LearningView, MarkdownEditor).
- `mockData.ts` labels → i18n keys; mock data → English.
- Plugin system: `PluginManifest.registerI18n` + `src/plugins/proattivita/` self-contained.
