# Analisi — Come Hermes Agent implementa MCP e Skill (23/09/2026)

> Fonti: documentazione ufficiale [hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/docs)
> (pagine MCP Integration, Skills System, guida «Use MCP with Hermes»), repo
> [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
> (MIT, «The agent that grows with you») e `skills/AGENTS.md` del repo.
> Scopo: estrarre il modello per decidere come Homun adotta MCP e skill.

## 1. MCP in Hermes — il modello

**Dichiarazione** (YAML, `~/.hermes/config.yaml`, chiave `mcp_servers`):

```yaml
mcp_servers:
  project_fs:                      # stdio: sottoprocesso locale
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/my-project"]
  stripe:                          # HTTP: remoto con autenticazione
    url: "https://mcp.stripe.com"
    headers: { Authorization: "Bearer ***" }
    tools:
      exclude: [delete_customer, refund_payment]
```

- **Trasporti**: stdio (command/args/env/cwd), HTTP (url+headers, proxy onorati),
  SSE esplicito (`transport: sse`), **OAuth 2.1** con PKCE/refresh/DCR automatici
  (token cache 0600), **mTLS**. Sostituzione `${VAR}` ovunque (file `.env` dedicato).
- **Filtro strumenti per server**: `tools.include` (allowlist, vince su exclude) /
  `tools.exclude`, con glob (`*?[]`) — pensati per cataloghi enormi (es. 3.300 tool
  Cloudflare). Utility wrapper (`list_resources`, `get_prompt`) solo se il server li
  supporta, disattivabili. `enabled: false` per sospendere senza cancellare.
- **Esposizione all'agente**: tool con prefisso `mcp_<server>_<tool>`; lista dinamica
  (`tools/list_changed`); `lazy: true` (registra da cache dello schema, connette al
  primo uso); riciclo dei processi stdio (`idle_timeout`, `max_lifetime`).
- **Sicurezza e supervisione** (il punto più interessante per Homun):
  - **elicitation** instradata sulla superficie di approvazione (prompt CLI o bottoni
    Telegram/Slack): il server può chiedere input, ma passa dal consenso della persona;
  - **sampling** (chiamate LLM richieste dal server) con rate limit, cap token, timeout
    e metriche per server, disattivabile;
  - risultati **sanificati** (caratteri Unicode TAG invisibili = canale di prompt
    injection → rimossi);
  - ambiente stdio **limitato** alle variabili dichiarate + baseline sicura (nessuna
    copia dell'ambiente shell); segreti solo in `.env` dedicato;
  - OAuth scrive token/config solo **dopo** la prima connessione riuscita.
- **Catalogo curato** (`hermes mcp`): install con checklist per tool e fiducia basata
  su revisione; test di connessione (`hermes mcp test`, exit code verificabili);
  `/reload-mcp` in sessione.

## 2. Skill in Hermes — il modello

**Cos'è**: «memoria procedurale» — documenti markdown on-demand che l'agente carica
quando servono. Standard aperto [agentskills.io](https://agentskills.io)
(progressive disclosure).

**Formato**: directory con `SKILL.md` + `references/`, `templates/`, `scripts/`,
`examples/`, `assets/`. Frontmatter: `name`, `description` (≤60 caratteri, test
enforced), `version`, `author`, `platforms` (gating OS), **attivazione condizionale**
(`requires_tools` / `fallback_for_toolsets`: il tool appare solo se mancano certi
toolset), `required_environment_variables` (chiede i segreti al primo uso),
`metadata.hermes.config` (impostazioni non-segrete in config.yaml). Corpo con sezioni
standard: When to Use, Procedure, Pitfalls, Verification.

**Caricamento progressivo (3 livelli)** — la chiave dei costi-token:
- L0 `skills_list()` → nome/descrizione/categoria (~3k token per tutto il catalogo);
- L1 `skill_view(name)` → SKILL.md completo;
- L2 `skill_view(name, path)` → un singolo file di riferimento.

**Trigger**: ogni skill è un comando slash (`/gif-search ...`, fino a 5 impilabili) **o**
scoperta in linguaggio naturale via `skills_list`. Bundle (`skill-bundles/*.yaml`)
raggruppano skill sotto un comando.

**Creazione e apprendimento**:
- `/learn` trasforma materiale (URL, directory, conversazioni, note) in skill; i sorgenti
  grandi diventano *knowledge-base skill*: SKILL.md snello con indice + capitoli
  distillati in `references/`;
- **`skill_manage`** = strumento dell'agente stesso (create/patch/delete/write_file):
  registra una procedura quando ha capito qualcosa di riutilizzabile o è stato corretto.
  Linter consulenziale (corpo ~24k caratteri max, sprawl dei riferimenti, forma
  dell'incident log).

**Supervisione** (di nuovo il punto per Homun):
- `skills.write_approval: true` → **ogni scrittura dell'agente finisce in staging**
  (`~/.hermes/pending/skills/`) e si approva con `/skills pending|diff|approve|reject`;
  gli staging sopravvivono ai riavvii;
- scan di sicurezza su ogni install (esfiltrazione, prompt injection, comandi
  distruttivi): i verdetti «dangerous» **non** si possono forzare con `--force`;
  skill project-local richiedono `hermes skills trust` esplicito, altrimenti quarantena;
- **curatore automatico** (`agent/curator.py`): traccia l'uso (`.usage.json`), archivia
  le skill stantie (mai cancella: «archive is the maximum», ripristinabili), pin per
  esentarle. Tocca **solo** le skill create dall'agente, mai le bundled.

**Versioning/condivisione**: manifest con hash (le modifiche locali non vengono mai
sovrascritte dagli aggiornamenti), hub con drift detection, publish su GitHub,
trust `builtin > official > trusted > community`.

## 3. Traduzione per Homun (mappe, non copia)

I tre principi trasferibili sono esattamente i tre pilastri di Homun:

1. **Dichiarazione esplicita + superficie minima** — MCP come grant: il titolare
   dichiara il server (nome, trasporto, credenziali in secret store) e **l'allowlist
   degli strumenti**; il collegamento è per-collaboratore (come già
   `preferred_connection_id` e `capabilities`), mai globale di default. L'errore
   «plugin attivati in silenzio» che avevamo promesso di evitare nelle Impostazioni
   resta la regola.
2. **Esecuzione supervisionata** — gli strumenti MCP diventano capacità del registro:
   il tool esterno entra nel vocabolario `capabilities` del motore con la stessa
   grammatica (proposta → approvazione della persona → esecuzione → revisione).
   L'elicitation e il sampling di Hermes confermano il pattern: anche il *server*
   può chiedere, ma la risposta passa dall'approvazione della persona con limiti
   (rate/cap) dichiarati.
3. **Skill come memoria procedurale supervisionata** — markdown con frontmatter,
   caricamento progressivo (indice economico → contenuto su domanda), e **staging
   obbligatorio** per ciò che l'agente scrive: combacia con la nostra regola
   «l'agente propone, la persona conferma». Un campo `requires_capabilities`
   (l'analogo di `requires_tools`) lega la skill alle capacità reali del registro.

Differenze da rispettare: Homun è multi-agente con lavori/fasi (non un unico chat
loop) → MCP va legato al **lavoro/fase** (una fase può dichiarare lo strumento
esterno che userà, nell'accordo), e le skill vivono per **collaboratore** (il suo
metodo di lavoro) oltre che per spazio.

## 4. Fetta proponibile per Homun (da validare)

1. **Registro connessioni MCP** nel motore (server dichiarati: trasporto stdio/HTTP,
   credenziali nel secret store esistente, `tools.include/exclude`) + sezione
   Impostazioni «Plugin e capacità» che finalmente elenca connessioni reali.
2. **Capacità esterna**: una capability del registro che wrapping un tool MCP;
   assegnabile ai collaboratori e alle fasi come oggi `compare_csv`/`read_material`;
   esecuzione con la stessa pipeline supervisionata (approvazione → esecuzione →
   revisione).
3. **Skill v1**: markdown + frontmatter nel motore, indice L0 sempre economico,
   `skill_view` come capacità di lettura, creazione da chat («salva come procedura»)
   con staging obbligatorio e approvazione esplicita.
