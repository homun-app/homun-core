# Decision 0023: Sandbox enforcement a 3 livelli + approval policy unica — al chokepoint di esecuzione tool

Date: 2026-07-02

## Status

**Accepted — implementazione in corso.** Aggiornamento **2026-07-03**: l'**asse sandbox** è implementato e
validato eseguendo (macOS Seatbelt + Linux Landlock via CI). Esiste UNA sorgente di risoluzione
`resolved_sandbox_mode()` (precedenza env > `RuntimeSettings.sandbox_mode` persistito > default `danger`), onorata
da **tutti i tool effettful**: `run_in_project` (bash) costruisce la policy dal resolver (`read-only` reale),
e `write_file`/`edit_file` sono gated al chokepoint (`read-only` → escalation card che riesegue project-jailed su
approvazione, con gate provenance anti-RCE). Default `danger` = behavior-preserving finché il flip non è deciso.
**Pendenti:** Settings UI (asse **approval** + esporre il mode, poi flip del default a `workspace-write`), Windows
(approval-only), skill confirmation policies (Step 5), network-off opzionale. Spec+piano:
[specs/2026-07-03-sandbox-policy-resolution-design.md](../superpowers/specs/2026-07-03-sandbox-policy-resolution-design.md).

Definisce il **Pilastro 1 di P1** ([confronto-codex-produzione.md](../confronto-codex-produzione.md) §3):
portare l'esecuzione dei tool (shell, filesystem, processi) da un modello **cooperativo**
(il modello *chiede* il permesso) a un modello **enforced** (il processo *non può* uscire dal
recinto), con una **policy di approvazione unica** al posto dei gate sparsi per-capability.

**Dipende da** una decisione architetturale più grande: **il punto di enforcement non esiste ancora**.
Oggi l'esecuzione di comandi è sparsa su almeno tre siti (`crates/capabilities/src/mcp.rs`,
`crates/process-manager/src/supervisor.rs`, `crates/desktop-gateway/src/sandbox.rs`). Un recinto
richiede **un chokepoint unico** "esegui questo tool" — che è esattamente ciò che la separazione
motore/gateway (in discussione attorno a [0021](0021-single-guarded-loop-planning-as-tool.md) e
[0022](0022-memory-as-out-of-path-service.md)) produce. Quindi questa decisione **si progetta e si
implementa CON quella separazione, non prima** (caposaldo #5: convergere, non duplicare; imporre il
recinto ora su un percorso che sta per cambiare = rifarlo).

## Perché questa decisione esiste

Homun è, per costruzione, un agente che esegue azioni sulla macchina dell'utente: comandi shell,
scritture su file, processi sidecar, browser. Oggi il recinto è **il giudizio del modello**:
`crates/task-runtime/src/approval.rs` (richiesta → card UI → approva/nega, con resume server-side) e
`crates/capabilities/src/policy.rs` (`CapabilityPolicy::tool_access`, deny-by-default su Composio)
sono seri, ma cooperativi. Se il modello — per bug, per prompt injection, per una skill di terze
parti malevola — decide di eseguire un comando distruttivo **senza chiedere**, niente a livello di
processo lo impedisce: la shell eredita i permessi pieni dell'utente.

**Prova dal codice (2026-07-02):** non esiste alcuna primitiva OS di sandboxing nel workspace
(nessun `sandbox-exec`/Seatbelt, Landlock, seccomp). L'unica "sandbox" è `desktop-gateway/src/sandbox.rs`,
che è la **contained-computer basata su Docker** per il browser/computer-use — *non* un recinto per
l'esecuzione generica di shell/file. E i siti di esecuzione sono **molteplici e non convergenti**, il
che rende impossibile imporre oggi un recinto in un solo punto.

Il benchmark (Codex) risolve questo con due assi ortogonali, ormai **vocabolario condiviso del settore**
(Codex, Claude Code, ZCode convergono sui 3 livelli): una **sandbox mode** che vincola cosa il processo
*può fisicamente fare*, e una **approval policy** che decide *quando fermarsi a chiedere*.

## La decisione

### Due assi ortogonali

**Asse 1 — Sandbox mode (enforcement del kernel), per sessione/workspace:**

| Livello | Semantica |
|---|---|
| `read-only` | legge ovunque consentito, **nessuna** scrittura fuori da tmp scratch |
| `workspace-write` | scrive **solo** sotto la root del workspace attivo + tmp; niente rete non locale |
| `danger-full-access` | nessun recinto — **scelta esplicita** dell'utente, mai default |

**Asse 2 — Approval policy (quando chiedere), configurabile e mostrata in Settings:**

| Policy | Comportamento |
|---|---|
| `untrusted` | chiede per tutto tranne una allowlist di comandi noti-sicuri |
| `on-failure` | esegue in sandbox; chiede solo se un comando fallisce e vorrebbe più privilegi |
| `on-request` | il modello chiede quando ritiene di averne bisogno |
| `never` | non chiede mai (run autonome; presuppone una sandbox stretta) |

I due assi sono **indipendenti**: la sandbox è il recinto fisico, l'approval è l'UX. Oggi Homun li
**mescola** in gate sparsi per-capability; qui li separa in *un recinto imposto al chokepoint* + *una
policy unica leggibile, testabile, mostrabile*.

### Meccanismo — ibrido e tier-adattivo (NON "copia Codex")

Per un'app **local-first** il cui valore è girare sulla macchina dell'utente senza attriti, la scelta
SOTA non è né "solo primitive OS" né "solo container", ma **ibrida**:

1. **Primitive OS native come recinto di default** per il caso comune (shell/file):
   - **macOS**: Seatbelt via `sandbox-exec` con profilo generato dal livello (`workspace-write` =
     scrivi solo sotto workspace root + tmp). È l'API che usa Codex; deprecata ma funzionante.
   - **Linux**: **Landlock** (kernel ≥5.13, filesystem sandboxing *unprivileged*) + **seccomp-bpf**
     per il filtro syscall. Nessun privilegio di root, nessun container.
   - **Windows**: inizialmente **approval-only** (nessun enforcement OS affidabile lightweight);
     AppContainer/Job Objects come follow-up.
2. **Riuso del container esistente** (`desktop-gateway/src/sandbox.rs`, contained-computer) **solo**
   per l'esecuzione di codice davvero non fidato (skill di terze parti, codice generato da eseguire).
   Isolamento più forte, dipendenza (Docker) già presente, ma pesante → non per il caso comune.

Questa gradazione è coerente col caposaldo #2 (l'harness possiede il control-flow e deve reggere sul
tier locale) e con l'infrastruttura che Homun **ha già** (il container), evitando di introdurre un
secondo meccanismo dove il primo basta.

### Il chokepoint (dove il recinto vive)

Il recinto si impone in **un solo punto**: la funzione canonica che il gateway/motore invoca per
eseguire un tool (`CapabilityFacade::call_tool` o il suo successore dopo la separazione). Prima di
`spawn`, quel punto:
1. risolve il livello sandbox effettivo (sessione/workspace + override utente);
2. avvolge l'esecuzione nel recinto OS del livello (o la instrada al container);
3. consulta l'approval policy: se richiede conferma, sospende via il flusso `approval.rs` esistente.

**Questo punto non esiste ancora come chokepoint unico** — ed è la ragione del vincolo di sequenza.

## Alternative considerate

- **Solo container (Docker/microVM per ogni tool).** Isolamento massimo (gVisor/Firecracker sono lo
  SOTA per codice non fidato), ma **troppo pesante** per il caso comune di un'app desktop local-first
  (latenza di avvio, dipendenza forte). Tenuto **solo** per il codice non fidato. Respinto come default.
- **Solo approval cooperativo (status quo).** È ciò che Homun ha: buono come UX, **insufficiente** come
  sicurezza (nessun enforcement). Respinto come unica linea di difesa.
- **Gate per-capability sparsi (status quo esteso).** Quello che c'è: gate impliciti in più punti →
  non leggibile, non testabile come policy, e senza recinto fisico. Respinto: la policy deve essere
  **una**, dichiarata.
- **Imporre il recinto ora, sul gateway monolitico.** Respinto per caposaldo #5: i siti di esecuzione
  sono sparsi e la separazione motore sta per crearne il chokepoint unico — farlo ora = farlo due volte.

## Conseguenze

- **Positivo:** un comando non può uscire dal recinto anche se il modello sbaglia o è manipolato; la
  policy di approvazione diventa un artefatto unico, leggibile e testabile, mostrabile in Settings; le
  skill possono dichiarare *confirmation policies* dichiarative (categorie sensibili: delete, financial,
  medical, sensitive-data — il pattern SKILL.md di Codex) che l'harness rispetta senza fidarsi del modello.
- **Costo:** manutenzione per-OS (tre implementazioni del recinto); Seatbelt è deprecato (rischio futuro);
  Windows resta scoperto all'inizio (solo approval).
- **Invarianti:** default **mai** `danger-full-access`; il livello è di **codice**, non inferito dal
  modello (caposaldo #2/#6); local-first e privacy preservati (caposaldo #3) — il recinto è locale, non
  richiede cloud.
- **Limite onesto — MCP/Composio (documentato, non finto enforcement):** l'asse sandbox **non recinta** i tool
  MCP/Composio. Sono processi esterni / chiamate di rete, non sottoprocessi che il gateway spawna sotto il fence
  OS (identico a Codex: gli MCP server girano non-sandboxati). Il loro gate è l'**asse approval** (già cablato via
  `emit_approval_card`). Sotto `read-only` un tool MCP/Composio effettful resta gated dall'approval, non dal
  sandbox: non lo classifichiamo (footprint arbitrario) e **non fingiamo** un recinto che non c'è.

## Sequenza (come si lega alla separazione motore)

1. **Prerequisito:** la separazione motore/gateway crea il chokepoint unico "esegui tool".
2. **Poi:** `SandboxMode` enum + risoluzione livello al chokepoint (behavior-preserving a `danger-full-access`
   dietro flag, per non cambiare comportamento finché non validato).
3. **Poi:** recinto OS per livello (macOS Seatbelt → Linux Landlock+seccomp → Windows approval-only).
4. **Poi:** approval policy unica a 4 livelli, sostituendo i gate per-capability, con UI in Settings.
5. **Infine:** confirmation policies dichiarative nelle skill.

## Domande aperte

- **Rete:** `workspace-write` deve bloccare la rete non-locale? Il gateway parla col modello cloud
  (scelta utente) — il recinto va sul *tool*, non sul gateway, ma la linea va tracciata con cura.
- **Seatbelt deprecato:** quanto reggerà? Serve un piano B su macOS (Endpoint Security? App Sandbox
  entitlements?) prima che Apple lo rimuova.
- **Granularità del workspace:** il "workspace root" per `workspace-write` coincide con la `@ linked
  folder` della chat, o è più ampio? Va allineato allo scoping memoria (workspace_id).
- **Interazione con la contained-computer:** il browser gira già in container; il recinto shell/file è
  un secondo meccanismo — vanno tenuti concettualmente distinti (uno isola il computer-use, l'altro
  l'esecuzione di tool locali) o unificati?
