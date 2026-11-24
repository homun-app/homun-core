// Fase 16b (S5): la squadra è una vista di prima classe — la selezioni nella
// barra e occupa il posto della chat, col layout di S3 (pillola sospesa). I
// messaggi dei bot: mascotte 34 px e nome nel colore del bot; le @menzioni
// sono pillole colorate; il riepilogo del coordinatore (S1.2) è una bolla
// tenue tinta col suo colore. Mentre un membro lavora: la sua mascotte con
// la mezza riga d'attività.
//
// Fase design (DS4): la timeline della squadra parla come la chat — la stessa
// colonna di lettura (PageColumn reading: 720 px, l'area meno i margini se è
// più stretta), i messaggi in text-reading, LO STESSO MARKDOWN di ogni
// messaggio di bot (BotMarkdown: prima qui il testo era nudo), le righe di
// sistema con Notice, il campo di scrittura alla larghezza della colonna, i
// controlli di Button. Le @menzioni restano pillole nel colore del bot
// menzionato, e si cercano DENTRO i pezzi di testo dell'albero reso
// (lib/mentions.ts): prima il testo si spezzava a mano attorno a loro.
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ArrowRight, ArrowUp, FileText, PanelRight } from 'lucide-react'
import { api } from '../store'
import { useStore } from '../store'
import { avatarOf } from '../../../shared/avatar'
import type { GroupInfo, GroupMessageInfo, Agent } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { activityPhrase } from '../lib/activity'
import { i18n } from '../lib/i18n'
import { mapText, splitMentions } from '../lib/mentions'
import { cn } from '../lib/utils'
import { groupSystemText } from './Chat'
// Q1 (fase squadra): la pillola dell'autonomia nella fascia alta (tavola 1)
import { autonomyShortLabel } from './TeamAutonomySheet'
// Q2 (fase squadra): la barra delle azioni in attesa e la coda (tavole 1 e 2)
import { pendingWantsLine } from './ApprovalsQueue'
// A3 (fase centro-autorizzazioni): il riquadro globale ridotto sopra la barra di Q2
import { ApprovalsBannerElsewhere } from './ApprovalsBanner'
// Q6 (fase squadra): la pagina si apre a lato anche dentro la chat di squadra
import { PageView } from './PageView'
// fase design (DS4): il campo di scrittura è una superficie a una riga come a
// dieci (niente più il raggio dinamico di M1: i raggi sono tre); resta il
// LAYOUT a più righe, con la MISURA del textarea
import { composerMultiFromMeasure, composerLayout, nextComposerMulti, TEAM_COMPOSER_SINGLE_ROW_PX } from '../lib/composer'
import { BotMarkdown, proseWithText } from './DocumentMarkdown'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { PageColumn } from './ui/page-shell'

// le due funzioni pure delle menzioni (lib/mentions.ts): da qui le importano i test
export { mapText, splitMentions }

/**
 * Un componente per `tag` che rende lo stesso tag coi figli passati da
 * mapText: è ciò che react-markdown dà a ogni elemento (`node` è il suo nodo
 * dell'albero del markdown e NON va sul tag). `fn` fa di un pezzo di testo
 * ciò che deve — la squadra: le @menzioni in pillole.
 */
export function withMentions(tag: string, fn: (text: string) => ReactNode): (props: Record<string, unknown>) => ReactNode {
  const Menzionato = ({ node: _node, ...props }: Record<string, unknown>): ReactNode =>
    createElement(tag, { ...props, children: mapText(props.children as ReactNode, fn) } as never)
  return Menzionato
}

/** La pillola di una @menzione: nel colore del bot menzionato (@tutti: il primo membro). */
function MentionPill({ text, members, agents, effectiveMain }: {
  text: string
  members: Array<{ agentId: string; name: string }>
  agents: Agent[]
  effectiveMain: string | null
}) {
  const name = text.slice(1)
  const member = members.find((m) => m.name === name) ?? (name === 'tutti' ? members[0] : undefined)
  const agent = member ? agents.find((a) => a.id === member.agentId) : undefined
  const av = agent ? avatarOf(agent, agents, effectiveMain) : null
  // la taglia è quella del testo intorno (prima 0.92 em scritto a mano)
  return (
    <span
      className="rounded-full px-1.5 font-medium"
      style={av ? { background: `var(--bot-${av.color})`, color: 'var(--bot-ink)' } : { background: 'var(--muted)' }}
    >
      {text}
    </span>
  )
}

/** La bolla di ogni messaggio di bot: la stessa della chat (superficie, testo di lettura). */
const BOLLA_BOT = 'min-w-0 rounded-surface bg-muted px-4 py-2 text-reading'
/** La riga di un messaggio: mascotte e testo, larga quanto il testo fino all'85% della colonna. */
const RIGA_BOT = 'flex w-fit max-w-[85%] gap-3'

/** Il messaggio di un bot: mascotte, nome nel suo colore, il testo come markdown (con le menzioni). */
function TeamBotMessage({ m, group }: { m: GroupMessageInfo; group: GroupInfo }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const info = useBotInfo(m.authorId)
  // le @menzioni dentro il testo: pillole nel colore del bot menzionato
  const members = group.members
  const pill = useCallback((text: string): ReactNode => splitMentions(text, members.map((x) => x.name)).map((p, i) =>
    p.startsWith('@') ? <MentionPill key={i} text={p} members={members} agents={agents} effectiveMain={effectiveMain} /> : p
  ), [members, agents, effectiveMain])
  // nel markdown le menzioni si cercano nei pezzi di testo di ogni elemento (le regole restano quelle di DS1)
  const components = useMemo(() => proseWithText(pill), [pill])
  const agent = agents.find((a) => a.id === m.authorId)
  if (!agent) return null
  const av = avatarOf(agent, agents, effectiveMain)
  const color = `var(--bot-${av.color})`
  const isCoord = group.coordinatorId === m.authorId
  // il riepilogo di chiusura (S1.2): bolla tenue tinta col colore del
  // coordinatore (12% sul fondo), titolo «<Coordinatore> · riepilogo per te».
  // È testo piano, a capo compresi (non markdown): le menzioni ci sono lo stesso
  if (m.summary) {
    return (
      <div className={RIGA_BOT}>
        {info && <Bot family={info.avatar.family} color={info.avatar.color} state="idle" size={34} track={false} />}
        <div className="min-w-0 rounded-surface px-4 py-3" style={{ background: `color-mix(in oklab, ${color} 12%, var(--muted))` }}>
          <p className="text-caption font-medium" style={{ color }}>{m.authorName} · <Trans>riepilogo per te</Trans></p>
          <p className="mt-1 whitespace-pre-wrap text-reading">{mapText(m.text, pill)}</p>
        </div>
      </div>
    )
  }
  return (
    <div className={RIGA_BOT}>
      {info && <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={34} track={false} dimmed={info.dimmed} />}
      <div className="min-w-0">
        <p className="mb-1 text-small font-medium" style={{ color }}>
          {m.authorName}{isCoord ? <span className="ml-1 text-caption font-normal text-muted-foreground">· <Trans>coordinatore</Trans></span> : null}
        </p>
        <div className={BOLLA_BOT}>
          <BotMarkdown text={m.text} components={components} />
        </div>
      </div>
    </div>
  )
}

/** Q4: il payload JSON delle righe di sola visualizzazione (difensivo). */
interface RelayPayload { to?: string; toName?: string; text?: string; reply?: boolean }
interface ArtifactPayload { kind?: string; id?: string; title?: string; path?: string }

/** Q4: la riga compatta dello scambio tra bot («Treni → Alloggio: …»). */
function RelayRow({ m }: { m: GroupMessageInfo }) {
  let p: RelayPayload = {}
  try { p = JSON.parse(m.text) as RelayPayload } catch { p = { text: m.text } }
  return (
    <p className="flex items-center gap-row-gap text-small text-muted-foreground" data-testid="relay-row">
      <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true"><ArrowRight className="size-4" /></span>
      <span className="min-w-0 truncate">
        <span className="font-medium">{m.authorName}</span> → <span className="font-medium">{p.toName ?? '…'}</span>: {p.text}
      </span>
    </p>
  )
}

/** Q4: la card che si apre — documento della Libreria («apri a lato») o file della cartella condivisa («si apre qui»). */
function ArtifactCard({ m, agents }: { m: GroupMessageInfo; agents: Agent[] }) {
  let p: ArtifactPayload = {}
  try { p = JSON.parse(m.text) as ArtifactPayload } catch { p = { title: m.text } }
  const openPage = useStore((s) => s.openPage)
  const [preview, setPreview] = useState<string | null>(null)
  const isDoc = p.kind === 'document' && !!p.id
  const info = useBotInfo(m.authorId ?? null)
  return (
    <div className="flex max-w-[85%] items-center gap-3 rounded-surface bg-muted/60 px-4 py-2">
      {info && <Bot family={info.avatar.family} color={info.avatar.color} state="idle" size={28} track={false} />}
      <div className="min-w-0">
        <button
          className="flex min-w-0 items-center gap-1.5 text-left text-body font-medium underline-offset-2 transition hover:underline"
          data-testid="artifact-card"
          onClick={() => {
            if (isDoc) openPage(p.id!, 'library')
            else if (p.path) void api.filesRead(m.authorId ?? agents[0]?.id ?? '', p.path).then((r) => setPreview(r && r.kind === 'text' ? r.content : '(file binario)')).catch(() => setPreview(null))
          }}
        >
          <FileText className="size-4 shrink-0" aria-hidden /> {p.title ?? 'file'}
        </button>
        <p className="text-caption text-muted-foreground">
          {m.authorName} · {isDoc ? <Trans>apri a lato</Trans> : <Trans>si apre qui</Trans>}
        </p>
      </div>
      {preview !== null && (
        <pre className="max-h-40 flex-1 overflow-auto scroll-thin whitespace-pre-wrap rounded-control bg-card px-3 py-2 text-caption">{preview}</pre>
      )}
    </div>
  )
}

/** Q2/Q4: la card di approvazione dentro la timeline, nel punto in cui è nata. */
function TimelineApprovalCard({ c }: { c: { agentId: string; agentName: string; approvalId: string; phrase: string; pending: boolean; fixed: boolean } }) {
  const resolveGroupApproval = useStore((s) => s.resolveGroupApproval)
  return (
    <div className="w-fit max-w-[85%] rounded-surface bg-card px-4 py-3 shadow-soft" data-testid="timeline-approval">
      <p className="text-caption text-muted-foreground">
        {c.agentName} · <Trans>chiede a te</Trans>{c.fixed ? <> · <Trans>sempre a te</Trans></> : null}
      </p>
      <p className="mt-1 text-reading">{c.phrase}</p>
      {c.pending ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => resolveGroupApproval(c.agentId, c.approvalId, 'allow', 'once')}>
            <Trans>Consenti una volta</Trans>
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => resolveGroupApproval(c.agentId, c.approvalId, 'deny', 'once')}>
            <Trans>Rifiuta</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** La mascotte di un membro che lavora, con la mezza riga (S5 + S3.3). */
function MemberActivity({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const info = useBotInfo(agentId)
  const activity = useStore((s) => s.activity[agentId])
  if (!info) return null
  const d = info.state === 'thinking' && !activity ? msg`pensa…` : activityPhrase(activity, 'present', i18n.locale === 'en' ? 'en' : 'it')
  return (
    <div className="flex items-center gap-3">
      <span className="flex flex-col items-center">
        <Bot family={info.avatar.family} color={info.avatar.color} state={info.state === 'thinking' ? 'thinking' : 'speaking'} size={34} track={false} />
        <span aria-hidden="true" className="mt-1 h-1.5 w-7 rounded-full bg-foreground/10" />
      </span>
      <span aria-live="polite" className="text-body text-muted-foreground">
        {info.agent.name}{' '}{i18n.t(d)}
      </span>
    </div>
  )
}

export function TeamChat() {
  const { t, i18n } = useLingui()
  const groups = useStore((s) => s.groups)
  const openGroupId = useStore((s) => s.openGroupId)
  const groupMessages = useStore((s) => s.groupMessages)
  const agents = useStore((s) => s.agents)
  const sendGroupMessage = useStore((s) => s.sendGroupMessage)
  // Q2 (fase squadra): le azioni in attesa e la coda
  const groupPending = useStore((s) => s.groupPending)
  const groupCards = useStore((s) => s.groupCards)
  const setApprovalsQueueOpen = useStore((s) => s.setApprovalsQueueOpen)
  const rightPanel = useStore((s) => s.rightPanel)
  const setRightPanel = useStore((s) => s.setRightPanel)
  // G2 (fase 0.3.1001 grafica): pannello chiuso → il focus torna al bottone
  // PanelRight che ricompare
  const panelFocusRestore = useStore((s) => s.panelFocusRestore)
  const panelBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (panelFocusRestore > 0) panelBtnRef.current?.focus()
  }, [panelFocusRestore])
  const [text, setText] = useState('')
  // M1 (fase beta12-correzioni): come Chat — da due righe in su il campo va a
  // tutta larghezza, deciso dalla misura del textarea (fase design: il raggio
  // non cambia più, è sempre quello delle superfici)
  const [multiState, setMultiState] = useState({ multi: false, enteredAt: 0 })
  const multiRow = multiState.multi
  useEffect(() => {
    const ta = taRef.current
    const measured = ta ? composerMultiFromMeasure(ta.scrollHeight, TEAM_COMPOSER_SINGLE_ROW_PX) : false
    setMultiState((prev) => nextComposerMulti(prev, text, measured))
  }, [text])
  const layoutCls = composerLayout(multiRow)
  const [mentionIdx, setMentionIdx] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const group = groups.find((g) => g.id === openGroupId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [groupMessages.length])

  // autocompletamento @: i membri il cui nome inizia col testo dopo la @
  const memberAgent = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const mentionQuery = (() => {
    const el = taRef.current
    if (!el) return null
    const upto = text.slice(0, el.selectionStart ?? text.length)
    const m = /@([^\s@]*)$/.exec(upto)
    return m ? m[1]!.toLowerCase() : null
  })()
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !group) return []
    return group.members.filter((m) => m.name.toLowerCase().startsWith(mentionQuery))
  }, [mentionQuery, group])
  const pickMention = (name: string): void => {
    const el = taRef.current
    const at = el ? el.selectionStart ?? text.length : text.length
    const before = text.slice(0, at).replace(/@([^\s@]*)$/, `@${name} `)
    setText(before + text.slice(at))
    setMentionIdx(0)
    el?.focus()
  }

  if (openGroupId === null) return null
  if (!group) {
    const openGroup = useStore.getState().openGroup
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        <button className="text-body transition hover:text-foreground" onClick={() => openGroup(null)}>
          <Trans>Team non più disponibile — chiudi</Trans>
        </button>
      </main>
    )
  }

  const coordinator = memberAgent(group.coordinatorId ?? '')
  // chi lavora adesso: i membri in turno (max 3, uno per mascotte)
  const working = group.members
    .map((m) => memberAgent(m.agentId))
    .filter((a): a is Agent => !!a && (a.status === 'thinking' || a.status === 'running'))
    .slice(0, 3)
  const placeholder = coordinator
    ? i18n.t(msg`Scrivi al team · risponde ${coordinator.name} (@ per un altro)`)
    : i18n.t(msg`Scrivi al team (@ per un bot)`)

  const sendNow = (): void => {
    if (!text.trim()) return
    sendGroupMessage(text)
    setText('')
  }

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      {/* Q6 (fase squadra): PageView copre la timeline quando una pagina è
          aperta (dalla Libreria, dalle card della timeline e da «Prodotto
          dalla squadra») — lo stesso componente della chat uno-a-uno */}
      <PageView />
      {/* fase 16b correzioni 2 (Q3): la pillola della squadra (nome + chi
          risponde, che tronca) sulla riga in cima e bottone del pannello a
          destra. Fase design (DS3): alta 52 come la testata di OGNI colonna
          (h-col-head, letta dalla sonda), i controlli da 32 (size-control-sm).
          G3 (fase 0.3.1001 grafica): la pillola è un BOTTONE che apre/chiude
          il pannello dei membri (no-drag; attorno resta il trascinamento).
          G2: a pannello APERTO il bottone PanelRight sparisce — resta la ✕ —
          ma il posto w-8 resta occupato, così la pillola non salta.
          La riga interna è larga quanto la testata (w-full): la testata è un
          flex in RIGA e una figlia è larga quanto il suo contenuto — senza, lo
          spazio che centra la pillola non c'è e la pillola resta a sinistra */}
      {/* R2 (b20-ritocchi): col-head-velo — il corpo della squadra scorre SOTTO la fascia */}
      <div data-col-head="chat" className="col-head-velo drag-region absolute inset-x-0 top-0 z-10 flex h-col-head">
        <div className="flex h-full w-full min-w-0 items-center gap-3 px-4">
          <span className="w-8 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              className="no-drag flex h-control-sm min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-card/95 px-4 text-left shadow-soft transition hover:bg-card"
              aria-expanded={rightPanel}
              aria-label={rightPanel ? t`Nascondi il pannello dei membri` : t`Mostra il pannello dei membri`}
              title={rightPanel ? t`Nascondi il pannello dei membri` : t`Mostra il pannello dei membri`}
              onClick={() => setRightPanel(!rightPanel)}
            >
              <span className="truncate text-body font-medium">{group.name}</span>
              {coordinator && (
                <span className="truncate text-small text-muted-foreground">· <Trans>Risponde {coordinator.name}</Trans></span>
              )}
              {/* Q1 (fase squadra): l'autonomia della squadra, come nel disegno */}
              <span className="shrink-0 truncate text-small text-muted-foreground">· <Trans>Autonomia:</Trans> {autonomyShortLabel(group.autonomy, i18n)}</span>
            </button>
          </span>
          {rightPanel ? (
            <span className="w-8 shrink-0" aria-hidden="true" />
          ) : (
            <button
              ref={panelBtnRef}
              className="no-drag grid size-control-sm shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
              aria-label={t`Mostra il pannello dei membri`}
              title={t`Mostra il pannello dei membri`}
              onClick={() => setRightPanel(true)}
            >
              <PanelRight className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* A3 (fase centro-autorizzazioni): sopra resta il riquadro GLOBALE,
          ridotto («+N altrove»), solo per richieste di altre squadre o bot —
          la barra della squadra è quella di Q2, dentro la colonna */}
      <ApprovalsBannerElsewhere />
      {/* Fase design (DS4): LA COLONNA DI LETTURA, come nella chat (fatta a
          mano come fa PageShell: qui la testata è sospesa sul transcript). Il
          contenitore che scorre è largo quanto l'AREA (niente respiro
          laterale: la barra sta sul bordo destro) e riserva la sua barra su
          tutti e due i lati (scrollbar-gutter: la barra di scroll-thin OCCUPA
          6 px, riservati da un lato solo il contenuto sarebbe 3 px fuori
          centro); DENTRO il contenuto è centrato alla larghezza di lettura
          (PageColumn reading: min(720, area − 12 − 2·margine)). Il contenitore
          di query è questo involucro, NON <main> (la containment di layout
          farebbe di <main> il riferimento dei position:fixed) */}
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
        >
          {/* pt-16 = 64: la testata sospesa (52) + il respiro di 12; pb-4: 16 prima del campo */}
          <PageColumn width="reading" className="flex flex-col gap-3 pb-4 pt-16">
            {/* Q2 (fase squadra): la barra in cima — quante azioni aspettano te e
                chi le chiede, con «Rivedi tutte» (tavola 1) */}
            {groupPending.length > 0 && (
              <div className="rounded-surface bg-card px-4 py-3 shadow-soft" data-testid="team-pending-bar">
                <p className="text-body">
                  <span className="font-semibold"><Trans>{groupPending.length} azioni aspettano te</Trans></span>
                  <span className="text-muted-foreground"> · {groupPending.slice(0, 3).map((r) => pendingWantsLine(r, i18n)).join(' · ')}{groupPending.length > 3 ? ' · …' : ''}</span>
                </p>
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => setApprovalsQueueOpen(true)}>
                  <Trans>Rivedi tutte</Trans>
                </Button>
              </div>
            )}
            {groupMessages.length === 0 && (
              <p className="mt-16 text-center text-small text-muted-foreground"><Trans>Nessun messaggio nel team.</Trans></p>
            )}
            {/* Q4 (fase squadra): la timeline fonde i messaggi e le card di
                approvazione nate nei turni della squadra, nel punto in cui sono
                nate (ordine per tempo) */}
            {(() => {
              type Row = { key: string; at: number; node: ReactNode }
              const rows: Row[] = []
              for (const m of groupMessages) {
                const node =
                  m.authorKind === 'system' ? (
                    // le righe di sistema con Notice (il testo tradotto: groupSystemText di Chat)
                    <Notice className="justify-center"><span className="text-center">{groupSystemText(m.text)}</span></Notice>
                  ) : m.authorKind === 'user' ? (
                    <div className="flex justify-end">
                      {/* G1 (fase 0.3.1001 grafica): bolla utente NEUTRA, gli stessi
                          token --bubble-user della chat uno-a-uno. Fase design
                          (DS4): text-reading, al massimo l'85% della colonna,
                          il raggio delle superfici (prima 75% e l'angolo stretto) */}
                      <div className="min-w-0 max-w-[85%] rounded-surface wrap-anywhere bg-[var(--bubble-user)] px-4 py-2 text-reading whitespace-pre-wrap text-[var(--bubble-user-foreground)]">
                        {m.text}
                      </div>
                    </div>
                  ) : m.authorKind === 'relay' ? (
                    <RelayRow m={m} />
                  ) : m.authorKind === 'artifact' ? (
                    <ArtifactCard m={m} agents={agents} />
                  ) : (
                    <TeamBotMessage m={m} group={group} />
                  )
                rows.push({ key: `m${m.id}`, at: m.createdAt, node })
              }
              for (const c of groupCards) {
                rows.push({ key: `c${c.id}`, at: c.when, node: <TimelineApprovalCard c={c} /> })
              }
              rows.sort((a, b) => a.at - b.at)
              return rows.map((r) => <div key={r.key}>{r.node}</div>)
            })()}
            {working.length > 0 && (
              <div className="flex flex-col gap-2 pt-1">
                {working.map((a) => (
                  <MemberActivity key={a.id} agentId={a.id} />
                ))}
              </div>
            )}
          </PageColumn>
        </div>
      </div>

      {/* il campo: segnaposto di S3.4, autocompletamento @ sui membri.
          correzioni 2 (Q2): @container sul footer, il campo non scende mai
          sotto 120 px e il bottone Invia resta DENTRO; il popup @ non supera
          mai il bordo (Q4). Fase design (DS4): il campo sta in una PageColumn
          reading, la STESSA del transcript; px-1.5 sull'involucro della colonna
          perché il corpo che scorre riserva 6 px di barra per lato. Il campo è
          una superficie (rounded-surface) a una riga come a dieci, i controlli
          di Button (Invia da 36, come il campo) */}
      <footer className="@container shrink-0 pb-4">
        <div className="px-1.5">
          <PageColumn width="reading" className="flex flex-col">
            <div className="relative">
              {mentionOptions.length > 0 && (
                <div className="absolute bottom-full left-4 z-10 mb-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-surface bg-card p-1 shadow-soft">
                  {mentionOptions.map((m, i) => (
                    <button
                      key={m.agentId}
                      className={cn('flex h-control-sm w-full items-center gap-2 rounded-control px-3 text-left text-body transition', i === mentionIdx ? 'bg-muted' : 'hover:bg-muted/60')}
                      onClick={() => pickMention(m.name)}
                    >
                      <span className="text-muted-foreground">@</span>{m.name}
                      {group.coordinatorId === m.agentId && <span className="ml-auto text-caption text-muted-foreground"><Trans>coordinatore</Trans></span>}
                    </button>
                  ))}
                </div>
              )}
              <form
                className={cn('flex items-end gap-2 rounded-surface bg-card py-2 pl-3 pr-2 shadow-soft', layoutCls.form)}
                onSubmit={(e) => { e.preventDefault(); sendNow() }}
              >
                <textarea
                  ref={taRef}
                  className={cn('max-h-40 min-h-control min-w-30 flex-1 resize-none bg-transparent py-2 pr-5 pl-3 text-body outline-none placeholder:text-muted-foreground', layoutCls.field)}
                  placeholder={placeholder}
                  rows={Math.min(4, text.split('\n').length)}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (mentionOptions.length > 0 && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(e.key)) {
                      e.preventDefault()
                      if (e.key === 'Escape' || e.key === 'Tab') { setMentionIdx(0); setText(text) }
                      else setMentionIdx((i) => (e.key === 'ArrowDown' ? (i + 1) % mentionOptions.length : (i - 1 + mentionOptions.length) % mentionOptions.length))
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (mentionOptions.length > 0) pickMention(mentionOptions[mentionIdx]!.name)
                      else sendNow()
                    }
                  }}
                />
                <Button
                  type="submit"
                  aria-label={t`Invia`}
                  title={t`Invia`}
                  disabled={!text.trim()}
                  className={layoutCls.push}
                >
                  <ArrowUp className="size-4" />
                </Button>
              </form>
            </div>
          </PageColumn>
        </div>
      </footer>
    </main>
  )
}
