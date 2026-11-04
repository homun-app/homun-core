// Fase 16b (S5): la squadra è una vista di prima classe — la selezioni nella
// barra e occupa il posto della chat, col layout di S3 (etichetta sospesa,
// niente testata). I messaggi dei bot: mascotte 34 px e nome nel colore del
// bot, testo nudo come nel mockup; le @menzioni sono pillole colorate; il
// riepilogo del coordinatore (S1.2) è una bolla tenue tinta col suo colore.
// Mentre un membro lavora: la sua mascotte con la mezza riga d'attività.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ArrowUp, PanelRight } from 'lucide-react'
import { useStore } from '../store'
import { avatarOf } from '../../../shared/avatar'
import type { GroupInfo, GroupMessageInfo, Agent } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { activityPhrase } from '../lib/activity'
import { i18n } from '../lib/i18n'
import { groupSystemText } from './Chat'

/** Il testo col le @menzioni rese come pillole nel colore del bot menzionato. */
function MentionedText({ text, members, agents, effectiveMain }: {
  text: string
  members: Array<{ agentId: string; name: string }>
  agents: Agent[]
  effectiveMain: string | null
}) {
  const parts = useMemo(() => {
    // nomi ordinati per lunghezza decrescente: vince il più lungo («Ana Maria»)
    const names = members.map((m) => m.name).filter((n) => n.trim()).sort((a, b) => b.length - a.length)
    if (!names.length) return [text]
    const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|tutti))`, 'g')
    return text.split(re)
  }, [text, members])
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null
        if (p.startsWith('@')) {
          const name = p.slice(1)
          const member = members.find((m) => m.name === name) ?? (name === 'tutti' ? members[0] : undefined)
          const agent = member ? agents.find((a) => a.id === member.agentId) : undefined
          const av = agent ? avatarOf(agent, agents, effectiveMain) : null
          return (
            <span
              key={i}
              className="rounded-full px-1.5 py-px text-[0.92em]"
              style={av ? { background: `var(--bot-${av.color})`, color: 'var(--bot-ink)' } : { background: 'var(--muted)' }}
            >
              {p}
            </span>
          )
        }
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

/** Il messaggio di un bot: mascotte, nome nel suo colore, testo nudo. */
function TeamBotMessage({ m, group }: { m: GroupMessageInfo; group: GroupInfo }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const agent = agents.find((a) => a.id === m.authorId)
  const info = useBotInfo(m.authorId)
  if (!agent) return null
  const av = avatarOf(agent, agents, effectiveMain)
  const color = `var(--bot-${av.color})`
  const isCoord = group.coordinatorId === m.authorId
  // il riepilogo di chiusura (S1.2): bolla tenue tinta col colore del
  // coordinatore (12% sul fondo), titolo «<Coordinatore> · riepilogo per te»
  if (m.summary) {
    return (
      <div className="flex max-w-[85%] gap-3">
        {info && <Bot family={info.avatar.family} color={info.avatar.color} state="idle" size={34} track={false} />}
        <div className="min-w-0 flex-1 rounded-[20px] px-4 py-3" style={{ background: `color-mix(in oklab, ${color} 12%, var(--muted))` }}>
          <p className="text-xs font-medium" style={{ color }}>{m.authorName} · <Trans>riepilogo per te</Trans></p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{m.text}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex max-w-[85%] gap-3">
      {info && <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={34} track={false} dimmed={info.dimmed} />}
      <div className="min-w-0">
        <p className="text-sm font-medium" style={{ color }}>
          {m.authorName}{isCoord ? <span className="ml-1 text-xs text-muted-foreground">· <Trans>coordinatore</Trans></span> : null}
        </p>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
          <MentionedText text={m.text} members={group.members} agents={agents} effectiveMain={effectiveMain} />
        </p>
      </div>
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
      <span aria-live="polite" className="text-sm text-muted-foreground">
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
        <button className="transition hover:text-foreground" onClick={() => openGroup(null)}>
          <Trans>Squadra non più disponibile — chiudi</Trans>
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
    ? i18n.t(msg`Scrivi alla squadra · risponde ${coordinator.name} (@ per un altro)`)
    : i18n.t(msg`Scrivi alla squadra (@ per un bot)`)

  const sendNow = (): void => {
    if (!text.trim()) return
    sendGroupMessage(text)
    setText('')
  }

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      {/* fase 16b correzioni 2 (Q3): la fascia alta di 60 px come nella chat —
          pillola della squadra (nome + chi risponde, che tronca) sulla riga
          comune y 12–48 e bottone del pannello a destra.
          G3 (fase 0.3.1001 grafica): la pillola è un BOTTONE che apre/chiude
          il pannello dei membri (no-drag; attorno resta il trascinamento).
          G2: a pannello APERTO il bottone PanelRight sparisce — resta la ✕ —
          ma il posto w-9 resta occupato, così la pillola non salta */}
      <div className="drag-region absolute inset-x-0 top-0 z-10 flex h-[60px] flex-col">
        <div className="mt-3 flex h-9 items-center gap-3 px-4">
          <span className="w-9 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              className="no-drag flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-card/95 py-1.5 pl-4 pr-4 text-left shadow-soft transition hover:bg-card"
              aria-expanded={rightPanel}
              aria-label={rightPanel ? t`Nascondi il pannello dei membri` : t`Mostra il pannello dei membri`}
              title={rightPanel ? t`Nascondi il pannello dei membri` : t`Mostra il pannello dei membri`}
              onClick={() => setRightPanel(!rightPanel)}
            >
              <span className="truncate text-[15px] font-medium">{group.name}</span>
              {coordinator && (
                <span className="truncate text-[13px] text-muted-foreground">· <Trans>Risponde {coordinator.name}</Trans></span>
              )}
            </button>
          </span>
          {rightPanel ? (
            <span className="w-9 shrink-0" aria-hidden="true" />
          ) : (
            <button
              ref={panelBtnRef}
              className="no-drag grid size-9 shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
              aria-label={t`Mostra il pannello dei membri`}
              title={t`Mostra il pannello dei membri`}
              onClick={() => setRightPanel(true)}
            >
              <PanelRight className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 pb-4 pt-16">
        {groupMessages.length === 0 && (
          <p className="mt-16 text-center text-sm text-muted-foreground"><Trans>Nessun messaggio nella squadra.</Trans></p>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {groupMessages.map((m) =>
            m.authorKind === 'system' ? (
              <p key={m.id} className="text-center text-xs text-muted-foreground">{groupSystemText(m.text)}</p>
            ) : m.authorKind === 'user' ? (
              <div key={m.id} className="flex justify-end">
                {/* G1 (fase 0.3.1001 grafica): bolla utente NEUTRA, gli stessi
                    token --bubble-user della chat uno-a-uno */}
                <div className="max-w-[75%] rounded-[20px] rounded-br-md bg-[var(--bubble-user)] px-4 py-2.5 text-sm whitespace-pre-wrap text-[var(--bubble-user-foreground)]">
                  {m.text}
                </div>
              </div>
            ) : (
              <TeamBotMessage key={m.id} m={m} group={group} />
            )
          )}
          {working.length > 0 && (
            <div className="space-y-2 pt-1">
              {working.map((a) => (
                <MemberActivity key={a.id} agentId={a.id} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* il campo: segnaposto di S3.4, autocompletamento @ sui membri.
          correzioni 2 (Q2): @container sul footer, il campo non scende mai
          sotto 120 px e il bottone Invia resta DENTRO la pillola; il popup @
          non supera mai il bordo (Q4) */}
      <footer className="@container px-6 pb-4">
        <div className="relative mx-auto max-w-3xl">
          {mentionOptions.length > 0 && (
            <div className="absolute bottom-full left-4 mb-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-[14px] bg-card p-1 shadow-soft">
              {mentionOptions.map((m, i) => (
                <button
                  key={m.agentId}
                  className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-sm ${i === mentionIdx ? 'bg-muted' : 'hover:bg-muted/60'}`}
                  onClick={() => pickMention(m.name)}
                >
                  <span className="text-muted-foreground">@</span>{m.name}
                  {group.coordinatorId === m.agentId && <span className="ml-auto text-[10px] text-muted-foreground"><Trans>coordinatore</Trans></span>}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex items-end gap-2 rounded-full bg-card py-2 pl-5 pr-2 shadow-soft"
            onSubmit={(e) => { e.preventDefault(); sendNow() }}
          >
            <textarea
              ref={taRef}
              className="max-h-40 min-h-11 min-w-[120px] flex-1 resize-none bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
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
            <button
              type="submit"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:opacity-40"
              aria-label={t`Invia`}
              title={t`Invia`}
              disabled={!text.trim()}
            >
              <ArrowUp className="size-4" />
            </button>
          </form>
        </div>
      </footer>
    </main>
  )
}
