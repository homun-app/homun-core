# Skills & MCP — Specifiche Funzionali

## Panoramica

Il sistema Skills & MCP di Homun abilita l'estensibilità dell'agente attraverso due meccanismi complementari:

1. **Skills**: Script riutilizzabili registrati nel formato Agent Skills specification (SKILL.md con frontmatter YAML), caricati dinamicamente dal file system con scansione di sicurezza pre-install
2. **MCP (Model Context Protocol)**: Server di strumenti remoti che espongono tool, resource e capability dinamici tramite stdio o HTTP, con supporto OAuth nativo e hot-reload

Il sistema integra skill discovery (GitHub + ClawHub + Open Skills), installazione con validazione di sicurezza (static analysis + VirusTotal), esecuzione sandbox-aware (Python/Bash/JavaScript/TypeScript), e attivazione con progressive disclosure (frontmatter caricato all'avvio, body on-demand).

---

## Features

### 1. Agent Skills — Standard e Formato

#### Comportamento Atteso

- **File**: `SKILL.md` nella root del skill directory
- **Struttura**: YAML frontmatter (delimitato da `---`) + corpo markdown
- **Frontmatter fields**:
  - `name`: identificatore skill (lowercase, hyphens only) — deve matchare il directory name
  - `description`: cosa fa e quando usare (2-3 frasi)
  - `license`: (opzionale) SPDX identifier (default: MIT)
  - `compatibility`: (opzionale) info per riconoscimento versione
  - `allowed-tools`: (opzionale) tool policy, spazio-separato (es. "filesystem github")
  - `user-invocable`: bool (default: true) — se false, skill non è callable da slash commands
  - `disable-model-invocation`: bool (default: false) — se true, skill escluso da LLM prompt
  - `metadata`: (opzionale) JSON object per metadati custom (es. `metadata.openclaw.requires`)
- **Corpo**: Markdown con workflow, guardrails, composizione skill (se generato)
- **Directory structure**:
  ```
  skill-name/
    SKILL.md
    scripts/
      run.py / run.sh / run.js / run.ts
      (altri script opzionali)
    requirements.txt / package.json / Gemfile
    references/
      composition.md (se skill generato)
  ```
- **Progressive disclosure**: metadata caricato all'avvio (~100 token), body caricato on-demand quando attivato
- **Stati**: caricato, eligible/ineligible (runtime checks), inattivo, attivo

#### Dettagli Tecnici

**Struct principali** (`src/skills/loader.rs`):
- `SkillMetadata`: frontmatter parsed (name, description, license, allowed_tools, user_invocable, disable_model_invocation)
- `SkillRequirements`: requisiti runtime (bins, any_bins, env, os) estratti da `metadata.openclaw.requires`
- `Skill`: skill caricato (meta, path, body Optional, eligible, profile_slug)
- `SkillRegistry`: `HashMap<name, Skill>`

**Parse YAML frontmatter** — `parse_skill_md()` e `parse_skill_md_public()`:
- Delimitatore: `---` (standard YAML)
- Parsing: serde_yaml, restituisce `(SkillMetadata, body_string)`

**Directory scanning** (priorità):
1. `~/.homun/skills/` (user-installed, global)
2. `./skills/` (project-local, global)
3. `~/.homun/brain/profiles/{slug}/skills/` (per-profile)

**Eligibility checks** — `check_eligibility()`:
- `bins`: tutti obbligatori (AND logic) — cercati via `which`
- `any_bins`: almeno uno richiesto (OR logic)
- `env`: tutte le variabili devono essere presenti
- `os`: se specificato, OS attuale deve matchare uno dei valori (macos, linux, windows)
- Skills ineligibili: esclusi da LLM prompt, ma disponibili per invocazione manuale

**Database**: nessuno — skill metadata in memory, body su disco

#### Dipendenze

- Dipende da: loader, executor, installer, security, creator
- Dipendono da: agent cognition (context building), skill watcher, skill activator

---

### 2. Skill Loader — Caricamento e Parsing

#### Comportamento Atteso

- **Trigger**: avvio applicazione, skill activation, hot-reload watcher
- **Output**: `SkillRegistry` con metadata precaricato
- **Deduplicazione**: se skill name duplicato tra directory, priorità: user-installed > project-local > profile (first match wins)
- **Errori**: invalid SKILL.md → warning log, skill skipped
- **Timing**: ~100ms per 50 skill (metadata only)

#### Dettagli Tecnici

**Metodi principali** (`SkillRegistry` impl):
- `scan_and_load()`: scan dirs in priorità, popola registry
- `scan_directory_with_profile(dir, profile_slug)`: scan una directory, tag con profile
- `scan_profile_skills(data_dir)`: iterate `~/.homun/brain/profiles/*/skills/`, tag con slug
- `load_skill_metadata(skill_dir)`: leggi SKILL.md, parse frontmatter, crea Skill (body=None)
- `check_all_eligibility()`: per ogni skill, estrai requirements da metadata, check eligibility
- `get(name)` / `get_mut(name)`: accesso skill by name
- `list()` / `list_eligible()`: enumerate all / eligible only
- `build_prompt_summary()`: formato testo per LLM context

**Eligibility check** — `extract_requirements()` + `check_eligibility()`:
- Estrai da `metadata.openclaw.requires` (o `metadata.clawdbot.requires`)
- Verifica bins, env, OS

**Field mapping**:
- `name` ← frontmatter `name`
- `description` ← frontmatter `description`
- `allowed_tools` ← frontmatter `allowed-tools` (string spazio-separato)
- `user_invocable` ← frontmatter `user-invocable` (default true)
- `disable_model_invocation` ← frontmatter `disable-model-invocation` (default false)
- `eligible` ← result di check_eligibility

#### Dipendenze

- Dipende da: nessuno (entry point del sistema)
- Dipendono da: creator (trova related skills), activator (activate on demand), watcher (reload)

---

### 3. Skill Executor — Esecuzione Script

#### Comportamento Atteso

- **Input**: skill_dir, script_name, args[], timeout_secs
- **Output**: `ScriptOutput { stdout, stderr, exit_code, success }`
- **Interpreter detection** per estensione:
  - `.py` → `python3`
  - `.sh` → `bash`
  - `.js` → `node`
  - `.ts` → `npx tsx`
  - default (no ext) → `bash`
- **Working directory**: skill_dir (i.e. `scripts/run.sh` run da skill_dir)
- **Timeout**: configurabile, default ~15s per smoke test, ~60s per script normale
- **Environment**: eredita da processo parent + extra_env injection (es. API keys)
- **Sandbox**: optional `ExecutionSandboxConfig` per resource limiting

#### Dettagli Tecnici

**Funzioni principali** (`src/skills/executor.rs`):
- `execute_skill_script(skill_dir, script_name, args, timeout_secs)` → ScriptOutput
- `execute_skill_script_with_sandbox(...)` → ScriptOutput
- `execute_skill_script_with_env(...)` → ScriptOutput
- `list_skill_scripts(skill_dir)` → `Vec<String>` (find all .py/.sh/.js/.ts in scripts/)

**ScriptOutput struct**:
```rust
pub struct ScriptOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,  // status.success()
}
```

**Execution flow**:
1. Resolve script path: `skill_dir/scripts/{script_name}`
2. Detect interpreter da extension
3. Build command args: `[interpreter, script_path, ...args]`
4. Call `build_process_command()` (sandbox-aware, env sanitization)
5. Spawn child process, capture stdout/stderr
6. Apply timeout via `tokio::time::timeout(Duration, wait_with_output())`
7. Restituisce ScriptOutput

**Smoke test**: script run con argomento `--smoke-test`, atteso output contenente `homun_skill_smoke_ok`

#### Dipendenze

- Dipende da: `ExecutionSandboxConfig`, `build_process_command` (sandbox)
- Dipendono da: creator (validate script), skill activator (run via slash command)

---

### 4. Skill Installer — Installazione da GitHub

#### Comportamento Atteso

- **Input**: repo_spec (formato `owner/repo` o `owner/repo@ref`)
- **Output**: `InstallResult { name, path, already_existed, description, security_report }`
- **Flusso**:
  1. Parse spec → (owner, repo, git_ref)
  2. Get default_branch se ref non specificato
  3. Fetch SKILL.md (o SKILL.toml/manifest.json legacy)
  4. Scan skill content (pre-install security check)
  5. Se blocked: bail
  6. Download repo as tarball
  7. Extract a `~/.homun/skills/{skill-name}/`
  8. Adapt legacy manifest se necessario
  9. Scan package (post-install, più completo)
  10. Return result
- **Deduplicazione**: se skill già installato, return skipped (`already_existed=true`)

#### Dettagli Tecnici

**Struct principali** (`src/skills/installer.rs`):
- `SkillInstaller`: client, skills_dir
- `InstallResult`: name, path, already_existed, description, security_report
- `InstalledSkillInfo`: name, description, path

**Metodi**:
- `install(repo_spec)` / `install_with_options(repo_spec, security_options)` → `Result<InstallResult>`
- `remove(name)` → async, delete skill directory
- `list_installed()` → async, read `~/.homun/skills/`, return `Vec<InstalledSkillInfo>`

**GitHub API endpoints**:
- `GET https://api.github.com/repos/{owner}/{repo}` → default_branch
- `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}` → file content (base64)
- `GET https://api.github.com/repos/{owner}/{repo}/tarball/{ref}` → tarball stream

**Security flow**:
- Pre-download: `scan_skill_content(remote_manifest.raw_content)` — only SKILL.md text
- Post-extract: `scan_skill_package(skill_dir)` — full package (scripts, files, reputation)

#### Dipendenze

- Dipende da: security (scan), adapter (legacy), loader (parse)
- Dipendono da: tools (skill install command), skill search (results → install)

---

### 5. Skill Security — Scansione Pre-Install

#### Comportamento Atteso

- **Input**: skill directory path o raw SKILL.md content
- **Output**: `SecurityReport { score, risk_score, blocked, warnings, scanned_files, cache_hit, reputation_checked, reputation_hits }`
- **Risk scoring**: 0 (clean) - 100 (dangerous)
  - Threshold di blocco: >= 65 OR any Critical severity
  - Severity points: Critical=55, Warning=18, Info=6
- **Warning categories**: Destructive, PrivilegeEscalation, SecretAccess, RemoteExecution, Obfuscation, NetworkActivity, Reputation, PromptInjection, Other
- **Caching**:
  - Package cache: 24 ore
  - Reputation cache: 7 giorni
- **VirusTotal integration** (opzionale): se `VIRUSTOTAL_API_KEY` impostata, check file hashes per max 4 script files

#### Dettagli Tecnici

**Struct principali** (`src/skills/security.rs`):
- `SecurityReport`: score (0-1), risk_score (0-100), blocked (bool), warnings[], scanned_files, cache_hit, reputation_checked, reputation_hits
- `SecurityWarning`: severity (Critical/Warning/Info), category (enum), pattern, description, file, line, source (StaticAnalysis/VirusTotal/ReputationCache)
- `Severity` enum: Critical (block), Warning (risk+), Info (note)
- `WarningCategory` enum: Destructive, PrivilegeEscalation, SecretAccess, RemoteExecution, Obfuscation, NetworkActivity, Reputation, PromptInjection, Other
- `WarningSource` enum: StaticAnalysis, VirusTotal, ReputationCache
- `InstallSecurityOptions`: force (bool) — force install bypassing warnings

**Scanning flow**:
1. `scan_skill_content(content)` — raw text scan (pre-download)
2. `collect_skill_package(root)` → SkillPackage (gather all files with size limits)
3. `scan_text(filename, content, network_declared, is_script)` → `Vec<SecurityWarning>`
4. `lookup_virustotal_verdict(cache, api_key, sha256)` → (checked, verdict)
5. `build_report(warnings, file_count, ...)` → SecurityReport

**Pattern detection** (esempi):
- Destructive: `rm -rf`, `dd if=/dev/`, `mkfs`, `format`
- Privilege: `sudo`, `setuid`, `/etc/sudoers`
- Secrets: `~/.ssh`, `~/.aws`, `GITHUB_TOKEN`, `API_KEY`
- Remote: `curl | bash`, `ssh user@host`
- Obfuscation: `base64`, `eval`, `exec`

**Cache storage** (`~/.homun/skill-security-cache.json`):
```json
{
  "packages": { "package_hash": { "report + timestamp" } },
  "reputation": { "file_sha256": { "verdict + timestamp" } }
}
```

#### Dipendenze

- Dipende da: nessuno (modulo indipendente)
- Dipendono da: installer (pre-install), creator (post-creation)

---

### 6. Skill Creator — Generazione LLM

#### Comportamento Atteso

- **Input**: `SkillCreationRequest { prompt, name?, language?, overwrite? }`
- **Output**: `SkillCreationResult { name, path, script_path, script_language, reused_skills, validation_notes, security_report, smoke_test_passed }`
- **Flusso**:
  1. Normalize/deriva skill name da prompt (6 parole max, kebab-case, max 63 chars)
  2. Infer script language (default: python; bash se "shell" nel prompt; js se "javascript")
  3. Find related skills via fuzzy match (token overlap scoring, top 3)
  4. Generate SKILL.md template (con composition section se related skills trovati)
  5. Generate script template (run.py / run.sh / run.js)
  6. Write files a `~/.homun/skills/{name}/`
  7. Validate: parse SKILL.md, syntax check script
  8. Run smoke test (--smoke-test flag)
  9. Scan security (post-creation)
  10. Return result con notes e report
- **Validation**: SKILL.md parse OK, script syntax OK (bash -n / node --check / python -m py_compile), smoke test OK
- **Edge cases**: skill exists (fail unless overwrite=true), empty prompt (bail)

#### Dettagli Tecnici

**Struct principali** (`src/skills/creator.rs`):
- `SkillCreationRequest`: prompt, name, language, overwrite
- `SkillCreationResult`: name, path, script_path, script_language, reused_skills, validation_notes, security_report, smoke_test_passed
- `RelatedSkillPattern`: name, description, allowed_tools, workflow_steps, scripts

**Name derivation** — `derive_skill_name()`:
- Token split prompt (3+ char words, lowercase)
- Take first 6 words, join con "-"
- Add "-skill" suffix se no "-" already
- Truncate a 63 chars, trim trailing "-"

**Language inference** — `infer_language()`:
- "bash" / "shell" / "terminal" → bash
- "node" / "javascript" / "json api" → javascript
- Default: python

**Related skill pattern matching**:
- Registry scan, token overlap scoring
- Collect name, description, allowed_tools, workflow_steps (top 5), scripts list
- Top 3 by score

**Composition reference** (se skills related):
- File: `references/composition.md`
- Lista ogni related skill: description, tools, scripts, workflow steps

#### Dipendenze

- Dipende da: loader (find related), executor (smoke test), security (scan)
- Dipendono da: tools `skill_create` (LLM-driven creation), ClawHub (upload option)

---

### 7. Skill Watcher — Hot-Reload

#### Comportamento Atteso

- **Monitor**: `~/.homun/skills/` (recursive)
- **Trigger**: Create/Modify/Remove su SKILL.md o directory
- **Action**: Re-scan directory, update shared skills summary
- **Debounce**: 500ms (avoid multiple reloads per install)
- **Shared state**: `Arc<RwLock<String>>` con LLM-friendly summary (updated on reload)
- **Lifecycle**: spawn on startup, stop on agent shutdown

#### Dettagli Tecnici

**Struct** (`src/skills/watcher.rs`):
- `SkillWatcher`: skills_summary (`Arc<RwLock<String>>`), skills_dir

**Metodi**:
- `new(skills_summary, skills_dir)` → Self
- `start(self)` → WatcherHandle (stops on drop)
- `watch_loop(self, stop_rx)` → async loop che monitora file system

**File watching**:
- Library: `notify` crate (RecommendedWatcher)
- Events: Create, Modify, Remove
- Bridge: notify events (sync) → mpsc channel → async loop

**Debounce logic**:
- Receive event → start 500ms timer
- Drain additional events during timer
- After timer: re-scan, update `Arc<RwLock<String>>` atomically

#### Dipendenze

- Dipende da: loader (`scan_and_load`, `build_prompt_summary`)
- Dipendono da: agent context builder (reads skills_summary Arc)

---

### 8. Skill Search — Scoperta e Ricerca

#### Comportamento Atteso

- **Sources**:
  - Local: `SkillRegistry.list()`
  - GitHub: GitHub API search con topic `agentskills`
  - ClawHub: ClawHub marketplace (native API o GitHub monorepo)
  - Open Skills: besoeasy/open-skills GitHub repo
- **Query types**: by name, by description keyword, topic-based
- **Results**: sorted by relevance (stars > recency > alphabet)
- **Caching**: ClawHub + Open Skills con cache locale (TTL 6h e 24h rispettivamente)

#### Dettagli Tecnici

**Struct principali** (`src/skills/search.rs`):
- `SkillSearchResult`: full_name, description, stars, updated_at, url
- `SkillSearcher`: reqwest::Client

**GitHub Skills search** — `search_github()`:
- Query: `{query} topic:agentskills`
- Endpoint: `https://api.github.com/search/repositories`
- Sort: by stars desc, limit: per_page=30

**URL encoding**:
```rust
fn urlencoded(s: &str) -> String {
    s.replace(' ', "+").replace('&', "%26").replace('=', "%3D").replace('#', "%23")
}
```

#### Dipendenze

- Dipende da: reqwest (HTTP)
- Dipendono da: tools (skill install command), ClawHub (aggregated search)

---

### 9. MCP Server Registry — Registro e OAuth

#### Comportamento Atteso

- **Presets**: 7 curated MCP servers (filesystem, github, fetch, gmail, google-calendar, notion, slack)
- **Lookup**: by id, alias, o free-text suggestion
- **Transport**: stdio (default) o HTTP
- **Auth**: env vars + vault integration
  - Segreti stored in vault con reference `vault://key_name`
  - Resolved at runtime tramite SecretKey
- **Setup flow**: apply preset → merge env → store secrets → save config
- **Validation**: `test_mcp_server_connection()` → `McpConnectionTestResult`

#### Dettagli Tecnici

**Struct principali** (`src/skills/mcp_registry.rs`):
- `McpServerPreset`: id, display_name, description, command, args, env[], docs_url, aliases, keywords, transport, url, auth_env_key
- `McpEnvVar`: key, description, required, secret, vault_key
- `McpServerInfo`: name, server_name, server_version, tool_count, connected, error (opzionale)
- `McpServerConfig` (from config): transport, command, args, url, env (HashMap), capabilities, enabled, recipe_id, auth_env_key, discovered_tool_count

**Presets** — `all_mcp_presets()`:

| ID | Command | Transport | Auth |
|----|---------|-----------|------|
| filesystem | `npx @modelcontextprotocol/server-filesystem {{workspace}}` | stdio | nessuna |
| github | `npx @modelcontextprotocol/server-github` | stdio | GITHUB_PERSONAL_ACCESS_TOKEN (vault://mcp.github.token) |
| fetch | `npx @modelcontextprotocol/server-fetch` | stdio | nessuna |
| gmail | `npx mcp-server-google-workspace` | stdio | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN |
| google-calendar | `npx mcp-server-google-workspace` | stdio | same as gmail |
| notion | — | http (`https://mcp.notion.com/mcp`) | NOTION_TOKEN (Bearer) |
| slack | `npx @modelcontextprotocol/server-slack` | stdio | SLACK_BOT_TOKEN |

**Lookup functions**:
- `find_mcp_preset(query)` → `Option<McpServerPreset>` (by id o alias)
- `suggest_mcp_presets(text)` → `Vec<McpServerPreset>` (scoring: id hit +4, alias +3, keyword hits +1)

**Secret storage** (`apply_mcp_preset_setup()`):
- Format: `vault://vault_key` in config
- SecretKey: `SecretKey::custom("vault.{vault_key}")`

**Test connection** — `test_mcp_server_connection()`:
- Start McpManager con server config
- Connect, list tools
- Return: connected, tool_count, server_name, server_version, error

#### Dipendenze

- Dipende da: Config, SecretKey/vault, McpManager
- Dipendono da: tools mcp (server list/test), CLI setup commands

---

### 10. ClawHub Marketplace

#### Comportamento Atteso

- **Registry**: GitHub monorepo (openclaw/skills) con struttura `skills/{owner}/{skill-name}/SKILL.md`
- **Install**: `clawhub:owner/skill-name` → fetch SKILL.md, security scan, extract
- **Search**: native ClawHub API (`https://clawhub.ai/api/v1/*`) con fallback GitHub code search
- **Caching**: local catalog cache (`clawhub-catalog.json`), TTL 6 ore
- **Stats**: downloads count, stars, updated_at dai ClawHub API metadata

#### Dettagli Tecnici

**Struct principali** (`src/skills/clawhub.rs`):
- `ClawHubInstaller`: reqwest::Client, skills_dir
- `ClawHubSearchResult`: owner, skill_name, description, slug, downloads, stars
- `CatalogEntry`: slug, owner, name, description, downloads, stars

**Constants**:
- `CLAWHUB_REPO_OWNER`: "openclaw"
- `CLAWHUB_REPO_NAME`: "skills"
- `CLAWHUB_BRANCH`: "main"
- `CLAWHUB_API_BASE`: "https://clawhub.ai/api/v1"
- `CATALOG_CACHE_FILENAME`: "clawhub-catalog.json"
- `CATALOG_CACHE_MAX_AGE_SECS`: 6 * 3600

**ClawHub native API endpoints**:
- `GET /api/v1/skills` (cursor pagination) → list skills
- `GET /api/v1/skills/search?q={query}` → search
- `GET /api/v1/skills/{slug}` → detail (owner, stats)

**Slug format**: `owner/skill-name`

**Cache file** (`~/.homun/clawhub-catalog.json`):
```json
{
  "fetched_at": 1234567890,
  "entries": [
    { "slug": "owner/skill", "owner": "owner", "name": "skill", "description": "...", "downloads": 123, "stars": 45 }
  ]
}
```

#### Dipendenze

- Dipende da: installer base (download, extract, adapt), security (scan)
- Dipendono da: tools (skill install command), skill search

---

### 11. Open Skills Registry

#### Comportamento Atteso

- **Repository**: GitHub (besoeasy/open-skills) con struttura `skills/{dir-name}/SKILL.md`
- **Discovery**: enumerate directories, fetch+parse SKILL.md per metadata
- **Install**: `openskills:{dir-name}` → fetch skill directory, extract, adapt legacy manifest
- **Caching**: local catalog cache (`openskills-catalog.json`), TTL 24 ore
- **Source marker**: scrive `.openskills-source` file su install

#### Dettagli Tecnici

**Struct principali** (`src/skills/openskills.rs`):
- `OpenSkillsSource`: reqwest::Client, skills_dir
- `OpenSkillsResult`: name, description, source (format: `openskills:{dir_name}`)
- `CatalogEntry`: dir_name, name, description
- `CacheStatus`: cached, stale, skill_count, age_secs

**Constants**:
- `REPO_OWNER`: "besoeasy"
- `REPO_NAME`: "open-skills"
- `BRANCH`: "main"
- `SKILLS_PATH`: "skills"
- `CACHE_FILENAME`: "openskills-catalog.json"
- `CACHE_MAX_AGE_SECS`: 24 * 3600

**Metodi**:
- `search(query, limit)` → `Result<Vec<OpenSkillsResult>>`
  1. Try cache (fresh) → refresh se stale
  2. Fuzzy search: dir_name + name + description (all terms must match)
  3. Return top `limit`
- `install(dir_name)` / `install_with_options(...)` → `Result<InstallResult>`
- `refresh_cache()` → async: get repo tree via GitHub git/trees API (recursive), parse SKILL.md per entry
- `cache_status()` → CacheStatus

**Fuzzy match**:
```rust
let terms: Vec<&str> = query.to_lowercase().split_whitespace().collect();
// All terms must match in "dir_name name description" haystack
```

#### Dipendenze

- Dipende da: installer base, security, adapter, loader
- Dipendono da: skill search aggregation

---

### 12. MCP Tool — Gestione Runtime

#### Comportamento Atteso

- **Server lifecycle**: start, list, info, call_tool, stop, restart
- **Tool discovery**: connect a server, enumerate tools + resources, register in ToolRegistry
- **Tool invocation**: resolve tool by name (format: `server__tool_name`), call MCP service, parse response
- **Resource reading**: support MCP `resource://` URIs
- **Error recovery**: connection failure → logging, tool unavailable
- **Hot-reload**: can restart server without full agent restart

#### Dettagli Tecnici

**Struct principali** (`src/tools/mcp.rs`):
- `McpServerInfo`: name, server_name, server_version, tool_count, connected, error (opzionale)
- `McpToolInfo`: name, description, parameters (JSON schema opzionale)
- `McpResourceInfo`: name, uri, description, mime_type
- `McpClientTool`: tool_name (full: `server__tool`), mcp_tool_name, tool_description, input_schema, peer, server_name, runtime_config
- `McpImageData`: mime_type, data (bytes)
- `McpPeer`: service (`Arc<RwLock<Option<RunningService>>>`)

**Tool name format**: `{server_name}__{mcp_tool_name}`
- Esempio: `filesystem__read_file`, `github__search_repositories`
- Evita collisioni tra tools da diversi MCP server

**McpManager API**:
- `start_with_sandbox(servers, sandbox, vault)` → (manager, tools)
- `server_infos()` → `Vec<McpServerInfo>`
- `list_server_resources(server_name)` → `Vec<McpResourceInfo>`
- `read_resource(uri)` → ResourceContents
- `shutdown()` → stop all servers

**McpClientTool implementation** (Tool trait):
- `name()` → `server__tool_name`
- `description()` → from MCP server metadata
- `parameters()` → JSON schema from MCP server
- `execute(args)` → `call_tool` on peer, return formatted result

**Vault resolution** (env vars):
```rust
fn resolve_env_value(server_name, env_key, raw_value) -> Result<String> {
    if raw_value.starts_with("vault://") {
        let vault_key = strip "vault://" prefix
        secrets.get(SecretKey::custom(&format!("vault.{}", vault_key)))?
    } else {
        Ok(raw_value.to_string())
    }
}
```

#### Dipendenze

- Dipende da: Config (McpServerConfig), rmcp library (MCP protocol), ExecutionSandboxConfig
- Dipendono da: ToolRegistry (tool registration), agent executor (tool invocation)

---

### 13. MCP Auto-Setup

#### Comportamento Atteso

- **Discovery**: find installed MCP server presets, suggest based on user intent
- **Setup wizard**: apply preset → prompt for required env vars → store secrets → test connection
- **Template rendering**: resolve `{{workspace}}`, `{{home}}` in command args
- **Validation**: connection test

#### Dettagli Tecnici

**Funzioni principali** (`src/mcp_setup.rs`):
- `apply_mcp_preset_setup(config, preset, server_name, env_overrides, overwrite)` → `Result<McpSetupResult>`
  1. Check if server exists (bail unless overwrite)
  2. Merge env (existing + preset + overrides)
  3. For each required env var: store in vault (secret) o insert plain value
  4. Build McpServerConfig, insert in `config.mcp.servers[server_name]`
  5. Return: stored_vault_keys[], missing_required_env[]
- `render_mcp_arg_template(arg)` → String (replace {{workspace}}, {{home}})
- `parse_env_assignments(env: &[String])` → `Result<HashMap<String, String>>`
- `test_mcp_server_connection(name, server, sandbox)` → McpConnectionTestResult

**Result types**:
- `McpSetupResult`: stored_vault_keys[], missing_required_env[]
- `McpConnectionTestResult`: connected, tool_count, server_name, server_version, error (opzionale)

**Secret storage**:
- Vault key format: `vault.{required_env.vault_key}` (es. "vault.mcp.github.token")
- Stored via `SecretKey::custom()`

**Feature gating**: `#[cfg(feature = "mcp")]` per `test_mcp_server_connection()`

#### Dipendenze

- Dipende da: Config, McpServerPreset, SecretKey/vault, McpManager
- Dipendono da: CLI setup commands, tools mcp

---

### 14. Cognition + Skills Integration

#### Comportamento Atteso

- **Skill activation**: LLM requests skill by name (tool call) o user invokes slash command
- **Progressive disclosure**: frontmatter + summary in initial prompt, full body loaded on demand
- **Variable substitution**: `$ARGUMENTS`, `${SKILL_DIR}` replaced con actual values
- **Script discovery**: list available scripts + references per skill
- **Tool policy**: `allowed-tools` restriction from skill frontmatter applicata al tool registry
- **Runtime eligibility**: skill excluded from LLM prompt se ineligible (missing bins, etc)
- **Activation header**: formatted output con skill info, script list, warnings

#### Dettagli Tecnici

**Skill activation flow** (`src/agent/skill_activator.rs`):
1. Agent receives tool call `name: skill_name, args: { query: "..." }`
2. Call `try_activate_skill(name, args, tool_registry, skill_registry)`
3. Check if name is built-in tool (early exit)
4. Load from skill_registry (rescan se non trovato)
5. Load body (on-demand)
6. Extract allowed_tools, required_bins
7. List scripts + references
8. Call `substitute_skill_variables(body, query, skill_dir, None)`
9. Return `ActivatedSkill { body, skill_dir, scripts[], references[], allowed_tools, required_bins }`

**Variable substitution** — `substitute_skill_variables()`:
- `$ARGUMENTS` → arguments string
- `${SKILL_DIR}` → absolute path to skill_dir
- `${SCRIPT_*}` → script path references

**Slash command resolution** — `try_resolve_slash_command()`:
1. Check message starts with `/`
2. Parse: `/skill-name arguments`
3. Look up skill_name in registry
4. Check `user_invocable` flag (default true)
5. Load body, list scripts/references
6. Build activation header, substitute variables

**Activation header** — `build_skill_activation_header()`:
```
[SKILL ACTIVATED: skill_name]
Path: /absolute/path/to/skill
Scripts: run.py, fetch.sh, process.js
References: composition.md
Allowed tools: tool1 tool2 (opzionale)
Usage: arguments
```

**Integration points**:
- `ContextBuilder`: includes skills summary (from watcher shared Arc)
- `Tool registry`: skill names registered as tools (se eligible)
- `Message processor`: slash command detection + activation

#### Dipendenze

- Dipende da: loader (SkillRegistry), executor (run scripts)
- Dipendono da: agent cognition (context building), LLM prompt builder

---

## Integrazione Completa: Skill + MCP Workflow

### Caso d'uso: Skill Creation + Watcher Hot-Reload

```
1. User: "Create a skill that fetches weather data"
2. Agent calls create_skill tool
   → Normalize name → "weather-data-skill"
   → Find related skills (top 3 by token overlap)
   → Generate SKILL.md template + run.py
   → Syntax check, smoke test, security scan
   → Write to ~/.homun/skills/weather-data-skill/
3. SkillWatcher detects new SKILL.md (Create event)
   → Debounce 500ms
   → Re-scan registry via scan_and_load()
   → Update Arc<RwLock<String>> skills_summary
4. Next LLM context includes new skill in prompt
5. User invokes /weather-data-skill zip_code
   → Slash command detection
   → Load body on-demand, substitute $ARGUMENTS
   → Return activation header + enriched body
```

### Caso d'uso: MCP Server Setup + Tool Integration

```
1. User: "Add GitHub MCP server"
2. Agent calls mcp tool with action=setup, preset=github
   → find_mcp_preset("github") → McpServerPreset
   → apply_mcp_preset_setup() → prompt for GITHUB_PERSONAL_ACCESS_TOKEN
   → Store token in vault (vault://mcp.github.token)
   → Insert vault:// ref in McpServerConfig
3. test_mcp_server_connection() → connected=true, tool_count=35
4. McpManager starts server: npx @modelcontextprotocol/server-github
   → Resolve vault:// env vars → real tokens
   → Spawn child process
   → Connect via stdio
   → Enumerate tools (github__search_repositories, github__list_issues, etc.)
5. Tools registered in ToolRegistry as McpClientTool
6. Agent now has 35 new GitHub tools available
```

### Caso d'uso: ClawHub Install + Security Scan

```
1. User: "Install the weather-api skill from ClawHub"
2. Agent calls skill install: clawhub:owner/weather-api
3. ClawHubInstaller.install("owner/weather-api")
   → Fetch SKILL.md from GitHub raw
   → scan_skill_content(raw) → SecurityReport (pre-download)
   → If blocked: bail with security warning
   → Download tarball from GitHub
   → Extract to ~/.homun/skills/weather-api/
   → scan_skill_package(skill_dir) → SecurityReport (post-extract)
   → Return InstallResult with security report
4. SkillWatcher → registry reload
5. Skill available immediately without restart
```
