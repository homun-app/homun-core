// Tipi condivisi tra main, preload e renderer (rispecchiano il modello del Grok Bot originale)

import type { SkillCatalogEntry } from './skill-catalog'
export type { SkillCatalogEntry } from './skill-catalog'

export type AgentStatus = 'offline' | 'idle' | 'thinking' | 'running' | 'paused-for-approval'

// ---- fase 16: aspetto della mascotte (le 5 famiglie scelte, 7 colori) ----

/** Le 5 famiglie di mascotte portate dal design Lovable (le 4 d'archivio no). */
export type BotFamily = 'h-creature' | 'h-robo' | 'h-device' | 'jelly' | 'pixel'

/** I colori della mascotte come TOKEN ('c3' → var(--bot-c3)): mai nomi CSS nel db. */
export type BotColor = 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7'

/** L'aspetto di un bot (JSON nella colonna agents.avatar; NULL = predefinito). */
export interface AgentAvatar {
  family: BotFamily
  color: BotColor
}

export interface Agent {
  id: string
  name: string
  description: string
  providerId: string | null
  model: string | null
  status: AgentStatus
  unread: number
  createdAt: number
  /** fase 10: id dell'agente CREATORE (null = creato dall'utente/onboarding) */
  createdBy?: string | null
  /** fase 10: sezione della sidebar in cui raggruppare il bot (testo libero) */
  section?: string | null
  /** fase 12: il padre, se questa riga è un SOTTOAGENTE (bot figlio nascosto) */
  parentId?: string | null
  /** fase 16: aspetto scelto dall'utente (NULL = predefinito da hash dell'id) */
  avatar?: AgentAvatar | null
  /**
   * Fase 18b (H3): livello di ragionamento del bot. 'default' (o assente) =
   * il comportamento della 18a ESATTO; l'adattatore clampa sul modello vero.
   */
  thinking?: ThinkingSetting | null
}

export type EntryKind =
  | 'message'        // messaggio user o assistant (formato pre-fase 3)
  | 'thinking'       // testo libero generato dal modello: NON arriva all'utente, nascosto di default (toggle "mostra ragionamento")
  | 'send-message'   // messaggio del bot all'utente (message.type: text | widget | draft) — nasce SOLO da tool
  | 'tool-call'      // chiamata tool richiesta dal modello
  | 'tool-result'    // esito del tool
  | 'notice'         // nota di sistema (permesso negato, ecc.)
  | 'approval'       // card di approvazione
  | 'event'          // evento (cambio stato, interrupt, fine turno con meta.turnEnd)
  | 'summary'        // fase 4: riepilogo dei turni più vecchi (compaction), visibile solo col toggle ragionamento

/** Esito di fine turno (come GrokBotTaskListTurnEnd + awaiting_user dell'originale). */
export type TurnEnd = 'FINISHED' | 'STOPPED' | 'SUPERSEDED' | 'AWAITING_USER'

// ---- payload dei messaggi del bot (entry kind 'send-message', in meta.message) ----

export interface WidgetOption {
  label: string
  value: string
  description?: string
  style?: 'primary' | 'default'
}

/** Il tool di invio associato a una bozza: eseguito SOLO al click dell'utente. */
export interface DraftVia {
  tool: string
  args: Record<string, unknown>
}

/**
 * Review fase 3 (D1): quali argomenti di via.args alimentano i campi visibili
 * to/subject/body della card (es. { to: 'to', subject: 'subject', body: 'text' }).
 * Unica fonte di verità: via.args, ciò che verrà davvero inviato.
 */
export interface DraftFieldMap {
  to?: string
  subject?: string
  body?: string
}

/** Review fase 3 (D1): argomento di via.args non mappato sui campi visibili, mostrato in "Altri parametri". */
export interface DraftExtraArg {
  key: string
  value: string
}

/**
 * Fase 0.3.1001 (M1): perché una bozza è senza via — riga visibile nella
 * card, così l'utente lo scopre subito e non al clic su Invia.
 */
export type DraftSendHint = 'no-tool' | 'pick' | 'missing-required'

export type SendMessagePayload =
  | { type: 'text'; text: string; urgent?: boolean }
  | {
      type: 'widget'
      prompt: string
      helpText?: string
      options: WidgetOption[]
      multiSelect?: boolean
      allowCustom?: boolean
      dismissOnMoveOn?: boolean
    }
  | {
      type: 'draft'
      channel: 'email' | 'slack' | 'other'
      to: string
      subject?: string
      body: string
      via?: DraftVia
      /** D1: mappa campo visibile → argomento di via.args (calcolata alla creazione) */
      fieldMap?: DraftFieldMap
      /** D1: argomenti di via.args non coperti dalla fieldMap — sempre visibili in card ("Altri parametri") */
      extraArgs?: DraftExtraArg[]
      /** D1: true se nessun argomento è mappato sul corpo: modifica del testo disabilitata, argomenti grezzi */
      bodyLocked?: true
      /** M1: la bozza non ha una via e questo è il motivo (riga visibile in card) */
      sendHint?: DraftSendHint
    }
  | {
      /** fase 5: offerta di connessione (funnel §3ter T2-T3) — il bottone "Connetti" è dell'utente */
      type: 'connector'
      connectorId: string
      name: string
      reason?: string
    }
  | {
      /** fase 8 (§3bis L7): apertura di un task thread — card nella chat principale */
      type: 'task'
      taskId: number
      title: string
    }
  | {
      /** fase 8 (§3bis L5): regola di auto-review proposta dall'agente — si salva SOLO al click dell'utente */
      type: 'rule'
      kind: 'allow' | 'block'
      text: string
      why?: string
    }
  | {
      /**
       * Fase 13 (punto 2): proposta di aggiungere un server MCP del registro
       * (o un URL). Tutto in codice tranne `reason`; l'installazione parte
       * SOLO dal click su Aggiungi (mai "sempre").
       */
      type: 'mcp-server'
      /** registry:<nome> oppure url:https://… */
      id: string
      name: string
      /** fase mcp-setup (M2): il nome tecnico del registro (piccolo e grigio nel dettaglio) */
      technicalName?: string
      publisher?: string
      /** fase mcp-setup (M2): icona data: del registro, se c'è (nessuna fetch nuova) */
      logo?: string
      /** fase mcp-setup (M4): l'id del server creato dall'installazione (lo stato si legge da lui) */
      serverId?: string
      /** label di fiducia per il modello (inglese); la UI traduce da trustKind */
      trust: string
      trustKind: 'verified-domain' | 'github-account' | 'unverified'
      /** il dettaglio del kind (dominio verificato o utente GitHub) */
      trustDetail?: string
      siteUrl?: string
      runtime: { kind: 'remote'; host: string } | { kind: 'box-npm'; command: string }
      needs:
        | { kind: 'oauth' }
        | { kind: 'key'; header: string }
        | { kind: 'env'; vars: Array<{ name: string; required: boolean; description?: string }> }
      /**
       * fase mcp-setup (M1/M3): il modulo che la card diventa dopo «Aggiungi»
       * (variabili dell'URL e accesso). Solo i server del registro col remote.
       */
      setup?: {
        urlVariables: Array<{
          name: string
          description?: string
          placeholder?: string
          isRequired: boolean
          isSecret: boolean
          default?: string
        }>
        auth: 'oauth' | 'headers'
        /** fase mcp-setup ritocchi (R6): il template dell'URL — il ruolo di ogni variabile (etichetta e validazione) nasce dalla POSIZIONE, non dal nome */
        urlTemplate?: string
        /** l'header col token facoltativo/obbligatorio (template + variabile segreta) */
        tokenHeader?: {
          name: string
          valueTemplate: string
          description?: string
          variable: string
          variableDescription?: string
        }
      }
      /** fiducia ≠ dominio verificato: l'avviso che il server è di terzi */
      thirdPartyWarning?: true
      /** proposta nata in un turno contaminato: avviso in cima alla card */
      untrusted?: true
      /**
       * modalità host: il server stdio non si installa, bottone disattivato.
       * Fase 17c: CODICE (es. 'host-mode') — la UI lo traduce
       */
      disabledReason?: string
      reason?: string
    }
  | {
      /**
       * Fase 13 (punto 4): proposta di installare un plugin di un marketplace
       * (formato Claude Code). L'installazione parte SOLO dal click su
       * Installa; hook/bin/monitor/LSP non si importano MAI (elenco "ignored").
       */
      type: 'plugin'
      /** plugin:<nome>@<marketplace> */
      id: string
      name: string
      marketplace: string
      trust: string
      /** fase 17c (C5): true = marketplace ufficiale — la UI traduce la fiducia da qui */
      official?: boolean
      repoUrl?: string
      /** i primi 12 caratteri dello sha effettivo */
      sha12: string
      skills: string[]
      /** fase 17c (C5): codice del runtime del server (la UI traduce); runtimeDetail = host o comando */
      servers: Array<{ name: string; runtimeKind: 'unsupported' | 'remote' | 'box'; runtimeDetail: string; runtimeLabel?: string }>
      settings: Array<{ key: string; description?: string; sensitive?: boolean }>
      /** componenti presenti ma NON importate (non girano in SandBot) */
      ignored: string[]
      untrusted?: true
      reason?: string
    }
  | {
      /** fase 12 (punto 2): card del sottoagente lanciato — l'unica riga del figlio nella chat del padre */
      type: 'subagent'
      subagentId: string
      title: string
    }
  | {
      /** fase 14 (punto 2): card del documento salvato in libreria, col bottone Apri */
      type: 'document'
      id: string
      title: string
      version: number
    }
  | {
      /** fase 14 (punto 3): card del grafico salvato in libreria */
      type: 'chart'
      id: string
      title: string
    }
  | {
      /**
       * Fase 14 (punto 7d): card del fill di un login — "Compilo il login
       * «label» su origin?". Consenti = per questo turno; Sempre per questo
       * sito = concessione (loginId, origin) revocabile; Nega.
       */
      type: 'fill'
      /** id del login nel vault */
      id: string
      label: string
      origin: string
      /** quali campi verranno compilati (username/password/totp) */
      fields: string[]
    }
  | {
      /**
       * Fase 14 (punto 7e): modulo sicuro — l'utente compila un dato sensibile
       * che NON passa dalla chat (campi di tipo password, salvati via RPC nel
       * vault). Il modello riceve solo l'esito.
       */
      type: 'secure-input'
      kind: 'login' | 'secret'
      /** login: etichetta; secret: nome proposto (modificabile) */
      label?: string
      name?: string
      /** login: origine precompilata e modificabile */
      origin?: string
      reason: string
      /** P5 (fase 14 correzioni): richiesta nata in un turno contaminato — la UI avvisa di controllare l'origine */
      untrusted?: true
    }
  | {
      /** fase 14 (punto 7f): card di conferma del contatto che il bot vuole salvare */
      type: 'contact'
      name: string
      emails: string[]
      phones: string[]
      address?: string
      notes?: string
      /** proposta nata in un turno contaminato: avviso in card */
      untrusted?: true
    }
  | {
      /**
       * Fase 19a (V5): il bot chiede all'utente di prendere il controllo del
       * SUO schermo (login, 2FA, CAPTCHA, pagamento). Il turno finisce in
       * attesa; il bottone «Apri lo schermo» apre il pannello già in controllo
       * e «Ho finito» (screen:release) riapre il turno del bot.
       */
      type: 'takeover-request'
      /** il motivo breve scritto dal bot (dato, mostrato com'è) */
      reason: string
    }

/**
 * meta di una entry 'send-message':
 * - call: la tool-call che l'ha prodotta (per ricostruire la storia del modello)
 * - message: il payload (text | widget | draft)
 * - respondedValue / widgetDismissed: stato del widget dopo l'azione dell'utente
 * - status: per le bozze, 'pending' → 'sent' | 'discarded' | 'error'
 * - fallback: true se il testo è il recupero di un turno senza send_to_user
 */
export interface SendMessageMeta {
  call?: { id: string; name: string; arguments: string }
  message: SendMessagePayload
  respondedValue?: string | string[]
  widgetDismissed?: boolean
  status?: 'pending' | 'sent' | 'discarded' | 'error'
  fallback?: boolean
  /** fase 6: true finché il messaggio è trattenuto nell'outbox (consegna alla finestra) */
  held?: boolean
  /**
   * Fase 7 (correzione A2): delega send_to_agent — entry visibile nella chat
   * del MITTENTE come "A <nome bot>", con destinatario e hop del messaggio.
   */
  toAgentId?: string
  toAgentName?: string
  hop?: number
  agentSend?: boolean
  /**
   * Fase 8 (§3bis L5): l'azione è stata approvata/inviata dall'auto-review
   * con una regola dell'utente (approvazioni e bozze auto-inviate).
   */
  autoApproved?: boolean
  ruleMatched?: string
  /**
   * R2 (fase app — ritocchi): l'esito dell'invio di una bozza (output dello
   * strumento, troncato a 2 KB e ripulito) — si vede nei «Dettagli» della
   * card, mai come notice né JSON grezzo in chat.
   */
  sendResult?: string
  reason?: string
  /** fase 8: esito della regola proposta dall'agente (aggiunta o scartata dall'utente) */
  ruleStatus?: 'added' | 'dismissed'
  /** fase 8 (§3bis L7): l'entry appartiene al sotto-transcript di questo task */
  taskId?: number
  /**
   * Fase 19a (V5): stato della card takeover-request — 'pending' alla
   * richiesta, 'done' quando l'utente ha finito, 'expired' dopo 30 minuti.
   */
  takeover?: 'pending' | 'done' | 'expired'
  /**
   * Fase Composio OAuth (C5): la chiave del link di collegamento di una card
   * «Collega <app> tramite Composio» — il clic dell'utente la apre nel
   * browser e il daemon aspetta il login (WAIT_FOR_CONNECTIONS).
   */
  gatewayKey?: string
  /**
   * Fase risposta (R1): la entry È la risposta finale del turno (il testo
   * della chiamata senza strumenti, promosso da thinking a send-message).
   */
  final?: boolean
  /**
   * Fase risposta (R9): il result ESATTO che il modello ha visto per la
   * consegna di questa entry (message_user: tetto dei 500 caratteri
   * dichiarato) — la storia lo ricostruisce identico.
   */
  resultText?: string
}

export interface TranscriptEntry {
  id: number
  agentId: string
  kind: EntryKind
  role: 'user' | 'assistant' | 'system'
  content: string
  meta: Record<string, unknown> | null
  createdAt: number
}

/**
 * Fase 17c (C1): un testo della UI salvato o prodotto dal daemon/main, come
 * codice stabile + valori (lo stato dell'arte di Slack/Discord e ICU: chi
 * mostra il testo lo traduce col catalogo, così la storia cambia lingua con
 * l'utente). I valori sono SOLO stringhe e numeri; un valore che è a sua
 * volta testo da tradurre si scrive come `select` su un codice o come id
 * separato. I testi esterni (errori di provider, output di tool) entrano
 * come valori, invariati.
 */
export interface UiText {
  id: string
  values?: Record<string, string | number>
}

/**
 * Fase 17c (C5): un campo bilingue dei dati statici (catalogo connettori,
 * template). La forma stringa resta valida (dati preesistenti e nomi propri
 * che non si traducono): pickLang la sceglie.
 */
export type Localized = string | { it: string; en: string }

// ---- Provider / modelli personalizzati ----
export type ProviderKind =
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'openai'
  | 'anthropic'
  | 'mistral'
  | 'openrouter'
  | 'zai'
  | 'xai'
  | 'deepseek'
  | 'groq'
  | 'custom'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  enabled: boolean
  discovered?: boolean
}

/**
 * Fase 16c (C1): envelope cifrato della chiave API di un provider — a riposo
 * nel setting 'providers' c'è SOLO questo, mai il chiaro.
 */
export interface SealedKey {
  sandVault: 1
  data: string
}

/**
 * Fase 16c (C1): un provider come lo vede il RENDERER: `apiKey` sempre vuota,
 * `hasKey` dice se c'è una chiave e `keyHint` ne mostra gli ultimi 4 caratteri
 * («…a1b2»). Nessuna RPC restituisce mai la chiave intera.
 */
export type ProviderPublic = Omit<ProviderConfig, 'apiKey'> & {
  apiKey: ''
  hasKey: boolean
  keyHint?: string
}

/**
 * Fase 16c (C1): il salvataggio di un provider — `apiKey` vuota o assente
 * CONSERVA la chiave esistente; una chiave nuova la sostituisce; `clearKey`
 * la toglie.
 */
export type ProviderSaveInput = Omit<ProviderConfig, 'apiKey'> & {
  apiKey?: string
  clearKey?: boolean
}

/** Fase 16c (C3.4): l'esito di providers:probe — error è un CODICE leggibile, mai la chiave. */
export interface ProviderProbeResult {
  ok: boolean
  /** gli id dei modelli visti (solo quando ok) */
  models?: string[]
  /** 'invalid-key' | 'unreachable' | 'error' (solo quando !ok) */
  error?: string
}

/** Fase 16c (C3.3): il modello principale («il cervello dei bot»). Setting models.main. */
export interface MainModel {
  providerId: string
  model: string
  thinking?: ThinkingSetting | null
}

/**
 * Fase 18b (H3): il livello di ragionamento. 'default' = il comportamento
 * della 18a (nessuna opzione reasoning); 'off' è un livello valido di pi-ai.
 * In thinkingLevels di un modello NON compare mai 'default': è sempre disponibile.
 */
export type ThinkingSetting = 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Fase 18b (H5.1): una voce dell'elenco modelli — catalogo pi-ai, elenco vivo
 * del provider o entrambi. I campi sono OBBLIGATORI (null = sconosciuto).
 */
export interface ModelInfo {
  id: string
  label?: string
  /** da dove arriva la voce: catalogo pi-ai, elenco vivo del provider, entrambi */
  source: 'catalog' | 'live' | 'both'
  /** finestra di contesto in token (undefined = sconosciuta) */
  contextWindow?: number
  /** il modello ci vede (immagini)? null = sconosciuto */
  vision: boolean | null
  /** il modello usa i tool? null = sconosciuto */
  tools: boolean | null
  /** livelli di ragionamento controllabili ([] = non controllabile da noi) */
  thinkingLevels: ThinkingSetting[]
  /** prezzo in dollari per milione di token (null = sconosciuto/locale) */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  costSource: 'catalog' | 'custom' | null
  /** provider tutto locale (ollama, lmstudio…): costo nullo per definizione */
  local: boolean
}

/**
 * Fase 18b (H1.3): prezzo personalizzato di un modello, in DOLLARI PER
 * MILIONE DI TOKEN — la stessa unità del catalogo pi-ai (ModelCostRates:
 * "Input cost in USD per million tokens").
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Setting providers.modelPrices: Record<providerId, Record<modelId, prezzo>>. */
export type ModelPriceMap = Record<string, Record<string, ModelPrice>>

/**
 * Fase 18b (H1.2 → K3): le capacità di UN modello, come le vede il daemon.
 * Vive in shared perché la RPC models:capabilities la restituisce alla UI
 * (il tipo dell'adattatore pi-ai re-esporta questo). Senza prezzo
 * personalizzato: `cost`/`costSource` parlano solo del catalogo.
 */
export interface ModelCapabilities {
  contextWindow: number
  /** il modello ci vede? null = sconosciuta (sintetico senza cache Ollama) */
  vision: boolean | null
  reasoning: boolean
  /** il modello usa i tool? null = sconosciuto */
  tools: boolean | null
  /** livelli di ragionamento controllabili ([] = non controllabile da noi) */
  thinkingLevels: ThinkingSetting[]
  /** prezzo $/1M token (null = sconosciuto o locale) */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  costSource: 'catalog' | 'custom' | null
  fromCatalog: boolean
}

/** Fase 18b (H2.1): un anello della catena delle riserve. */
export interface FallbackRoute {
  providerId: string
  model: string
}

/** Fase 18b (H6.1): una riga aggregata di usage:summary. */
export interface ModelUsageRow {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** null solo se TUTTE le righe del gruppo hanno costo null */
  costUsd: number | null
  /** true se ALCUNE righe del gruppo hanno costo e altre no */
  costPartial: boolean
  /** chiave del gruppo: valorizzata secondo groupBy (stringa vuota se non è la chiave) */
  providerId: string
  providerKind: string
  model: string
  source: string
  /** solo groupBy 'agent': null per le chiamate senza bot (etichetta «Sistema») */
  agentId: string | null
  agentName: string | null
}

// ---- Permessi (replica del modello originale always_allow | needs_approval | blocked) ----
export type PermissionMode = 'always_allow' | 'needs_approval' | 'blocked'

export interface PermissionRule {
  tool: string          // nome tool o '*'
  pattern: string       // prefisso comando/percorso o '*'
  mode: PermissionMode
}

export interface PermissionsConfig {
  default: PermissionMode
  rules: PermissionRule[]
}

// ---- Approvazioni ----

/**
 * Fase impostazioni (I4): il modo delle approvazioni, la prima scelta della
 * pagina. 'ask' = la politica di oggi (card per ciò che cambia qualcosa);
 * 'auto' = l'auto-revisione di oggi (autoReview.enabled === true);
 * 'never' = ogni ask del gate parte, tranne le esclusioni fisse (vedi
 * neverAskDecision in auto-review.ts). Setting approvals.mode.
 */
export type ApprovalsMode = 'ask' | 'auto' | 'never'

export interface Approval {
  id: string
  agentId: string
  tool: string
  input: Record<string, unknown>
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  createdAt: number
}

// ---- Eventi main → renderer ----
export type SandbotEvent =
  | { type: 'entries'; agentId: string; entries: TranscriptEntry[] }
  | { type: 'delta'; agentId: string; entryId: number; text: string; reasoning?: boolean }
  // fase risposta (R6): la risposta in diretta dei turni in chat privata — il
  // testo accumulato della chiamata in corso (text '' = fine della diretta:
  // consegnata come risposta o tornata riga di lavoro)
  | { type: 'live-reply'; agentId: string; entryId: number; text: string }
  | { type: 'status'; agentId: string; status: AgentStatus }
  | { type: 'agents' }
  | { type: 'approval'; agentId: string; approval: Approval }
  | { type: 'open-agent'; agentId: string }
  // residuo fase 4 (0b): il client del daemon si è RICONNESSO dopo una
  // disconnessione — la UI ricarica agenti ed entry (il transcript può essere
  // cambiato mentre eravamo sconnessi)
  | { type: 'reconnected' }
  // fase 5: lo stato di un connettore è cambiato (connesso, needs_auth, …) —
  // la vista "Connetti app" ricarica il catalogo
  | { type: 'connectors' }
  // fase 6 (§3bis L9): il turno è finito con un messaggio visibile (done) o
  // l'agente aspetta l'utente (needs-input: ask_user, approval, bozza) — la
  // decisione se notificare (soppressioni) sta nel daemon.
  // fase 16b (S1.2): openGroupId dice che il click apre la SQUADRA, non la
  // chat privata del bot (riepilogo del coordinatore pubblicato nel gruppo)
  | { type: 'agent-notify'; agentId: string; kind: 'done' | 'needs-input'; preview: string; at: number; openGroupId?: number }
  // fase 16b (S1.2/S5): apri la squadra (notifica del riepilogo, deep link)
  | { type: 'open-group'; groupId: number }
  // fase 8 (§3bis L7): lo stato di un task è cambiato — la card in chat e la
  // sidebar (task in corso) si aggiornano
  | { type: 'tasks' }
  // fase 8 (§3bis L7): stato live — quale tool sta girando nel turno dell'agente
  // V5 (prova vera): app = nome umano del server MCP, args = i SOLI NOMI
  // delle azioni degli strumenti meta di Composio (mai i valori)
  | { type: 'activity'; agentId: string; activity: { tool: string; target: string; app?: string; args?: string } | null }
  // fase 10: i messaggi o i membri di un gruppo sono cambiati (sidebar + vista gruppo)
  | { type: 'groups' }
  // fase 12: lo stato di un sottoagente di questo padre è cambiato (card + pannello)
  | { type: 'subagents'; parentId: string }
  // fase 19a (V3.4): lo stato dello SCHERMO di un bot è cambiato (browser
  // aperto/chiuso, controllo attivo, richiesta di presa di controllo in attesa)
  | { type: 'screen'; agentId: string; status: ScreenStatus }
  // fase 19b (T4.1): una nuova riga di computer_actions o un cambio di stato
  // di shell_jobs — il feed «Attività» e la vista File del PROPRIETARIO
  // ricaricano (niente payload pesante: la UI legge quello che serve)
  | { type: 'computer-activity'; ownerId: string }

/** Lo stato dello schermo di un bot per la UI (fase 19a, RPC screen:status). */
export interface ScreenStatus {
  /** il browser principale del bot (col desktop) è attivo? */
  browser: 'running' | 'stopped'
  /** l'utente ha in questo momento il controllo dello schermo del bot */
  control: boolean
  /** richiesta di presa di controllo in attesa (scade dopo 30 minuti) */
  takeoverPending: { reason: string } | null
}

// ---- fase 19b (T3/T4): i file e l'attività del computer del bot ----

/** Una voce dell'elenco della vista File. */
export interface FileEntry {
  name: string
  kind: 'dir' | 'file' | 'link'
  size: number
  /** mtime in ms dall'epoch */
  mtime: number
}

/** Il risultato di files:list (path relativi alla radice del box). */
export interface FilesListResult {
  path: string
  entries: FileEntry[]
  truncated: boolean
  /** col path vuoto: la home del bot del pannello (la UI apre lì) */
  home?: string
}

/** Il risultato di files:read: anteprima testo, immagine, binario o troppo grande. */
export type FilesReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }

/** Il risultato di files:import (exists: la UI chiede «Sostituire?»). */
export type FilesImportResult =
  | { ok: true; name: string; bytes: number }
  | { ok: false; reason: 'exists'; name: string }

/** Una voce del feed «Attività» (fase 19b, T4.2). */
export interface ActivityItem {
  id: string
  source: 'shell' | 'action'
  agentId: string
  agentName: string
  actor: 'bot' | 'user'
  kind: 'shell' | 'write_file' | 'copy_in' | 'copy_out' | 'upload' | 'download'
  /** il comando o il path, troncato a 500 caratteri */
  text: string
  status: 'running' | 'done' | 'killed' | 'lost' | 'expired' | 'ok' | 'error'
  exitCode: number | null
  bytes: number | null
  startedAt: number
  finishedAt: number | null
}

export interface SandbotApi {
  // agenti e transcript
  listAgents(): Promise<Agent[]>
  createAgent(name: string, description?: string): Promise<Agent>
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model' | 'avatar' | 'thinking' | 'section'>>): Promise<void>
  deleteAgent(id: string): Promise<void>
  /** fase 7: imposta il bot principale (mainAgentId, unico) */
  setMainAgent(id: string): Promise<void>
  /** fase 7: catalogo dei template di bot */
  listTemplates(): Promise<TemplateInfo[]>
  /** fase 7: crea un bot da template e avvia il kickstart (job TEMPLATE_IMPORT) */
  createAgentFromTemplate(templateId: string): Promise<Agent>
  getEntries(agentId: string, afterId?: number): Promise<TranscriptEntry[]>
  sendMessage(agentId: string, text: string, images?: string[]): Promise<void>
  interrupt(agentId: string): Promise<void>
  // risposta a un widget ask_user (click su un'opzione o testo libero se allowCustom)
  widgetRespond(agentId: string, entryId: number, value: string | string[]): Promise<void>
  // azioni sulla bozza: Invia (esegue via.tool passando dal gate), Scarta, Modifica (persiste il body)
  draftSend(agentId: string, entryId: number, body?: string): Promise<void>
  draftDiscard(agentId: string, entryId: number): Promise<void>
  draftUpdate(agentId: string, entryId: number, body: string): Promise<void>
  // approvazioni
  /** fase 8: mode 'once' (una volta), 'always' (standing grant), 'turn' (fino a fine turno, in memoria) */
  resolveApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', mode: 'once' | 'always' | 'turn'): Promise<void>
  // provider e modelli
  /** fase 16c (C1): MAI la chiave — apiKey sempre '', hasKey e keyHint al posto */
  listProviders(): Promise<ProviderPublic[]>
  /** fase 16c (C1): apiKey vuota conserva la chiave, nuova la sostituisce, clearKey la toglie */
  saveProvider(p: ProviderSaveInput): Promise<void>
  deleteProvider(id: string): Promise<void>
  discoverProviders(): Promise<ProviderPublic[]>
  testProvider(id: string): Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }>
  /**
   * Fase 16c (C3.4): prova una configurazione NON salvata (stessa logica di
   * providers:test). La chiave viaggia SOLO in questa direzione: il daemon non
   * la salva, non la scrive nei log e non la rimanda indietro.
   * Correzioni (R2.3): `providerId` = prova di un provider GIÀ salvato senza
   * ridigitare la chiave — usa quella in memoria nel daemon (mai in risposta).
   */
  probeProvider(config: { kind: ProviderKind; baseUrl: string; apiKey?: string; providerId?: string }): Promise<ProviderProbeResult>
  listModels(providerId: string): Promise<ModelInfo[]>
  /**
   * Fase 18b (K3): le capacità di UN modello, SENZA l'elenco completo e senza
   * prezzo personalizzato. Nessuna rete per i provider di catalogo; per
   * ollama al massimo UNA /api/show (1500 ms) se la cache è vuota.
   */
  modelCapabilities(providerId: string, model: string): Promise<ModelCapabilities>
  /**
   * Fase 18b (H6): uso e costi aggregati in una finestra [fromMs, toMs]
   * facoltativa, per modello (default), bot o origine.
   */
  usageSummary(fromMs?: number, toMs?: number, groupBy?: 'model' | 'agent' | 'source'): Promise<ModelUsageRow[]>
  /** fase 11: chiave per la ricerca web del provider Ollama — SOLO nel vault sigillato */
  setWebSearchKey(providerId: string, key: string | null): Promise<void>
  webSearchKeySet(providerId: string): Promise<boolean>
  /** fase 15: stato di sola lettura dei provider di ricerca (S5) */
  webSearchStatus(): Promise<WebSearchStatusRpc>
  // permessi
  getPermissions(): Promise<PermissionsConfig>
  setPermissions(cfg: PermissionsConfig): Promise<void>
  /** M4 (fase 0.3.1001): le standing grant salvate («Consenti sempre» delle card) */
  grantsList(): Promise<Array<{ id: number; tool: string; target: string; createdAt: number; scope?: 'readOnly' | null }>>
  /** M4: revoca una standing grant da Impostazioni → Approvazioni */
  grantRevoke(id: number): Promise<{ ok: boolean }>
  /** M4: «Consenti sempre le letture di <server>» (grant mcp__<server>__* scope readOnly) */
  grantServerReads(slug: string): Promise<{ ok: boolean }>
  // impostazioni generiche (fase 6: fuso orario, finestre di consegna, assenza, notifiche)
  settingsGet<T>(key: string, fallback: T): Promise<T>
  settingsSet(key: string, value: unknown): Promise<void>
  // quick-ask (domanda effimera)
  quickAsk(agentId: string, question: string): Promise<string>
  // allegati
  pickImage(): Promise<string | null>
  // routine
  listRoutines(agentId?: string): Promise<RoutineInfo[]>
  createRoutine(agentId: string, title: string, prompt: string, schedule: string, model?: RoutineModelPatch): Promise<RoutineInfo>
  /** fase 6: creazione con trigger esteso (schedule every, email, calendar_event, webhook, connector_poll) */
  createRoutineTrigger(agentId: string, title: string, prompt: string, trigger: RoutineTrigger, timezone?: string, model?: RoutineModelPatch): Promise<RoutineInfo>
  /** fase 6: aggiorna trigger/ora/prompt (il trigger sostituisce la schedule); fase 18b (H7): anche il modello proprio */
  updateRoutineTrigger(id: number, patch: { title?: string; prompt?: string; enabled?: number; paused_for_away?: number; trigger?: RoutineTrigger | null; timezone?: string } & RoutineModelPatch): Promise<void>
  updateRoutine(id: number, patch: Partial<Pick<RoutineInfo, 'enabled' | 'schedule' | 'title' | 'prompt'>>): Promise<void>
  deleteRoutine(id: number): Promise<void>
  suggestRoutines(agentId: string): Promise<RoutineSuggestion[]>
  // fase 6: presenza (§3ter T2) — 'active' al massimo uno ogni 30s
  presenceSignal(kind: 'active' | 'typing'): Promise<void>
  presenceViewing(agentId: string | null): Promise<void>
  // fase 6: consegna dell'outbox quando l'utente apre la chat dell'agente
  outboxOpened(agentId: string): Promise<void>
  // fase 8 (§3bis L7): task thread — elenco (tutti gli agenti se undefined) e interruzione
  listTasks(agentId?: string): Promise<TaskInfo[]>
  cancelTask(taskId: number): Promise<void>
  // fase 8 (§3bis L5): decisione dell'utente sulla regola proposta dall'agente
  autoreviewRuleDecision(agentId: string, entryId: number, action: 'add' | 'dismiss'): Promise<void>
  // fase 10: gruppi (sidebar "Gruppi", vista gruppo, scrittura come utente)
  listGroups(): Promise<GroupInfo[]>
  groupMessages(groupId: number): Promise<GroupMessageInfo[]>
  groupSendUser(groupId: number, text: string): Promise<void>
  /**
   * Fase 16b (S1.3): squadre create e modificate dalla UI. La creazione è
   * dell'UTENTE (created_by 'user', niente card di approvazione); le regole
   * del coordinatore sono quelle di S1.1.
   */
  groupCreate(name: string, memberIds: string[], coordinatorId: string, description?: string): Promise<GroupInfo>
  /** Fase 16b (S1.3): nome, descrizione, membri e coordinatore (regole di S1.1). */
  groupUpdate(groupId: number, patch: {
    name?: string
    description?: string
    addMemberIds?: string[]
    removeMemberIds?: string[]
    coordinatorId?: string
  }): Promise<GroupInfo>
  /** Fase 16b (S1.3): cancella squadra e messaggi; i bot restano. */
  groupDelete(groupId: number): Promise<void>
  // fase 12: sottoagenti del padre (card + pannello) e bottone Ferma
  listSubagents(parentId: string): Promise<SubagentInfo[]>
  stopSubagent(id: string): Promise<void>
  /**
   * Fase 19a (V3): lo schermo del bot. screen:open avvia il browser (lazy) e
   * torna l'URL WebSocket con una capability MONOUSO (scade in 30 s); con
   * mode 'control' su bot occupato risponde rpcScreenBotBusy. screen:release
   * chiude il controllo (e riapre il turno se c'era una richiesta in attesa).
   */
  screenOpen(agentId: string, mode: 'view' | 'control'): Promise<{ url: string }>
  screenRelease(agentId: string, note?: string): Promise<{ ok: boolean }>
  screenStatus(agentId: string): Promise<ScreenStatus>
  /**
   * Fase 19b (T2): il terminale del bot (solo docker). terminal:open torna
   * l'URL WebSocket con una capability MONOUSO (30 s) per /term/<cap>; il
   * client incapsula l'input nei frame di shared/terminal-frames.
   */
  terminalOpen(agentId: string): Promise<{ url: string }>
  /** fase 19b (T3): l'elenco di una cartella del box (path relativo alla radice) */
  filesList(agentId: string, path: string): Promise<FilesListResult>
  /** fase 19b (T3): l'anteprima di un file (testo, immagine, binario, troppo grande) */
  filesRead(agentId: string, path: string): Promise<FilesReadResult>
  /**
   * Fase 19b (T3.2): il download sul Mac — il MAIN apre la finestra «Salva» e
   * poi chiama files:export del daemon col macPath scelto dall'utente. Il
   * renderer non vede né sceglie mai il path del Mac. null = annullato.
   */
  filesDownload(agentId: string, path: string): Promise<{ ok: boolean; name?: string; bytes?: number } | null>
  /**
   * Fase 19b (T3.2): l'upload dal Mac — il MAIN apre la finestra «Apri»
   * (anche più file) e chiama files:import per ciascuno; il «Sostituire?» di
   * un file che esiste già lo chiede il MAIN col dialog nativo.
   */
  filesUpload(agentId: string, dirPath: string): Promise<Array<{ name: string; ok: boolean; skipped?: boolean; bytes?: number }>>
  /**
   * Fase 19b (T3.2, correzioni U1): il file TRASCINATO dal Finder sul
   * pannello — si passa l'oggetto File del drop e il path del Mac lo calcola
   * SOLO il preload con webUtils.getPathForFile: la pagina non può passare
   * una stringa (un File costruito col codice dà '' e viene rifiutato) e il
   * path non torna mai al renderer; exists lo gestisce la UI con
   * «Sostituire?».
   */
  filesImportDropped(agentId: string, dirPath: string, file: File, overwrite?: boolean): Promise<FilesImportResult>
  /** fase 19b (T4): le ultime voci del feed Attività della famiglia del bot */
  activityList(agentId: string, limit?: number): Promise<{ owner: string; items: ActivityItem[] }>
  /** fase 19b (T4): la coda dell'output di UNA voce (shell) o l'errore (azione) */
  activityOutput(agentId: string, id: string): Promise<{ text: string }>
  /** fase 16c (C5): i dati del feed globale Attività (task, routine, attese) */
  activityGlobal(limit?: number): Promise<GlobalActivityData>
  /** fase 16c (C4): ricerca di sola lettura nel registro MCP (finestra Collega app) */
  connectorsSearchRegistry(query: string): Promise<AppsRegistryResult[]>
  // memoria (fase 4): sezione nella vista dell'agente, modifica ed eliminazione
  listMemories(agentId: string): Promise<MemoryInfo[]>
  updateMemory(agentId: string, id: string, content: string): Promise<void>
  deleteMemory(agentId: string, id: string): Promise<void>
  // skill (fase 4): elenco con visualizzazione ed eliminazione
  /** fase skill: il SALVATAGGIO dalla finestra — validazione S1, versioni, rename */
  skillsSave(rec: {
    folder?: string
    name: string
    description: string
    body: string
    frontmatter?: Record<string, unknown>
    enabledFor?: string[]
  }): Promise<{ ok: true; name: string } | { ok: false; issues: Array<{ english: string; uiId: string; values?: Record<string, string | number> }> }>
  skillsLibrary(): Promise<{ library: SkillLibraryItem[]; plugins: PluginSkillGroup[] }>
  /** K2: l'elenco `/` del compositore (come invocableSkillsOf, senza i corpi) */
  skillsInvocable(agentId: string): Promise<Array<{ name: string; description: string; imported: boolean }>>
  skillsGet(name: string): Promise<string>
  skillsDelete(name: string): Promise<void>
  skillsSetEnabledFor(name: string, agentIds: string[]): Promise<void>
  skillsReadFile(folder: string, file: string): Promise<string | null>
  skillsVersions(name: string): Promise<SkillVersion[]>
  skillsRestoreVersion(name: string, file: string): Promise<void>
  skillsExport(name: string): Promise<{ ok: boolean; path: string }>
  skillsShowInFinder(name: string): Promise<boolean>
  skillsGithubPreview(url: string): Promise<{ id: string; preview: SkillGithubPreview }>
  skillsGithubAdd(id: string, choices: Array<{ path: string; name?: string }>, enabledFor: string[]): Promise<Array<{ name?: string; path: string; error?: { english: string; uiId: string; values?: Record<string, string | number> } }>>
  skillsGithubUpdatePreview(name: string): Promise<{ id: string; diff: SkillGithubUpdatePreview }>
  skillsGithubUpdateApply(id: string, name: string): Promise<boolean>
  // fase skill · catalogo (K2/K3): il catalogo curato che vive NEL REPO
  // (nessuna rete per l'elenco) e l'aggiunta dalla finestra, col commit
  // fissato della voce come ref
  skillsCatalog(): Promise<SkillCatalogEntry[]>
  skillsCatalogPreview(id: string): Promise<{ previewId: string; preview: SkillCatalogPreview }>
  skillsCatalogInstall(previewId: string, enabledFor: string[]): Promise<{ ok: true; name: string }>
  // MCP
  mcpList(): Promise<McpServerInfo[]>
  mcpSave(s: McpServerInfo, secret?: McpServerSecret): Promise<McpServerInfo[]>
  mcpDelete(id: string): Promise<void>
  mcpTest(id: string): Promise<{ ok: boolean; error?: string; tools?: string[] }>
  // fase 5: connettori del catalogo ("Connetti app")
  connectorsList(): Promise<ConnectorInfo[]>
  connectorsConnect(id: string): Promise<{ started: boolean; status: string; message?: string; conflict?: 'composio-key' }>
  connectorsDisconnect(id: string): Promise<void>
  connectorsSetTools(id: string, disabledTools: string[]): Promise<void>
  connectorsSetInstructions(id: string, instructions: string): Promise<void>
  connectorsSaveStaticClient(id: string, clientId: string, clientSecret: string): Promise<void>
  // fase 13: registro, plugin, marketplace, gateway (installazione SOLO dal click)
  connectorsInstalled(): Promise<{ servers: McpServerInfo[]; plugins: unknown[] }>
  connectorsResolveMcpServer(agentId: string, entryId: number, decision: 'add' | 'no'): Promise<{ ok: boolean; installed?: boolean; message?: string; error?: string }>
  connectorsSaveServerValues(serverId: string, kind: SecretKind, values: Record<string, string>): Promise<{ ok: boolean }>
  /** fase app (A5): kind 'composio' = toolkit Composio (per-bot, come i server) */
  connectorsSetEnabledFor(kind: 'server' | 'plugin' | 'composio', id: string, agentIds: string[]): Promise<{ ok: boolean }>
  connectorsUninstallServer(id: string): Promise<{ ok: boolean }>
  /** fase 13 (correzione L1): rifà l'OAuth di un server del registro/plugin la cui sessione è scaduta */
  connectorsReconnectServer(id: string): Promise<{ ok: boolean; message?: string; error?: string }>
  /** fase mcp-setup (M3): lo spec del modulo di configurazione di un server (variabili, accesso, token salvato) */
  connectorsServerSetup(id: string): Promise<McpServerSetupSpec | null>
  /** fase mcp-setup (M3): il clic su «Accedi con <Nome>»/«Collega» del modulo (i segreti NON tornano mai) */
  connectorsServerConnect(id: string, input: { vars?: Record<string, string>; token?: string }): Promise<McpServerConnectResult>
  connectorsAddGateway(input: { name: string; url: string; auth: 'oauth' | 'bearer' | 'headers'; preset?: string; headerName?: string; token?: string; headers?: Record<string, string> }): Promise<McpServerInfo>
  connectorsGatewayPresets(): Promise<{ presets: Array<{ id: string; name: string; auth: string; headerName?: string; help: string }>; warning: string }>
  connectorsSetClientMetadataUrl(url: string): Promise<{ ok: boolean }>
  pluginsResolve(agentId: string, entryId: number, decision: 'install' | 'no'): Promise<{ ok: boolean; installed?: boolean; message?: string; error?: string }>
  pluginsUninstall(name: string, marketplace: string): Promise<{ ok: boolean }>
  // fase app (A2): attivazione di Composio con la chiave dell'utente
  composioStatus(): Promise<ComposioStatusInfo>
  composioSetKey(key: string): Promise<{ ok: boolean }>
  composioTest(): Promise<{ ok: boolean; reason?: 'invalid-key' | 'unreachable' | 'consumer-key' | 'gateway-active'; error?: string }>
  composioDisable(): Promise<{ ok: boolean }>
  // fase app (A4): collega (browser o subito) e scollega un toolkit
  // (il catalogo per la UI è il file curato nel repo: fase catalogo app P7)
  composioConnect(slug: string): Promise<{ started: boolean; developerConfig?: boolean; error?: string }>
  composioDisconnect(slug: string): Promise<{ ok: boolean }>
  // fase Composio OAuth (C5): le app dentro il server Composio collegato col login
  composioGatewayStatus(): Promise<ComposioGatewayStatusInfo>
  composioGatewayRefresh(): Promise<ComposioGatewayStatusInfo>
  // V8 (prova vera): already = c'era GIÀ un account attivo, nessun add
  composioGatewayConnect(slug: string, name?: string): Promise<{ ok: boolean; already?: boolean; error?: string }>
  composioGatewayRemove(slug: string): Promise<{ ok: boolean; error?: string }>
  composioGatewayCancel(): Promise<{ ok: boolean }>
  /** il clic su «Collega» della card in chat: apre il link e aspetta il login */
  composioGatewayCardConnect(key: string): Promise<{ ok: boolean; error?: string }>
  /**
   * fase catalogo app (P4): «Connetti» in un passo. La riga decide la strada:
   * diretta, login di Composio (phase 'login', poi il daemon prosegue da solo
   * con l'app scelta) o collegamento dell'app (phase 'app'). Con la chiave di
   * progetto attiva risponde conflict (le due strade non stanno insieme).
   */
  appsConnect(appId: string): Promise<{ started: boolean; phase?: 'direct' | 'login' | 'app'; conflict?: 'composio-key'; reason?: 'unknown-app' }>
  /** Annulla sempre disponibile durante l'attesa del «Connetti» in un passo */
  appsCancelConnect(appId: string): Promise<{ ok: boolean }>
  marketplaceList(): Promise<Array<{ name: string; source: string; kind: 'github' | 'git'; official: boolean }>>
  marketplaceAdd(source: string): Promise<{ name: string; source: string }>
  marketplaceRemove(source: string): Promise<{ ok: boolean }>
  // vault
  vaultList(): Promise<string[]>
  vaultStore(name: string, value: string): Promise<void>
  vaultDelete(name: string): Promise<void>
  // fase 14 (punto 7b): vault esteso — login, contatti, concessioni
  vaultItems(): Promise<VaultItemInfoUi[]>
  vaultSaveLogin(input: { id?: string; label: string; origins: string[]; username: string; password: string; totp?: string }): Promise<{ id: string }>
  vaultSaveContact(input: { id?: string; name: string; emails?: string[]; phones?: string[]; address?: string; notes?: string }): Promise<{ id: string }>
  vaultDeleteItem(kind: 'secret' | 'login' | 'contact', key: string): Promise<boolean>
  vaultGetContact(id: string): Promise<{ id: string; name: string; emails: string[]; phones: string[]; address?: string; notes?: string } | null>
  fillGrants(): Promise<FillGrantInfo[]>
  fillGrantRevoke(id: number): Promise<{ ok: boolean }>
  /** fase 14 (punto 7e): l'utente ha compilato il modulo sicuro */
  secureInputSubmit(agentId: string, approvalId: string, values: Record<string, string>): Promise<{ ok: boolean }>
  // fase 14 (punti 1-5): la libreria
  libraryList(query?: string, kind?: string): Promise<LibraryItemInfo[]>
  libraryGet(id: string, version?: number): Promise<LibraryContentInfo>
  libraryDelete(id: string): Promise<{ ok: boolean }>
  libraryRename(id: string, title: string): Promise<{ ok: boolean }>
  libraryPin(id: string, pinned: boolean): Promise<{ ok: boolean }>
  libraryExport(id: string, format: string): Promise<{ ok: boolean; path: string; output: string }>
  libraryRestoreVersion(id: string, version: number): Promise<{ ok: boolean; version: number }>
  libraryStats(): Promise<{ bytes: number; warn: boolean; warnBytes: number }>
  // daemon all'accesso — fase rilascio (A3): nell'app impacchettata è
  // SMAppService; requiresApproval dice che macOS aspetta il via dell'utente
  // in Impostazioni › Elementi login (il bottone le apre)
  getLaunchAtLogin(): Promise<{ enabled: boolean; requiresApproval: boolean; mechanism: 'agentService' | 'plist' }>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  openLoginItemsSettings(): Promise<{ opened: boolean }>
  // fase rilascio (A7): stato di docker per la UI (installato? avviato?)
  boxDockerStatus(): Promise<{ installed: boolean; running: boolean; path: string; testPrefixInvalid: boolean }>
  boxDockerRetry(): Promise<{ installed: boolean; running: boolean; path: string; testPrefixInvalid: boolean }>
  // fase rilascio (A8): l'aggiornamento (main process)
  updaterStatus(): Promise<{ current: string; canUpdate: boolean }>
  updaterCheck(): Promise<{ current: string; available: boolean; version: string | null; error?: string }>
  // fase rilascio (A8): la riga del rinnovo da Homun 2 (una volta)
  legacyHomun2(): Promise<{ dir: string } | null>
  legacyHomun2Dismiss(): Promise<{ ok: boolean }>
  revealInFinder(dir: string): Promise<{ ok: boolean }>
  // fase 17a: il renderer avvisa che la lingua dell'interfaccia è cambiata
  // (il main ricostruisce tray e notifiche nella lingua attiva)
  uiLanguageChanged(lang: 'it' | 'en'): Promise<void>
  // evento push
  onEvent(cb: (e: SandbotEvent) => void): () => void
}

export interface RoutineInfo {
  id: number
  agent_id: string
  title: string
  prompt: string
  schedule: string
  enabled: number
  last_run: number | null
  created_at: number
  /** fase 4: provenance 'agent' = creata dal bot via update_state (nasce in pausa); fase 7: 'template' = importata dal kickstart */
  provenance?: 'user' | 'agent' | 'template'
  description?: string
  timezone?: string
  /** fase 6: trigger esteso (null = schedule cron classica nella colonna schedule) */
  trigger?: RoutineTrigger | null
  /** fase 6: la routine è in pausa perché l'utente è via (riattivabile solo al rientro) */
  paused_for_away?: number
  /** fase 6: prossimo run calcolato dal daemon (ms epoch; null se non schedulabile) */
  next_run?: number | null
  /** fase 6: URL del webhook (solo trigger webhook, per copiarlo dalla UI) */
  webhook_url?: string
  /**
   * Fase 18b (H7): modello PROPRIo della routine (null = quello del bot).
   * Vale solo per il turno della routine; le continuazioni di task usano il bot.
   */
  providerId?: string | null
  model?: string | null
  thinking?: ThinkingSetting | null
}

/**
 * Fase 18b (H7): il modello proprio di una routine, come arriva alla RPC.
 * providerId null (o assente) = modello del bot; con providerId il modello è
 * obbligatorio (la RPC valida) e thinking è facoltativo.
 */
export interface RoutineModelPatch {
  providerId?: string | null
  model?: string | null
  thinking?: ThinkingSetting | null
}

// ---- trigger delle routine (fase 6, §3bis L3) ----

/** Schedule "ogni X alle HH:MM", precisa ('at') o circa ('around', ±15 min deterministici). */
export interface EveryScheduleSpec {
  every: 'day' | 'weekday' | 'week' | 'month' | 'hour'
  /** 'HH:MM'; per every:'hour' conta solo il minuto */
  at?: string
  /** 0-6 (domenica 0) — per every:'week' */
  weekday?: number
  /** 1-31 — per every:'month' */
  monthDay?: number
  mode: 'at' | 'around'
}

export type ScheduleTrigger =
  | { type: 'schedule'; kind: 'cron'; cron: string }
  | ({ type: 'schedule'; kind: 'every' } & EveryScheduleSpec)

/**
 * Poll di un tool MCP in sola lettura di un connettore connesso: estrae gli
 * id (idField = percorso semplice tipo "messages[].id") e produce un evento
 * per ogni id NUOVO. preset email/calendar_event = le due automazioni con UI
 * dedicata (il tool lo sceglie il preset da toolsOfServer, niente nomi cablati).
 */
export interface ConnectorPollTrigger {
  type: 'connector_poll'
  connectorId: string
  tool: string
  args?: Record<string, unknown>
  intervalMin: number
  idField: string
  preset?: 'email' | 'calendar_event'
  /** solo preset calendar_event: il job parte N minuti prima dell'evento */
  offsetMinutes?: number
  /**
   * Fase 7 (residuo 0a): obbligatorio per i poll su server NON del catalogo
   * (aggiunti a mano): l'utente conferma in UI che il tool legge soltanto.
   * L'annotazione readOnlyHint di un server manuale non è verificata.
   */
  userConfirmedReadOnly?: boolean
}

/** Webhook: POST http://127.0.0.1:<porta daemon>/hooks/<routineId> con Bearer <token>. */
export interface WebhookTrigger {
  type: 'webhook'
  token: string
}

/** L'utente è tornato dopo un'assenza lunga (vedi presenza/look-around). */
export interface PresenceReturnTrigger {
  type: 'presence_return'
}

export type RoutineTrigger = ScheduleTrigger | ConnectorPollTrigger | WebhookTrigger | PresenceReturnTrigger

/** L'evento che ha fatto scattare un job routine-run (entra nel prompt come <evento>). */
export interface TriggerEventPayload {
  source: 'connector_poll' | 'webhook' | 'presence_return' | 'calendar_event'
  /**
   * Fase 17c correzioni (D1): il codice del tipo di evento, per il titolo
   * della bolla UI (open.triggerEvent). I job già in coda col payload vecchio
   * non ce l'hanno: l'apertura mostra il content com'è.
   */
  kind?: 'newEmail' | 'newItem' | 'calendarSoon' | 'webhook' | 'presenceReturn'
  /** Riga sintetica INGLESE per il modello ("New email: x", "Webhook received") */
  title: string
  /** Il titolo dell'elemento (o "id <id>"): dato esterno, resta com'è */
  item?: string
  /** Evidenza grezza (l'elemento nuovo, il corpo del webhook) */
  data?: unknown
  at?: number
}

// ---- memoria e skill (fase 4) ----

/** Una memoria dell'agente (o condivisa, scope 'user') così come la vede la UI. */
export interface MemoryInfo {
  id: string
  content: string
  tier: 'core' | 'log'
  scope: 'agent' | 'user'
  source: string
  createdAt: number
  updatedAt: number
}

/** Una skill dell'agente (SKILL.md), con le istruzioni complete. */
export interface SkillInfo {
  name: string
  description: string
  content: string
}

// ---- fase skill: la libreria unica (S2) ----

/** Da dove arriva una skill della libreria. */
export type SkillSourceKind = 'user' | 'bot' | 'github' | 'migrated'

/** L'origine di una skill importata da GitHub (S6). */
export interface SkillOrigin {
  repo: string
  commit: string
  path: string
  /** fase skill · catalogo (K3): l'id della voce del catalogo da cui viene */
  catalogId?: string
}

/** I metadati di Homun di una skill (NON stanno in SKILL.md: setting `skills.library`). */
export interface SkillLibraryEntry {
  /** id dei bot che la usano ('*' = tutti) */
  enabledFor: string[]
  source: SkillSourceKind
  createdBy?: string
  origin?: SkillOrigin
  /** K4 (fase skill · catalogo): le note per Homun — il motore le mette in coda alla skill per il modello */
  homunNotes?: string
  /** K5: 'user' = solo con /nome (fuori dal prompt, rifiutata dal tool skill) */
  invocation?: 'user'
  createdAt: number
  updatedAt: number
}

export type SkillLibrarySettings = Record<string, SkillLibraryEntry>

/** Una voce dell'elenco della finestra «Skill» (senza il corpo). */
export interface SkillLibraryItem {
  name: string
  folder: string
  description: string
  enabledFor: string[]
  source: SkillSourceKind
  createdBy?: string
  origin?: SkillOrigin
  createdAt: number
  updatedAt: number
  files: string[]
  valid: boolean
  /** K4: importata da GitHub e poi modificata dall'utente — resta di terzi */
  importedModified?: boolean
  /** K4 (fase skill · catalogo): le note per Homun, in sola lettura nella finestra */
  homunNotes?: string
  /** K5: la voce di libreria dice «solo con /» */
  invocation?: 'user'
  /** K5: si usa solo con /nome (disable-model-invocation nel frontmatter o invocation 'user') */
  userOnly?: boolean
  issues: Array<{ english: string; uiId: string; values?: Record<string, string | number> }>
}

/** L'anteprima di una skill trovata in un repository GitHub (S6.3). */
export interface SkillGithubPreviewItem {
  /** il nome nel frontmatter (validato S1) */
  name: string
  description: string
  /** percorso della cartella della skill nel repository */
  path: string
  fileCount: number
  license?: string
  valid: boolean
  issues: Array<{ english: string; uiId: string; values?: Record<string, string | number> }>
}

export interface SkillGithubPreview {
  repo: string
  commit: string
  skills: SkillGithubPreviewItem[]
}

/** La differenza fra la skill installata e quella del repository (S6.5). */
export interface SkillGithubUpdatePreview {
  repo: string
  oldCommit: string
  newCommit: string
  added: string[]
  removed: string[]
  changed: string[]
  skill: SkillGithubPreviewItem
}

/** Una versione precedente di SKILL.md (S5). */
export interface SkillVersion {
  file: string
  ts: number
  origin: string
  by?: string
}

// ---- fase skill · catalogo (K3): l'anteprima di una voce del catalogo curato ----

/**
 * L'anteprima di una voce del catalogo, scaricata al COMMIT FISSATO: i file
 * che entreranno (esclusioni applicate), la fonte, la licenza e le note per
 * Homun. Lo staging resta nel daemon (id opaco), come l'import da GitHub.
 */
export interface SkillCatalogPreview {
  /** l'id della voce (= il nome della cartella) */
  id: string
  /** il name e la description dello SKILL.md scaricato */
  name: string
  description: string
  repo: string
  commit: string
  path: string
  license: string
  /** i file che entreranno, relativi alla cartella della skill (SKILL.md e LICENSE* sempre) */
  files: string[]
  homunNotes: string
  invocation?: 'user'
  /** la skill scaricata rispetta il formato (altrimenti «Aggiungi» è spento col motivo) */
  valid: boolean
  issues: Array<{ english: string; uiId: string; values?: Record<string, string | number> }>
}

/** Le skill dei plugin per la finestra «Skill» (sola lettura). */
export interface PluginSkillGroup {
  plugin: string
  /** i bot per cui il plugin è abilitato ('*' = tutti) */
  enabledFor: string[]
  skills: Array<{ name: string; description: string }>
}

export interface RoutineSuggestion {
  title: string
  schedule: string
  description: string
}

// ---- task thread (fase 8, §3bis L7) ----

/** Un task thread: lavoro lungo in un contesto separato (sotto-transcript con meta.taskId). */
export interface TaskInfo {
  id: number
  agentId: string
  title: string
  status: 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  summary: string | null
}

// ---- sottoagenti (fase 12, §L7/T5) ----

/** Un sottoagente del padre così come lo vede la UI (tabella subagents + stato live dell'agente figlio). */
export interface SubagentInfo {
  id: string
  parentId: string
  /** se lanciato da dentro un task, i risultati tornano al task */
  parentTaskId: number | null
  /** il lotto: i figli dello stesso turno del padre si svegliano insieme */
  batchId: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'expired'
  summary: string | null
  reportPath: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  deadlineAt: number
  /** stato live dell'agente figlio (paused-for-approval = "in attesa di conferma") */
  agentStatus: AgentStatus | null
}

// ---- gruppi (fase 10, T7) ----

/** Chi ha scritto un messaggio di gruppo: l'utente, un bot o una riga di sistema. */
export type GroupAuthorKind = 'user' | 'agent' | 'system'

/**
 * Un gruppo di bot con l'utente (fase 10): stanza di chat con fino a 6 bot;
 * l'utente ne è sempre membro. Il coordinatore (obbligatorio dalla 16b, S1.1)
 * è uno dei bot.
 */
export interface GroupInfo {
  id: number
  name: string
  /** scopo e regole del gruppo (la "description" della room di Grok) */
  description: string
  createdBy: string
  coordinatorId: string | null
  /** i membri BOT (l'utente è sempre membro e non compare qui) */
  members: Array<{ agentId: string; name: string; coordinator: boolean }>
  createdAt: number
  /** fase 16b (S2): l'attività recente per l'ordinamento della barra (null se vuota) */
  lastMessageAt: number | null
}

/** Un messaggio di gruppo come lo vede la UI. */
export interface GroupMessageInfo {
  id: number
  groupId: number
  authorKind: GroupAuthorKind
  authorId: string | null
  authorName: string
  text: string
  replyTo: number | null
  createdAt: number
  /** fase 16b (S1.2): è il riepilogo di chiusura del coordinatore */
  summary: boolean
}

// ---- auto-review delle approvazioni (fase 8, §3bis L5) ----

/**
 * Regole di auto-review in linguaggio naturale (due liste, come l'originale):
 * "Continua da solo quando l'azione rispetta queste regole" /
 * "Fermati e chiedimi sempre quando…". Un modello piccolo giudica le azioni
 * che il gate deterministico segna "ask"; può SOLO trasformare ask in allow.
 */
export interface AutoReviewSettings {
  enabled: boolean
  allowRules: string[]
  blockRules: string[]
  providerId: string | null
  model: string | null
}

export const DEFAULT_AUTO_REVIEW: AutoReviewSettings = {
  enabled: false,
  allowRules: [],
  blockRules: [],
  providerId: null,
  model: null
}

/**
 * Fase impostazioni (I4): autoReview.enabled è DERIVATO dal modo
 * (approvals.mode === 'auto'): la UI scrive entrambi, il motore continua a
 * leggere cfg.enabled come sempre. Senza approvals.mode (dati di ieri) il
 * modo si ricava da enabled — compatibilità in lettura.
 */
export function approvalsModeOf(autoReview: AutoReviewSettings, mode: ApprovalsMode | undefined): ApprovalsMode {
  if (mode === 'ask' || mode === 'auto' || mode === 'never') return mode
  return autoReview.enabled ? 'auto' : 'ask'
}

// ---- libreria (fase 14, punti 1-5) ----

/** Una voce della libreria come la vede la UI. */
export interface LibraryItemInfo {
  id: string
  kind: 'document' | 'chart' | 'file'
  title: string
  authorAgentId: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  tainted: boolean
  currentVersion: number
  chartKind?: 'vega-lite' | 'mermaid' | null
  fileName?: string | null
  fileSize?: number | null
  fileMime?: string | null
  hasTotp?: boolean
}

/** Il contenuto di una voce (documento: markdown della versione; grafico: sorgente; file: base64 per le immagini). */
export interface LibraryContentInfo {
  kind: 'document' | 'chart' | 'file'
  /** document: il markdown; chart: spec/diagramma; file: null (si usa fileData) */
  content: string | null
  /** chart vega-lite: l'SVG generato dal daemon */
  svg: string | null
  /** file: contenuto base64 quando è un'immagine png/jpg/svg (altrimenti null) */
  fileBase64: string | null
  fileMime: string | null
  versions: number[]
  authorName: string
}

/** Una voce del vault come la vede la UI (mai i valori). */
export interface VaultItemInfoUi {
  kind: 'secret' | 'login' | 'contact'
  key: string
  label: string
  origins?: string[]
  hasTotp?: boolean
  createdAt: number
}

/** Una concessione "Sempre per questo sito" di fill_credential, revocabile. */
export interface FillGrantInfo {
  id: number
  loginId: string
  label: string
  origin: string
  createdAt: number
}

// ---- template dei bot (fase 7, §3ter T4 + Appendice A) ----

/**
 * Un template di bot: routine (solo trigger schedule), connettori consigliati,
 * memorie (regole operative atomiche e datate) e skill. Il JSON vive in
 * src/main/templates/<id>.json, validato da validateTemplate all'avvio.
 */
export interface BotTemplate {
  id: string
  /** fase 17c (C5): campi bilingui — la galleria usa la lingua dell'interfaccia, l'installazione quella dell'utente */
  name: Localized
  description: Localized
  avatar: string
  roles: Localized[]
  routines: Array<{
    name: Localized
    slug: string
    description: Localized
    content: Localized
    trigger: RoutineTrigger
    /** domande da fare all'utente a fine kickstart (fuso orario, soglie, …) */
    askUserFor: string[]
  }>
  connectors: Array<{ connectorId: string; why: string }>
  memories: Array<{ content: string; created_at: string }>
  skills: Array<{ name: string; description: string; content: string }>
}

/** Un template come lo vede la UI. */
export type TemplateInfo = BotTemplate

/**
 * Fase 13 (correzione L1): UN solo nome per ogni tipo di segreto. La chiave
 * logica (quella che UI e RPC si passano) mappa alla chiave dello store cifrato:
 * prima la scheda Installati scriveva 'headers' e il resolver leggeva
 * 'staticHeaders', e la chiave non arrivava mai al server.
 */
export const SECRET_KIND = {
  headers: 'staticHeaders',
  env: 'env',
  userConfig: 'userConfig',
  bearer: 'bearer'
} as const
export type SecretKind = keyof typeof SECRET_KIND

/** Il needsAuth.kind del server (key/env/settings) → tipo di segreto dello store. */
export const SECRET_KIND_FOR_NEEDS: Record<'key' | 'env' | 'settings', SecretKind> = {
  key: 'headers',
  env: 'env',
  settings: 'userConfig'
}

export interface McpServerInfo {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  /** fase 5: autenticazione http — i valori segreti vivono cifrati, non qui */
  auth?: { kind: 'oauth' | 'bearer' | 'headers' }
  /** fase 5: id del connettore del catalogo che ha creato questo server */
  catalogId?: string
  /** fase 13 (punto 5): per quali bot è abilitato (['*'] = tutti) */
  enabledFor?: string[]
  /** fase 13: da dove arriva il server (registro, plugin, gateway) */
  source?:
    | { kind: 'registry'; name: string; version?: string }
    | { kind: 'plugin'; plugin: string; marketplace: string; sha: string }
    | { kind: 'gateway'; preset?: string }
  /** fase 13: server stdio che gira nel box (docker exec) */
  box?: { workdir: string; command: string; args?: string[]; envKeys?: string[] }
  /**
   * fase 13 (correzione L1): la DICHIARAZIONE del server di plugin (template
   * pubblici del repository, placeholder NON sostituiti — mai valori dell'utente):
   * url, headers ed env si ricalcolano alla connessione con i valori dello store.
   */
  pluginSpec?: { url?: string; headers?: Record<string, string>; env?: Record<string, string> }
  /**
   * fase mcp-setup (M1): template `{var}` dell'URL del registro + valori NON
   * segreti; i segreti vivono solo nello store cifrato
   */
  urlTemplate?: string
  vars?: Record<string, string>
  headerTemplates?: Array<{ name: string; valueTemplate: string; isRequired?: boolean; isSecret?: boolean; description?: string; variables?: Array<{ name: string; description?: string; isSecret?: boolean }> }>
  /** fase 13: installato ma in attesa di valori; fase mcp-setup: 'setup' = il modulo della card/foglio */
  needsAuth?: { kind: 'key' | 'env' | 'settings' | 'setup'; keys: string[] }
  /** fase 13: fiducia della scheda Installati */
  trustLabel?: string
  /** fase 17c (C5): il kind della fiducia — la UI lo traduce */
  trustKind?: 'verified-domain' | 'github-account' | 'unverified'
  /** fase 13 (correzione L1): OAuth scaduto/da rifare → bottone "Riconnetti" nella scheda Installati */
  needsReauth?: boolean
  /**
   * fase 13 (correzione 2, M2): il server OAuth non ha MAI avuto token
   * (appena installato da un plugin) — lo stesso bottone dice "Connetti"
   * invece di "Riconnetti" (che resta per la sessione scaduta).
   */
  neverAuthorized?: boolean
  /**
   * fase mcp-setup ritocchi (R1): il prefisso STABILE degli strumenti
   * (mcp__&lt;toolSlug&gt;__), deciso all'installazione e mai più cambiato — il
   * nome mostrato può cambiare (titolo del registro) senza cambiare i tool.
   */
  toolSlug?: string
}

// ---- fase mcp-setup (M3): il modulo di configurazione di un server ----

/** Un campo del modulo: variabile dell'URL (http) o d'ambiente (stdio). */
export interface McpServerSetupField {
  name: string
  description?: string
  placeholder?: string
  isRequired: boolean
  isSecret: boolean
  /** il valore NON segreto già salvato nella config (i segreti non tornano MAI) */
  value?: string
  /** una variabile segreta già salvata si mostra «•••• salvato · cambia» */
  saved?: boolean
}

/** Il campo del token: l'header col template e la sua variabile segreta. */
export interface McpServerSetupTokenHeader {
  name: string
  valueTemplate: string
  description?: string
  variable: string
  variableDescription?: string
  /** c'è già un valore risolto nello store cifrato */
  saved: boolean
}

/** Lo spec del modulo di un server installato (per la card M4 e il foglio M6). */
export interface McpServerSetupSpec {
  serverId: string
  name: string
  transport: 'http' | 'stdio'
  /** variabili dell'URL (http) o d'ambiente (stdio, M6.3) */
  variables: McpServerSetupField[]
  auth: 'oauth' | 'headers' | 'env'
  tokenHeader?: McpServerSetupTokenHeader
  /** fase mcp-setup ritocchi (R6): il template `{var}` dell'URL — il ruolo di ogni variabile nasce dalla POSIZIONE */
  urlTemplate?: string
  /** true quando manca qualcosa: il modulo si apre, il server non è partito */
  needsSetup: boolean
  /** fase mcp-setup (M6.1): lo stato dell'ultima prova (connectors.state) */
  stateStatus?: string
}

/** L'esito del collegamento dal modulo: codice per la UI, dettaglio tecnico. */
export interface McpServerConnectResult {
  ok: boolean
  /** i nomi completi degli strumenti quando il collegamento riesce */
  tools?: string[]
  error?: string
  /** il codice dell'errore UMANO (la UI lo traduce) */
  reason?: 'invalid-value' | 'unreachable' | 'unauthorized' | 'not-mcp' | 'oauth' | 'needs-window'
  /** campo → errore di validazione (M1.4) */
  fieldErrors?: Record<string, string>
}

/**
 * Segreto di un server MCP manuale (fase 5): bearer token o header statici.
 * Viaggia una sola volta dal renderer al daemon e viene conservato CIFRATO
 * (mai nei settings in chiaro).
 */
export interface McpServerSecret {
  bearerToken?: string
  headers?: Record<string, string>
}

// ---- connettori del catalogo (fase 5: "Connetti app") ----

export type ConnectorStatusInfo = 'not_connected' | 'connected' | 'needs_auth' | 'error'

export interface ConnectorToolInfoShared {
  name: string
  description: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

/** Un connettore del catalogo come lo vede la UI (catalogo + stato + tool). */
export interface ConnectorInfo {
  id: string
  name: string
  logo: string
  mcpUrl: string
  clientRegistration: 'dynamic' | 'static'
  scopes?: string[]
  docsUrl: string
  notes: string
  /** fase 16c (C4): la categoria per i filtri della finestra Collega app */
  category?: ConnectorCategory
  /** fase 16c (C4): mezza riga localizzata sotto il nome (per esempio «Pagine e database») */
  tagline?: Localized
  /** fase Composio OAuth (C1/C6): la voce è un «gateway» di app (dentro si collegano altre app) */
  gateway?: boolean
  state: {
    status: ConnectorStatusInfo
    error?: string
    disabledTools: string[]
    instructions: string
  }
  tools: ConnectorToolInfoShared[]
  hasStaticCredentials?: boolean
}

// ---- fase app: Composio con la chiave dell'utente (A2–A5) ----

/** La definizione di uno strumento come la costruisce il daemon (stessa forma dei ToolDef del loop). */
export interface ToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A3: le curate vincono — id della curata → slug del toolkit Composio (tabella in codice). */
export const CURATED_COMPOSIO_SLUGS: Record<string, string> = {
  gmail: 'gmail',
  gcalendar: 'googlecalendar',
  gdrive: 'googledrive',
  notion: 'notion',
  linear: 'linear',
  stripe: 'stripe',
  sentry: 'sentry',
  cloudflare: 'cloudflare'
}

/** Un toolkit Composio collegato (A4): ACTIVE o «da ricollegare». */
export interface ComposioConnectedApp {
  slug: string
  name: string
  status: 'ACTIVE' | 'RECONNECT'
  accountId: string | null
  toolsCount: number
  /** per quali bot è abilitato il toolkit (['*'] = tutti, predefinito) */
  enabledFor: string[]
  /** R4 (ritocchi): le azioni del toolkit per la tabella del dettaglio (nome nella lingua della UI) */
  tools: Array<{ slug: string; name: string }>
}

/** A2: lo stato di Composio per la UI (mai la chiave: solo hasKey e le ultime 4). */
export interface ComposioStatusInfo {
  active: boolean
  hasKey: boolean
  keyHint: string | null
  /** il collegamento in attesa del login nel browser (Annulla = composioDisconnect) */
  pending: { slug: string; name: string; since: number } | null
  connected: ComposioConnectedApp[]
}

// fase catalogo app (P7): le righe del catalogo Composio per la UI stavano
// qui (A3) — ora l'elenco è il file CURATO nel repo (shared/app-catalog) e
// non serve una RPC che lo scarichi; il bot continua a usare il metodo
// catalog() del manager (tipo ComposioCatalogRowRpc lì dove serve).

// ---- fase Composio OAuth (C5): le app collegate DENTRO il server Composio ----

/** Un'app collegata tramite il server Composio (login C1, non la chiave di progetto). */
export interface ComposioGatewayAppInfo {
  slug: string
  name: string
  status: 'ACTIVE' | 'RECONNECT' | 'FAILED'
  accountId: string | null
  /** V8 (prova vera): l'email dell'account quando `list` la dà (user_info.email) */
  email?: string
}

/** Lo stato del gateway Composio per la UI (mai link, mai token). */
export interface ComposioGatewayStatusInfo {
  /** il server Composio è collegato con il login */
  active: boolean
  connected: ComposioGatewayAppInfo[]
  /** il collegamento in attesa del login nel browser (Annulla = cancel) */
  pending: { slug: string; name: string; since: number; failed?: boolean } | null
}

// ---- fase 15 (S5): stato dei provider di ricerca web (RPC websearch:status) ----

/** Lo stato di un provider: disponibile, in raffreddamento fino a (epoch ms) o con ultimo errore. */
export interface WebSearchProviderStatusRpc {
  name: 'you' | 'exa' | 'tavily' | 'ollama'
  label: string
  cooldownUntil?: number
  lastError?: { kind: string; status?: number; at: number }
}

export interface WebSearchStatusRpc {
  /** il setting webSearch.keyless (interruttore delle Impostazioni) */
  keyless: boolean
  /** true se c'è un provider con chiave configurato (Ollama) */
  keyedConfigured: boolean
  providers: WebSearchProviderStatusRpc[]
}

// ---- fase 16c: attività globale (C5) e ricerca del registro (C4) ----

/** Fase 16c (C5): il motivo di un fallimento, in CODICE — la UI lo traduce, mai il testo grezzo del provider. */
export type ActivityFailReason = 'credit' | 'not-responding' | 'rate-limit' | 'cancelled' | 'other'

/** Fase 16c (C5): i dati grezzi di activity:global (l'ordine e i filtri li fa la funzione pura del renderer). */
export interface GlobalActivityData {
  tasks: Array<{
    id: number
    agentId: string
    title: string
    status: 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled'
    automatic: 0 | 1
    createdAt: number
    updatedAt: number
    summary: string | null
  }>
  runs: Array<{
    id: number
    routineId: number
    agentId: string
    title: string
    startedAt: number
    endedAt: number | null
    outcome: 'ok' | 'failed' | 'cancelled'
    reason: ActivityFailReason | null
  }>
  /** i bot che aspettano te (approvazione o card in sospeso): i loro id */
  waiting: string[]
}

/** Fase 16c (C4): una riga «dal registro» della ricerca in Collega app. */
export interface AppsRegistryResult {
  id: string
  name: string
  trustKind: 'verified-domain' | 'github-account' | 'unverified'
  description: string
  /** come gira: remote-oauth | remote-key | box-npm | not-installable */
  runtime: string
}

/** Fase 16c (C4): la categoria di un connettore del catalogo (i filtri della finestra Collega app). */
export type ConnectorCategory = 'mail-calendar' | 'documents' | 'development' | 'communication'
