# Decision 0013: Connector authentication (schema-driven) + capability routing (Tool Search)

Date: 2026-06-11

## Status

Accepted, implemented. Two related decisions kept together because they share one principle:
**read the authoritative source, don't guess.** Builds on the capability registry (Composio +
MCP) and the chat tool loop.

## Context

Two problems surfaced from real use:

1. **Connector connection guessed the auth.** The connect form showed "API key" for any toolkit
   that wasn't Composio-managed-OAuth (`needsKey = !no_auth && !managed_oauth`). Spotify actually
   needs OAuth2 with a custom Client ID + Secret → the form was wrong, the connection failed.
2. **Tool overload.** As connected tools grow (>30–50), putting every tool in the prompt degrades
   the model. SOTA (Anthropic Tool Search) keeps a small always-loaded core and discovers the rest.

## Decision

### A. Connector auth is schema-driven

- `GET /api/capabilities/composio/toolkits/{slug}/auth` reads Composio's real
  `auth_config_details` for the toolkit and returns `schemes[] = { mode (OAUTH2|API_KEY|…),
  managed, creation_fields, initiation_fields }` (`parse_composio_fields` handles snake/camel +
  a `secret` flag). The frontend `ConnectModal` builds the form FROM these: managed OAuth → a
  one-click button; custom OAuth → Client ID/Secret fields + the redirect-URI to whitelist;
  API_KEY → the key field; a toggle when both managed and custom exist.
- `composio_link_blocking` has a schema-driven path: `composio_auth_config_resolve` creates the
  auth_config (`use_custom_auth` + scheme + credentials, or `use_composio_managed_auth`), then
  initiates the connection. OAuth → returns a `redirect_url` (Composio's hosted consent page);
  API_KEY → `config.val` carries the key and connects immediately. The legacy api_key path is
  preserved as a fallback when the auth endpoint returns no schemes.

**Two gotchas, hard-won (documented inline so they don't regress):**
- `POST /auth_configs` (auth-config CREATION) wants **`authScheme` (camelCase)**; the
  `/connected_accounts/link` `config.val` block wants **`auth_scheme` (snake_case)**. Same
  provider, different cases per endpoint. Sending snake_case to create → 400 "Validation error".
- Custom auth-config also requires `name`, and OAuth2 requires `credentials.oauth_redirect_uri`
  (defaulted to `https://backend.composio.dev/api/v3.1/toolkits/auth/callback`). The same URL is
  shown in the UI as the redirect the user must whitelist in their own OAuth app.

**Division of labor.** Composio hosts what it can (the OAuth *consent* window = `redirect_url`;
for managed apps, even the OAuth app). It does NOT host collection of your own OAuth app's
Client ID/Secret — that's a one-time developer step, so that form is unavoidable for non-managed
toolkits. For API keys Composio has no hosted page either, so we collect and pass them.

### B. Capability routing = small core + deferred discovery (Tool Search)

- `CORE_TOOL_NAMES` is the always-loaded set (~18 tools: find_capability, recall_memory,
  resolve_datetime, use_skill, create_automation, schedule_task, send_message, github_search,
  file/project tools, …). Everything else is **deferred**.
- `find_capability(intent)` ranks the deferred corpus with **real BM25** (`bm25_rank`: IDF +
  TF saturation k1=1.5 + length norm b=0.75, word tokenization) and loads the matched tool
  schemas into the live set for the rest of the turn. Native tools + skills go through BM25;
  connectors go through `search_composio_catalog` (toolkit-aware: returns a service's full CRUD
  set together, so the model sees create/update/delete/read as a unit). No embeddings — BM25 is
  the SOTA default at this scale.
- The browser is deferred, not the silent catch-all it used to be.

## Status: verified vs pending

**Verified:** auth endpoint returns correct schemes live (Spotify OAUTH2/custom with
client_id+client_secret; Gmail OAUTH2/managed; Notion managed + API_KEY with `generic_api_key`);
the camelCase fix resolved the 400 (confirmed by advancing the validation to "Missing Client id"
with empty creds); **Spotify connected end-to-end (ACTIVE)** with the user's real credentials;
`bm25_rank` ordering (unit); `search_composio_catalog` / `composio_tool_is_read` (unit).

**Pending / caveats:**
- ~~Two parallel auth-config builders~~ **DONE**: the legacy `composio_auth_config_id` was
  removed; the legacy link path now expresses itself through `composio_auth_config_resolve`
  (api_key→API_KEY/custom, else→OAUTH2/managed). One builder to maintain.
- ~~Per-turn catalog rebuild~~ **DONE**: `composio_chat_tools_cached` caches the `/tools` fan-out
  per `cap` with a short TTL (`LFPA_COMPOSIO_CACHE_SECS`, default 60s), invalidated on
  connect/link/disconnect. Measured: cold ~10s → cached ~0.4s on this setup (4 toolkits).
- Verbose Composio diagnostics are now opt-in behind `LFPA_DEBUG` (error bodies can echo
  submitted credentials).

## Consequences

Adding a connector or auth scheme needs no per-service code: the form and link flow derive from
Composio's declared schemes. The tool surface stays small regardless of how many capabilities are
connected. Same discipline as the engine staying domain-neutral (ADR 0011).
