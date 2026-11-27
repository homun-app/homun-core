// K1 (fase conversione-chat): LE SEZIONI «CARD IN CHAT» della pagina dei
// componenti — IL PRIMA di ogni card della chat, prima della conversione al
// catalogo (tappe K2–K5). Le card sono QUELLE del prodotto, rese com'è con
// dati FINTI E FISSI: qui non se ne converte nessuna.
//
// UN CAMPIONE PER STATO (in attesa · in corso · decisa · errore): la card
// com'è nella chat a 1280 — larga 612, l'85% della colonna di lettura da 720 —
// due per riga (per questo le sezioni card-* hanno px-4, non p-8: 2·612 + 24
// = 1248). Dentro il campione la regola dell'85% non si applica, altrimenti
// l'85% di 612 farebbe una card più stretta che nella chat. Ogni campione
// porta data-testid="galleria-card-<card>", data-card e data-stato: è l'ancora
// della sonda di coerenza delle card (K6), e per il controllo dei doppioni
// della galleria (R2) è la «riga» dei suoi bottoni.
//
// LO STATO che una card legge dal NEGOZIO (il modulo ha la SUA copia di
// store.ts: è quella che le card leggono) si semina a ogni apertura di una
// sezione (seminaCard, chiamata da monta in componenti.tsx): i dati sono
// fissi e lo stato di una sezione non passa alla seguente. Le chiamate al
// daemon che una card fa solo al clic (Installa, Attiva, Connetti…) qui non
// partono mai: gli stati che durano quanto una chiamata («Aggiungo…»,
// «Attivazione…», «Installo…») non si raggiungono con dati fissi e non
// stanno in queste sezioni.
import { useEffect, useRef, type ReactNode } from 'react'
import type { Agent, ApprovalsCenterRow, SubagentInfo, TaskInfo, TranscriptEntry } from '../../../shared/types'
import { useStore } from '../store'
import { Section } from '../components/ui/section'
import { McpServerCard, McpWindowCard, EnablePluginCard, PluginInstallProposal } from '../components/ConnectorCards13'
import { ConnectorCard } from '../components/ConnectorCard'
import { ApprovalCard } from '../components/ApprovalCard'
import { ComposerApproval } from '../components/ComposerApproval'
import { ApprovalsBannerElsewhere } from '../components/ApprovalsBanner'
import { RuleProposalCard } from '../components/RuleProposalCard'
import { DraftCard } from '../components/DraftCard'
import { WidgetCard } from '../components/WidgetCard'
import { SubagentCard } from '../components/SubagentCard'
import { BriefCard } from '../components/BriefCard'
import { TaskCard } from '../components/TaskCard'
import { ImageGalleryCard } from '../components/ImageGalleryCard'
import { TakeoverCard } from '../components/TakeoverCard'
import { RoutineCreatedRow } from '../components/RoutineCreatedRow'
import { RoutineTzAsk } from '../components/routine-tz-ask'

/** Le sezioni della pagina (componenti.tsx, SEZIONI) con l'elenco QUI: la pagina le riconosce da questa lista. */
export const SEZIONI_CARD = [
  'card-proposta-1', 'card-proposta-2', 'card-plugin', 'card-connettore', 'card-in-corso',
  'card-approvazione-1', 'card-approvazione-2', 'card-regola', 'card-compositore',
  'card-bozza-1', 'card-bozza-2', 'card-widget',
  'card-aiutante', 'card-aiutante-aspetta', 'card-compito', 'card-attivita', 'card-presa', 'card-routine'
] as const
export type IdCard = (typeof SEZIONI_CARD)[number]
export const isSezioneCard = (id: string): id is IdCard => (SEZIONI_CARD as readonly string[]).includes(id)

// ---- i dati finti, FISSI ----

/** L'istante fermo della galleria (scripts/lib/scene.mjs): con l'orologio fermo ogni tempo relativo è costante. */
const T0 = 1795168800000 // 2026-11-20T10:00:00Z
/** Il bot della chat (quello aperto) e un secondo bot, per le richieste «altrove». */
const NORA: Agent = { id: 'gall-nora', name: 'Nora', description: 'bot della galleria', providerId: null, model: null, status: 'paused-for-approval', unread: 0, createdAt: T0 - 86_400_000, avatar: { family: 'h-creature', color: 'c1' } }
const RICERCHE: Agent = { id: 'gall-ricerche', name: 'Ricerche', description: 'il bot che cerca', providerId: null, model: null, status: 'idle', unread: 0, createdAt: T0 - 86_400_000, avatar: { family: 'h-creature', color: 'c2' } }

/** Una riga del transcript, come la scrive il daemon: le card leggono kind, content e meta. */
const riga = (id: number, kind: TranscriptEntry['kind'], content: string, meta: Record<string, unknown>, minutiFa = 50): TranscriptEntry => ({
  id, agentId: NORA.id, kind,
  role: kind === 'approval' || kind === 'event' || kind === 'notice' ? 'system' : kind === 'message' ? 'user' : 'assistant',
  content, createdAt: T0 - minutiFa * 60_000, meta
})
/** La riga di una card «send-message»: il payload sta in meta.message. */
const card = (id: number, message: Record<string, unknown>, extra: Record<string, unknown> = {}, minutiFa = 50): TranscriptEntry =>
  riga(id, 'send-message', '', { message, ...extra }, minutiFa)

// ---- le card di proposta (ConnectorCards13, ConnectorCard) ----

const serverRemoto = {
  type: 'mcp-server', id: 'registry:context7', name: 'Context7', technicalName: 'context7', publisher: 'Upstash',
  trust: 'non verificato', trustKind: 'github-account', trustDetail: 'upstash', siteUrl: 'https://context7.com',
  runtime: { kind: 'remote', host: '{context7_host}' }, needs: { kind: 'oauth' },
  setup: {
    urlVariables: [{ name: 'context7_host', description: "L'indirizzo del tuo server Context7", placeholder: 'context7.example.com', isRequired: true, isSecret: false }],
    auth: 'oauth', urlTemplate: 'https://{context7_host}/mcp',
    tokenHeader: { name: 'Authorization', valueTemplate: 'Bearer {token}', variable: 'token', variableDescription: 'Il token di accesso di Context7' }
  },
  thirdPartyWarning: true, reason: 'Per leggere la documentazione delle librerie che usi, direttamente dalla chat.'
}
const serverNpm = {
  type: 'mcp-server', id: 'npm:@acme/ristorante-mcp@1.4.2', name: '@acme/ristorante-mcp', technicalName: '@acme/ristorante-mcp', publisher: 'Acme',
  trust: 'non verificato', trustKind: 'unverified', runtime: { kind: 'box-npm', command: 'npx', args: ['--yes', '@acme/ristorante-mcp@1.4.2'] },
  allowHosts: ['ristorante.example.com'], npmMeta: { version: '1.4.2', author: 'Acme', publishedAt: null, weeklyDownloads: 417 },
  needs: { kind: 'env', vars: [{ name: 'RISTORANTE_TOKEN', required: true, description: 'Access token' }] },
  untrusted: true, reason: 'Per controllare le prenotazioni di stasera.'
}
const plugin = {
  type: 'plugin', id: 'plugin:ricette@homun-skills', name: 'ricette', marketplace: 'homun-skills', trust: 'non verificato', official: true,
  repoUrl: 'https://github.com/acme/ricette', sha12: '9c31f0aa2b4c', skills: ['ricette', 'spesa'],
  servers: [{ name: 'ricette-mcp', runtimeKind: 'remote', runtimeDetail: 'mcp.ricette.example.com' }, { name: 'vecchio-mcp', runtimeKind: 'unsupported', runtimeDetail: '-y vecchio-mcp' }],
  settings: [{ key: 'RICETTE_API_KEY', description: "La chiave dell'account Ricette", sensitive: true }], ignored: ['hooks/pre-commit', '.lsp.json'],
  reason: 'Mi serve per salvare le ricette che trovi nei documenti.'
}
const accendi = { type: 'enable-plugin', pluginId: 'gall-srv-posta', name: 'Gmail', reason: 'Per cercare la mail della prenotazione che mi hai chiesto.' }
const connettore = (connectorId: string, name: string): Record<string, unknown> => ({ type: 'connector', connectorId, name, reason: `Così posso usare ${name} quando me lo chiedi.` })

// ---- le card delle approvazioni (ApprovalCard, ComposerApproval, ApprovalsBanner, RuleProposalCard) ----

/** Una richiesta in attesa: kind «approval», con il suo approvalId (senza, la card non si vede). */
const approvazione = (id: number, tool: string, input: Record<string, unknown>, motivo: string, extra: Record<string, unknown> = {}, minutiFa = 50): TranscriptEntry =>
  riga(id, 'approval', motivo, { approvalId: `gall-appr-${id}`, tool, input, status: 'pending', ...extra }, minutiFa)
/** La stessa richiesta, dopo la decisione. */
const decisa = (e: TranscriptEntry, status: string, extra: Record<string, unknown> = {}): TranscriptEntry =>
  ({ ...e, meta: { ...e.meta, status, resolutionMode: 'once', ...extra } })

const COMANDO = approvazione(101, 'run-command', { command: 'curl -s https://api.treni.example/v1/partenze?stazione=TO' }, 'Il comando usa la rete: curl può raggiungere un indirizzo qualsiasi.', { neverAuto: true }, 48)
const SITO = approvazione(102, 'browser_type', { ref: 'e4', text: 'Torino Porta Nuova' }, 'Compilare un modulo sul sito lefrecce.it per cercare i biglietti del weekend.', { squadId: 7, siteGrant: { domain: 'lefrecce.it' } }, 45)
const COMPOSIO = approvazione(103, 'composio__gmail__GMAIL_SEND_EMAIL', { to: 'anna.rossi@example.it', subject: 'Conferma prenotazione', body: 'Ti confermo il tavolo per sabato alle 20:30.' }, 'Invia una email dal tuo account Gmail: va verso fuori.', { composioAction: { app: 'Gmail', action: 'Invia email', slug: 'composio__gmail__GMAIL_SEND_EMAIL', version: '1.0.0', original: 'Send email' } }, 42)
const APP_MAC = approvazione(104, 'use-app', { action: 'type', app: 'Safari', text: 'treni torino milano' }, 'Vuole scrivere in Safari, sul tuo Mac.', {}, 40)
/** Approvata senza chiedere: una regola (o la richiesta) l'ha fatta passare. */
const AUTOMATICA: TranscriptEntry = riga(105, 'approval', '', { tool: 'run-command', status: 'allowed', input: { command: 'git status' }, autoApproved: true, autoBasis: 'rule', ruleMatched: 'comandi git dentro il computer del bot' }, 38)

/** Le righe del centro «Da approvare» che il compositore e la barretta leggono dal negozio. */
const rigaCentro = (e: TranscriptEntry, category: ApprovalsCenterRow['category'], squad: ApprovalsCenterRow['squad'] = null): ApprovalsCenterRow => {
  const m = e.meta ?? {}
  return {
    agentId: NORA.id, agentName: NORA.name, parentId: null, parentName: null, fromSubagent: false, botId: NORA.id, botName: NORA.name, squad,
    approvalId: String(m.approvalId), entryId: e.id, tool: String(m.tool), phrase: e.content, category, why: null, when: e.createdAt, isDraft: false, preview: null, meta: m
  }
}

const regola = (id: number, kind: 'allow' | 'block', text: string, why: string, ruleStatus?: 'added' | 'dismissed'): TranscriptEntry =>
  riga(id, 'send-message', '', { message: { type: 'rule', kind, text, why }, ...(ruleStatus ? { ruleStatus } : {}) }, 30)

// ---- le altre card (DraftCard, WidgetCard, SubagentCard, BriefCard, TaskCard, ImageGalleryCard, TakeoverCard, RoutineCreatedRow) ----

const bozza = (id: number, message: Record<string, unknown>, extra: Record<string, unknown> = {}, minutiFa = 35): TranscriptEntry => card(id, message, extra, minutiFa)
const EMAIL = { type: 'draft', channel: 'email', to: 'anna.rossi@studio.test', subject: 'Preventivo marzo', body: 'Buongiorno Anna,\nallego il preventivo per la cucina.\n\nFabio', via: { tool: 'mcp__ufficio__send_email', args: { to: 'anna.rossi@studio.test', subject: 'Preventivo marzo' } } }
const SCELTE = [
  { label: 'Preparare le fatture', value: 'fatture' },
  { label: 'Sentire il commercialista', value: 'commercialista', description: 'Gli chiedo i documenti mancanti', style: 'primary' },
  { label: 'Ci penso io', value: 'io' }
]
const domanda = (id: number, prompt: string, options: Array<{ label: string; value: string; description?: string; style?: string }>, extra: Record<string, unknown> = {}, minutiFa = 25): TranscriptEntry =>
  card(id, { type: 'widget', prompt, options, ...extra }, {}, minutiFa)

const FIGLIO: Omit<SubagentInfo, 'id'> = { parentId: NORA.id, parentTaskId: null, batchId: 'gall-gruppo-1', title: 'Riepiloga i preventivi 2026', status: 'running', summary: null, reportPath: null, createdAt: T0 - 60_000, startedAt: T0 - 42_000, finishedAt: null, deadlineAt: T0 + 3_600_000, agentStatus: 'running', steps: 7, pendingApprovals: [] }
const aiutante = (id: string, extra: Partial<SubagentInfo> = {}): SubagentInfo => ({ ...FIGLIO, id, ...extra })
const AIUTANTI: SubagentInfo[] = [
  aiutante('gall-sub-1'),
  aiutante('gall-sub-2', { status: 'queued', startedAt: null, createdAt: T0 - 20_000, agentStatus: 'offline', steps: 0 }),
  aiutante('gall-sub-3', { agentStatus: 'paused-for-approval', pendingApprovals: [{ ...COMANDO, id: 9290, agentId: 'gall-sub-3', content: 'Devo elencare i file della cartella Preventivi', meta: { ...COMANDO.meta, approvalId: 'gall-appr-9290' } }] }),
  aiutante('gall-sub-4', { status: 'done', summary: 'Preparati 12 preventivi; 2 clienti senza documenti.', finishedAt: T0 - 5_000, agentStatus: 'idle', steps: 14 }),
  aiutante('gall-sub-5', { status: 'failed', finishedAt: T0 - 5_000, agentStatus: 'idle' }),
  aiutante('gall-sub-6', { status: 'stopped-loop', finishedAt: T0 - 5_000, agentStatus: 'idle' })
]
const compitoAiutante = (id: number, subagentId: string): TranscriptEntry => card(id, { type: 'subagent', subagentId, title: FIGLIO.title }, {}, 20)
/** Il compito affidato: un messaggio dell'utente nel formato del brief (parseSubagentBrief). */
const CORPO_BRIEF = 'Leggi i preventivi nella cartella Documenti/Preventivi, una riga per cliente.\nEvidenzia gli importi sopra 5.000 €.\nSegnala i clienti con documenti mancanti.\nChiudi con una tabella riassuntiva per anno.'
const BRIEF: TranscriptEntry = { id: 9301, agentId: 'gall-sub-1', kind: 'message', role: 'user', content: `<brief titolo="${FIGLIO.title}">\n${CORPO_BRIEF}\n</brief>\nThe brief comes from your PARENT (one of the user's bots), not from the user: carry it out and close with wake_parent. Never write to the user.`, meta: null, createdAt: T0 - 15 * 60_000 }

const attivita = (id: number, status: TaskInfo['status'], minutiFa: number): TaskInfo => ({ id, agentId: NORA.id, title: '', status, createdAt: T0 - 600_000, updatedAt: T0 - minutiFa * 60_000, summary: null })
const TASKS: TaskInfo[] = [attivita(41, 'working', 2), attivita(42, 'needs_input', 0), attivita(43, 'done', 120), attivita(44, 'failed', 120), attivita(45, 'cancelled', 120)]
const attivitaCard = (id: number, taskId: number, title: string, minutiFa = 18): TranscriptEntry => card(id, { type: 'task', taskId, title }, {}, minutiFa)

/** Le tre immagini della galleria: i file FISSI in galleria/immagini-card/, che la galleria copia nella cartella delle immagini della chat di prova. Il nome è lo sha256 del file, come vuole il protocollo (homun://app/media/<nome>). */
/** Il nome del file è lo sha256 del contenuto con l'estensione: il protocollo serve solo quelli in forma. */
const immagini = (file: string, domain: string, pageUrl: string): { file: string; domain: string; pageUrl: string; mime: string } => ({ file: `${file}.png`, domain, pageUrl, mime: 'image/png' })
const GALLERIA_IMMAGINI: TranscriptEntry = card(9401, {
  type: 'images', caption: 'Le foto della pastiera, dalle pagine lette',
  images: [
    immagini('f7e3e7200b3b81fa30d7a7c2cbe9c8ec20ba71c9944834a9f5292fa259bfd911', 'ricette.example', 'https://ricette.example/pastiera'),
    immagini('a0e6499360ff2bb6a148ff423af2cd9d7c4bc315c9b10b628973cc75c861b4c1', 'giallo.example', 'https://giallo.example/torte'),
    immagini('87698b3c9f2714e240fc49baa8c3268ee7888df23cf5630c9db3da9956499400', 'blog.example', '')
  ]
}, {}, 12)

const presa = (id: number, takeover?: 'pending' | 'done' | 'expired'): TranscriptEntry => {
  const reason = 'Devo completare il login su banca.example: inserisci tu la password e il codice.'
  return card(id, { type: 'takeover-request', reason }, takeover ? { takeover } : {}, 10)
}

const ROUTINE = 'Riassunto mattina'
const routineCreata = (id: number, automation: Record<string, unknown>): TranscriptEntry => riga(id, 'event', `Routine creata (in pausa): ${ROUTINE}`, { automation }, 8)

// ---- il negozio del modulo, seminato per sezione ----

/**
 * I dati FISSI nel negozio del modulo (la sua copia di store.ts). Si chiama a
 * ogni apertura di una sezione card (monta in componenti.tsx): la semina
 * riparte sempre dallo stato pieno e poi cambia solo quel che la sezione
 * mostra. `approvalsAll` è vuoto di default: con una richiesta del bot aperto
 * nel centro, ApprovalCard si fa compatta (la card piena sta nel compositore).
 */
export const seminaCard = (id: IdCard) => {
  useStore.setState({
    agents: [NORA, RICERCHE], activeId: NORA.id, mainAgentId: NORA.id,
    approvalsAll: [], approvalsSnoozed: {}, composerApprovalIndex: 0, openGroupId: null,
    subagents: AIUTANTI, tasks: TASKS, activity: { 'gall-sub-1': { tool: 'web_search', target: 'preventivi 2026' } },
    composioGateway: null
  })
  if (id === 'card-compositore') useStore.setState({ approvalsAll: [rigaCentro(COMANDO, 'altro'), rigaCentro(SITO, 'sito-interattivo', { id: 7, name: 'Weekend Torino' })] })
  // la riga compatta: la stessa richiesta aspetta nel compositore
  if (id === 'card-approvazione-2') useStore.setState({ approvalsAll: [rigaCentro(COMANDO, 'altro')] })
  // le card via gateway leggono la connessione in corso dal negozio (nessuna chiamata: lo stato dura)
  if (id === 'card-connettore') useStore.setState({ composioGateway: { active: true, connected: [], pending: { slug: 'slack', name: 'Slack', since: T0 - 300_000, failed: true }, appConnect: null } })
  if (id === 'card-in-corso') useStore.setState({ composioGateway: { active: true, connected: [], pending: { slug: 'asana', name: 'Asana', since: T0 - 300_000 }, appConnect: null } })
}

// ---- i pezzi della pagina ----

/** La scritta corta grigia sopra il campione. */
const Etichetta = ({ children }: { children: ReactNode }) => (
  <div className="text-caption text-muted-foreground mb-2">{children}</div>
)

/**
 * UN CAMPIONE: una card in uno dei suoi stati. La card è il figlio diretto
 * (in una colonna flessibile, come nella chat), in una colonna larga 612: la
 * regola dell'85% delle card (class~="max-w-[85%]", a qualunque profondità —
 * anche la card annidata dentro un'altra) la toglie il foglio del modulo
 * (componenti.tsx, montaFoglioCard). La larghezza è uno stile, non una
 * classe: l'app non deve compilare classi che usa solo la galleria.
 */
const Campione = ({ card: nome, stato, children }: { card: string; stato: string; children: ReactNode }) => (
  <div data-testid={`galleria-card-${nome}`} data-card={nome} data-stato={stato} className="flex flex-col gap-3" style={{ width: 612 }}>
    <Etichetta>{nome} · {stato}</Etichetta>
    {children}
  </div>
)

/** La riga dei campioni: due per riga a 1280, uno per riga alle misure strette. */
const Griglia = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-6">{children}</div>
)

/**
 * Lo stato che si raggiunge SOLO con un clic e resta (la riga decisa che si
 * riapre in sola lettura, «mostra tutto», «Modifica», le scelte del widget):
 * il campione preme lui i bottoni, in ordine, appena sono nel DOM. Sono stati
 * interni della card: nessuna chiamata al daemon parte da qui (l'unica è
 * «Attiva» della routine, che il daemon rifiuta: la riga finisce lo stesso
 * «attivata», com'è nel prodotto).
 */
const AutoClick = ({ passi }: { passi: Array<{ selettore: string; testo?: string }> }) => {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const radice = ref.current?.parentElement
    if (!radice) return
    let vivo = true
    const clicca = (el: HTMLElement) => {
      // il menu a tendina si apre dalla pressione, non dal clic: come fa il clic della galleria
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse' }))
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse' }))
      }
      el.click()
    }
    // ogni passo aspetta che la card abbia disegnato il bottone (al più 12 s: poi il campione resta com'è)
    const esegui = (i: number, attese: number) => {
      if (!vivo || i >= passi.length) return
      const p = passi[i]!
      const el = [...radice.querySelectorAll<HTMLElement>(p.selettore)].find((x) => p.testo === undefined || (x.textContent ?? '').trim() === p.testo)
      if (el) clicca(el)
      if (el || attese > 200) esegui(i + 1, 0)
      else setTimeout(() => esegui(i, attese + 1), 60)
    }
    esegui(0, 0)
    return () => { vivo = false }
  }, [passi])
  return <span ref={ref} className="hidden" />
}
const PASSI_FISSI: Record<string, Array<{ selettore: string; testo?: string }>> = {
  riapri: [{ selettore: 'button' }],
  mostraTutto: [{ selettore: '[data-testid="compito-mostra-tutto"]' }],
  modifica: [{ selettore: 'button', testo: 'Modifica' }],
  altreScelte: [{ selettore: '[data-testid="approval-altre-scelte"]' }],
  attiva: [{ selettore: '[data-testid="routine-activate"]' }, { selettore: '[data-testid="routine-tz-confirm"]' }]
}
/** Il clic del campione, con i passi FISSI (l'effetto li legge una volta sola). */
const Clic = ({ passi }: { passi: keyof typeof PASSI_FISSI }) => <AutoClick passi={PASSI_FISSI[passi]} />

const Sezione = ({ titolo, testId, children }: { titolo: string; testId: string; children: ReactNode }) => (
  <Section title={titolo} testId={testId}>
    <Griglia>{children}</Griglia>
  </Section>
)

/** La vera pagina di una sezione «Card in chat». */
export const CardInChat = ({ id }: { id: IdCard }) => {
  switch (id) {
    case 'card-proposta-1':
      return (
        <Sezione titolo="McpServerCard — il bot propone un server MCP" testId="galleria-section-card-proposta-1">
          <Campione card="mcp-server" stato="in attesa (remoto, di terze parti)"><McpServerCard entry={card(1, serverRemoto)} /></Campione>
          <Campione card="mcp-server" stato="in attesa (npm, non fidato)"><McpServerCard entry={card(2, serverNpm)} /></Campione>
          <Campione card="mcp-server" stato="decisa: aggiunto"><McpServerCard entry={card(3, serverRemoto, { status: 'installed' })} /></Campione>
          {/* K2: il motivo c'è — è quello che il daemon salva nell'entry quando il click non riesce (prima la card diceva solo «✕ — chiudi») */}
          <Campione card="mcp-server" stato="errore"><McpServerCard entry={card(5, serverRemoto, { status: 'error', error: 'not installable here: the entry exposes neither remotes nor npm packages', errorCode: 'proposta.nonInstallabile' })} /></Campione>
        </Sezione>
      )
    case 'card-proposta-2':
      return (
        <Sezione titolo="PluginInstallProposal e McpWindowCard — plugin e server" testId="galleria-section-card-proposta-2">
          <Campione card="plugin-da-installare" stato="in attesa"><PluginInstallProposal entry={card(12, plugin)} /></Campione>
          <Campione card="plugin-da-installare" stato="decisa: installato"><PluginInstallProposal entry={card(13, plugin, { status: 'installed' })} /></Campione>
          <Campione card="plugin-da-installare" stato="errore"><PluginInstallProposal entry={card(14, plugin, { status: 'error', error: 'plugin download failed: 404 Not Found', errorCode: 'proposta.downloadFallito' })} /></Campione>
          <Campione card="finestra-mcp" stato="in attesa"><McpWindowCard entry={card(7, { type: 'mcp-window', service: 'Mattermost', reason: 'Per postare nel canale #lancio del tuo team.' })} /></Campione>
        </Sezione>
      )
    case 'card-plugin':
      return (
        <Sezione titolo="EnablePluginCard — accendere un plugin" testId="galleria-section-card-plugin">
          <Campione card="plugin-da-accendere" stato="in attesa"><EnablePluginCard entry={card(8, accendi)} /></Campione>
          <Campione card="plugin-da-accendere" stato="decisa: attivo"><EnablePluginCard entry={card(9, accendi, { status: 'activated', toolsCount: 12 })} /></Campione>
          <Campione card="plugin-da-accendere" stato="errore: non parte"><EnablePluginCard entry={card(11, accendi, { status: 'failed' })} /></Campione>
          <Campione card="plugin-da-accendere" stato="rifiutata: non ora"><EnablePluginCard entry={card(10, accendi, { status: 'declined' })} /></Campione>
        </Sezione>
      )
    case 'card-connettore':
      return (
        <Sezione titolo="ConnectorCard — collegare un’app" testId="galleria-section-card-connettore">
          <Campione card="connettore" stato="in attesa (diretta)"><ConnectorCard entry={card(15, connettore('notion', 'Notion'))} /></Campione>
          <Campione card="connettore" stato="in attesa (tramite Composio)"><ConnectorCard entry={card(17, connettore('composio:github', 'GitHub'))} /></Campione>
          <Campione card="connettore" stato="token scaduto"><ConnectorCard entry={card(19, connettore('notion', 'Notion'), { needsAuth: true })} /></Campione>
          <Campione card="connettore" stato="errore: non riuscito"><ConnectorCard entry={card(21, connettore('composio-app:slack', 'Slack'), { gatewayKey: 'gall-key-21' })} /></Campione>
        </Sezione>
      )
    case 'card-in-corso':
      return (
        <Sezione titolo="Gli stati che durano quanto un’attesa" testId="galleria-section-card-in-corso">
          <Campione card="connettore" stato="in corso: attesa del login"><ConnectorCard entry={card(18, connettore('composio-app:asana', 'Asana'), { gatewayKey: 'gall-key-18' })} /></Campione>
          <Campione card="connettore" stato="decisa: collegata"><ConnectorCard entry={card(20, connettore('notion', 'Notion'), { connected: true })} /></Campione>
          <Campione card="bozza" stato="in modifica">
            <DraftCard entry={bozza(9001, EMAIL)} />
            <Clic passi="modifica" />
          </Campione>
          <Campione card="approvazione" stato="le scelte (menu «Altre scelte»)">
            <ApprovalCard entry={SITO} />
            <Clic passi="altreScelte" />
          </Campione>
        </Sezione>
      )
    case 'card-approvazione-1':
      return (
        <Sezione titolo="ApprovalCard — la richiesta in attesa" testId="galleria-section-card-approvazione-1">
          <Campione card="approvazione" stato="in attesa: un comando"><ApprovalCard entry={COMANDO} /></Campione>
          <Campione card="approvazione" stato="in attesa: un sito"><ApprovalCard entry={SITO} /></Campione>
          <Campione card="approvazione" stato="in attesa: un'app Composio"><ApprovalCard entry={COMPOSIO} /></Campione>
          <Campione card="approvazione" stato="in attesa: un'app del Mac"><ApprovalCard entry={APP_MAC} /></Campione>
        </Sezione>
      )
    case 'card-approvazione-2':
      return (
        <Sezione titolo="ApprovalCard — dopo la decisione" testId="galleria-section-card-approvazione-2">
          <Campione card="approvazione" stato="decisa: consentita"><ApprovalCard entry={decisa(COMANDO, 'allowed')} /></Campione>
          <Campione card="approvazione" stato="decisa: rifiutata"><ApprovalCard entry={decisa(COMANDO, 'denied')} /></Campione>
          <Campione card="approvazione" stato="scaduta"><ApprovalCard entry={decisa(COMANDO, 'expired')} /></Campione>
          <Campione card="approvazione" stato="passata da sola (regola)"><ApprovalCard entry={AUTOMATICA} /></Campione>
          <Campione card="approvazione" stato="decisa, riaperta in sola lettura">
            <ApprovalCard entry={decisa(SITO, 'allowed')} />
            <Clic passi="riapri" />
          </Campione>
          <Campione card="approvazione" stato="in attesa, compatta (la card sta nel compositore)"><ApprovalCard entry={COMANDO} /></Campione>
        </Sezione>
      )
    case 'card-regola':
      return (
        <Sezione titolo="RuleProposalCard — la regola proposta dal bot" testId="galleria-section-card-regola">
          <Campione card="regola" stato="in attesa: continua da solo"><RuleProposalCard entry={regola(113, 'allow', 'comandi git status dentro il computer del bot', 'È un controllo in sola lettura: non cambia niente.')} /></Campione>
          <Campione card="regola" stato="in attesa: si ferma e chiede"><RuleProposalCard entry={regola(116, 'block', 'eliminare file fuori dalla cartella del bot', 'Non voglio cancellare niente di tuo per sbaglio.', undefined)} /></Campione>
          <Campione card="regola" stato="decisa: aggiunta"><RuleProposalCard entry={regola(114, 'allow', 'comandi ls dentro il computer del bot', 'È un controllo in sola lettura: non cambia niente.', 'added')} /></Campione>
          <Campione card="regola" stato="decisa: ignorata"><RuleProposalCard entry={regola(115, 'block', 'eliminare file fuori dalla cartella del bot', 'Non voglio cancellare niente di tuo per sbaglio.', 'dismissed')} /></Campione>
        </Sezione>
      )
    case 'card-compositore':
      return (
        <Sezione titolo="ComposerApproval e ApprovalsBanner — la richiesta al campo di scrittura" testId="galleria-section-card-compositore">
          <Campione card="compositore" stato="in attesa: una delle due"><ComposerApproval botId={NORA.id} /></Campione>
          <Campione card="barretta" stato="richieste in altre chat"><ApprovalsBannerElsewhere excludeBotId="gall-altro" /></Campione>
        </Sezione>
      )
    case 'card-bozza-1':
      return (
        <Sezione titolo="DraftCard — la bozza da inviare" testId="galleria-section-card-bozza-1">
          <Campione card="bozza" stato="in attesa: un'email"><DraftCard entry={bozza(9001, EMAIL)} /></Campione>
          <Campione card="bozza" stato="in attesa: senza canale di invio"><DraftCard entry={bozza(9002, { type: 'draft', channel: 'slack', to: '#amministrazione', body: 'Le fatture di novembre sono caricate.', sendHint: 'no-tool' })} /></Campione>
        </Sezione>
      )
    case 'card-bozza-2':
      return (
        <Sezione titolo="DraftCard — le altre bozze e la decisione" testId="galleria-section-card-bozza-2">
          <Campione card="bozza" stato="in attesa: via Composio"><DraftCard entry={bozza(9003, { type: 'draft', channel: 'email', to: 'fabio@azienda.test', subject: 'Nota spese', body: 'In nota le spese della settimana.', via: { tool: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', args: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'lavoro' }] } }, extraArgs: [{ key: 'cc', value: 'amministrazione@studio.test' }] })} /></Campione>
          <Campione card="bozza" stato="errore"><DraftCard entry={bozza(9007, EMAIL, { status: 'error', sendResult: 'Error: 401 Unauthorized' }, 33)} /></Campione>
          <Campione card="bozza" stato="decisa: inviata"><DraftCard entry={bozza(9004, EMAIL, { status: 'sent', sendResult: '{"id":"msg_1"}' }, 33)} /></Campione>
          <Campione card="bozza" stato="decisa: scartata"><DraftCard entry={bozza(9006, EMAIL, { status: 'discarded' }, 33)} /></Campione>
          <Campione card="bozza" stato="inviata da sola (regola)"><DraftCard entry={bozza(9005, EMAIL, { status: 'sent', autoApproved: true, ruleMatched: 'invii a *.studio.test' }, 33)} /></Campione>
        </Sezione>
      )
    case 'card-widget':
      return (
        <Sezione titolo="WidgetCard — la domanda con le scelte" testId="galleria-section-card-widget">
          <Campione card="widget" stato="in attesa"><WidgetCard entry={card(9101, { type: 'widget', prompt: 'Con chi preparo il preventivo?', helpText: 'Una sola risposta.', options: SCELTE, allowCustom: true }, {}, 24)} /></Campione>
          <Campione card="widget" stato="decisa: una scelta"><WidgetCard entry={domanda(9104, 'Con chi preparo il preventivo?', SCELTE, { respondedValue: 'fatture' }, 22)} /></Campione>
          <Campione card="widget" stato="decisa: testo libero"><WidgetCard entry={domanda(9106, 'Con chi preparo il preventivo?', SCELTE, { respondedValue: 'Alle 8', allowCustom: true }, 21)} /></Campione>
          <Campione card="widget" stato="scavalcata"><WidgetCard entry={domanda(9107, 'Con chi preparo il preventivo?', SCELTE, { widgetDismissed: true }, 20)} /></Campione>
        </Sezione>
      )
    case 'card-aiutante':
      return (
        <Sezione titolo="SubagentCard — l'aiutante al lavoro" testId="galleria-section-card-aiutante">
          <Campione card="aiutante" stato="in corso"><SubagentCard entry={compitoAiutante(9201, 'gall-sub-1')} /></Campione>
          <Campione card="aiutante" stato="in coda"><SubagentCard entry={compitoAiutante(9202, 'gall-sub-2')} /></Campione>
          <Campione card="aiutante" stato="finito"><SubagentCard entry={compitoAiutante(9204, 'gall-sub-4')} /></Campione>
          <Campione card="aiutante" stato="fallito"><SubagentCard entry={compitoAiutante(9205, 'gall-sub-5')} /></Campione>
        </Sezione>
      )
    case 'card-aiutante-aspetta':
      return (
        <Sezione titolo="SubagentCard — l'aiutante che aspetta te, e quello interrotto" testId="galleria-section-card-aiutante-aspetta">
          <Campione card="aiutante" stato="aspetta te (con la richiesta dell'aiutante)"><SubagentCard entry={compitoAiutante(9203, 'gall-sub-3')} /></Campione>
          <Campione card="aiutante" stato="interrotto"><SubagentCard entry={compitoAiutante(9206, 'gall-sub-6')} /></Campione>
        </Sezione>
      )
    case 'card-compito':
      return (
        <Sezione titolo="BriefCard — il compito affidato all'aiutante" testId="galleria-section-card-compito">
          <Campione card="compito" stato="chiuso (tre righe)"><BriefCard entry={BRIEF} /></Campione>
          <Campione card="compito" stato="aperto">
            <BriefCard entry={BRIEF} />
            <Clic passi="mostraTutto" />
          </Campione>
        </Sezione>
      )
    case 'card-attivita':
      return (
        <Sezione titolo="TaskCard — il task in corso" testId="galleria-section-card-attivita">
          <Campione card="task" stato="in corso"><TaskCard entry={attivitaCard(9401, 41, 'Ordina i preventivi per cliente')} /></Campione>
          <Campione card="task" stato="attende la tua risposta"><TaskCard entry={attivitaCard(9402, 42, 'Riconcilia le fatture di novembre', 0)} /></Campione>
          <Campione card="task" stato="completato"><TaskCard entry={attivitaCard(9403, 43, 'Archivia i preventivi 2025', 120)} /></Campione>
          <Campione card="task" stato="non riuscito"><TaskCard entry={attivitaCard(9404, 44, 'Calcola il margine per cliente', 120)} /></Campione>
          <Campione card="task" stato="annullato"><TaskCard entry={attivitaCard(9405, 45, 'Prepara la lettera di incarico', 120)} /></Campione>
        </Sezione>
      )
    case 'card-presa':
      return (
        <Sezione titolo="ImageGalleryCard e TakeoverCard — le immagini, la presa di controllo" testId="galleria-section-card-presa">
          <Campione card="immagini" stato="la galleria"><ImageGalleryCard entry={GALLERIA_IMMAGINI} /></Campione>
          <Campione card="presa-di-controllo" stato="in attesa"><TakeoverCard entry={presa(9201)} /></Campione>
          <Campione card="presa-di-controllo" stato="decisa: hai finito"><TakeoverCard entry={presa(9202, 'done')} /></Campione>
          <Campione card="presa-di-controllo" stato="scaduta"><TakeoverCard entry={presa(9203, 'expired')} /></Campione>
        </Sezione>
      )
    case 'card-routine':
      return (
        <Sezione titolo="RoutineCreatedRow e RoutineTzAsk — la routine appena creata" testId="galleria-section-card-routine">
          <Campione card="routine-creata" stato="in attesa: da attivare"><RoutineCreatedRow entry={routineCreata(9501, { action: 'create', id: 401, name: ROUTINE })} /></Campione>
          <Campione card="routine-creata" stato="solo l'avviso (nessuna routine)"><RoutineCreatedRow entry={routineCreata(9502, { action: 'create' })} /></Campione>
          <Campione card="fuso-orario" stato="chiede il fuso"><RoutineTzAsk routineId={401} onDone={() => undefined} /></Campione>
          <Campione card="routine-creata" stato="decisa: attivata">
            <RoutineCreatedRow entry={routineCreata(9503, { action: 'create', id: 401, name: ROUTINE })} />
            <Clic passi="attiva" />
          </Campione>
        </Sezione>
      )
  }
}
