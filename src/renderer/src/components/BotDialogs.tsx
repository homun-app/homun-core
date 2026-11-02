// Dialoghi della mascotte (fase 16, U5): "Crea nuovo bot" come il NewBotDialog
// di Lovable (anteprima happy 130 px, nome, 5 famiglie, 7 colori), collegato
// a createAgent + updateAgent(avatar), e "Cambia aspetto" del pannello destro
// (le stesse famiglie e colori, salva con updateAgent(id, { avatar })).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
// fase 16c correzioni (R8.2): la spunta della riga scelta e l'idea di «Descrivilo tu»
import { Check, PenLine } from 'lucide-react'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
import { BOT_FAMILIES, BOT_COLORS, avatarOf } from '../../../shared/avatar'
import type { BotColor, BotFamily, TemplateInfo } from '../../../shared/types'
// fase 17c (C5): galleria dei template nella lingua dell'interfaccia
import { pickLang } from '../../../shared/localized'
import { i18n } from '../lib/i18n'

/**
 * Le 5 famiglie con il loro nome per la UI (come in Lovable). Fase 17a:
 * descriptor (msg) — le traduce chi le mostra.
 */
export const FAMILY_NAMES: Record<BotFamily, MessageDescriptor> = {
  'h-creature': msg`Creatura`,
  'h-robo': msg`Robottino`,
  'h-device': msg`Tech`,
  jelly: msg`Gelatina`,
  pixel: msg`Pixel`
}

const btn = 'rounded-xl px-4 py-2 text-sm transition hover:opacity-90'

/** La griglia famiglia+colore condivisa dai due dialoghi. */
function AvatarPicker({
  family,
  color,
  onFamily,
  onColor
}: {
  family: BotFamily
  color: BotColor
  onFamily(f: BotFamily): void
  onColor(c: BotColor): void
}) {
  const { t, i18n } = useLingui()
  return (
    <>
      <div className="grid grid-cols-5 gap-2">
        {BOT_FAMILIES.map((f) => (
          <button
            key={f}
            onClick={() => onFamily(f)}
            aria-label={i18n.t(FAMILY_NAMES[f])}
            className={`grid place-items-center gap-1 rounded-2xl border p-2 text-[11px] transition ${
              family === f ? 'border-foreground' : 'border-border hover:border-muted-foreground'
            }`}
          >
            <Bot family={f} color={color} state="idle" size={48} track={false} />
            {i18n.t(FAMILY_NAMES[f])}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {BOT_COLORS.map((col) => (
          <button
            key={col}
            aria-label={t`Colore ${col}`}
            onClick={() => onColor(col)}
            className={`size-7 rounded-full transition ${color === col ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''}`}
            style={{ background: `var(--bot-${col})` }}
          />
        ))}
      </div>
    </>
  )
}

/** La lingua attiva come UiLanguage (fase 17c, C5). */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

/**
 * Fase 16c (C7, tavola 7): «Nuovo bot» — la mascotte grande SOSPESA (nessun
 * riquadro, solo l'ombra ovale), le cinque famiglie a pillola, i colori, il
 * campo Nome e «Cosa farà?»: i template che esistono (al massimo 4 visibili
 * più «Altri ▾») più «Descrivilo tu», con il campo che diventa la descrizione
 * del bot (agents:create — NESSUN messaggio automatico: il kickstart esiste
 * solo per i template). Il bottone «Crea <Nome>» è attivo con un nome. Il
 * modello: il bot nasce «Come gli altri» se models.main c'è (C3.3).
 */
export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useLingui()
  const select = useStore((s) => s.select)
  const [name, setName] = useState('')
  const [family, setFamily] = useState<BotFamily>('h-creature')
  const [color, setColor] = useState<BotColor>('c1')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // i template che esistono (nessuno nuovo in questa fase)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [showAllTemplates, setShowAllTemplates] = useState(false)
  // «Cosa farà?» — un template scelto, oppure «Descrivilo tu»
  const [chosenTemplate, setChosenTemplate] = useState<TemplateInfo | null>(null)
  const [describe, setDescribe] = useState(false)
  const [description, setDescription] = useState('')
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  const c = `var(--bot-${color})`

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      if (chosenTemplate) {
        // il template crea nome/descrizione/kickstart; nome e aspetto scelti
        // qui si applicano DOPO (updateAgent)
        const a = await api.createAgentFromTemplate(chosenTemplate.id)
        await api.updateAgent(a.id, { ...(name.trim() ? { name: name.trim() } : {}), avatar: { family, color } })
        await select(a.id)
      } else {
        // «Descrivilo tu»: la descrizione è il testo del campo; NESSUN
        // messaggio automatico (il kickstart è solo dei template)
        const a = await api.createAgent(name.trim(), describe ? description.trim() : '')
        await api.updateAgent(a.id, { avatar: { family, color } })
        await select(a.id)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const visibleTemplates = showAllTemplates ? templates : templates.slice(0, 4)
  const canCreate = !busy && name.trim().length > 0 && (!describe || !chosenTemplate)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto scroll-thin">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl"><Trans>Nuovo bot</Trans></DialogTitle>
        </DialogHeader>

        {/* la mascotte grande sospesa: niente riquadro, solo l'ombra ovale */}
        <div className="flex flex-col items-center pt-2">
          <Bot family={family} color={color} state="happy" size={112} />
          <span aria-hidden="true" className="mt-1.5 h-2.5 w-20 rounded-full bg-foreground/10" />
        </div>

        {/* le cinque famiglie a pillola + i colori + il nome */}
        <div className="flex flex-wrap justify-center gap-1.5">
          {BOT_FAMILIES.map((f) => (
            <button
              key={f}
              className={`h-8 rounded-full px-3 text-[13px] transition outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background ${family === f ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent'}`}
              onClick={() => setFamily(f)}
            >
              {i18n.t(FAMILY_NAMES[f])}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {BOT_COLORS.map((col) => (
            <button
              key={col}
              aria-label={t`Colore ${col}`}
              className={`size-7 rounded-full transition ${color === col ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''}`}
              style={{ background: `var(--bot-${col})` }}
              onClick={() => setColor(col)}
            />
          ))}
        </div>
        <div className="space-y-1">
          <label htmlFor="sandbot-new-bot-name" className="block text-[13px] text-muted-foreground"><Trans>Nome</Trans></label>
          <input
            id="sandbot-new-bot-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t`Dai un nome al tuo bot`}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* «Cosa farà?» — i template che esistono + «Descrivilo tu».
            Fase 16c correzioni (R8.2, tavola 7): RIGHE senza bordo su
            bg-muted/60, emoji e titolo a 8 px, descrizione su UNA riga
            troncata (l'intera nel title), selezione = fondo più scuro +
            spunta; massimo 4 visibili più «Altri N ▾» */}
        <div className="space-y-2">
          <strong className="block text-base"><Trans>Cosa farà?</Trans></strong>
          <div className="flex flex-col gap-1.5">
            {visibleTemplates.map((tpl) => (
              <button
                key={tpl.id}
                title={`${pickLang(tpl.name, uiLang())} — ${pickLang(tpl.description, uiLang())}`}
                className={`flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-foreground ${chosenTemplate?.id === tpl.id ? 'bg-accent' : 'bg-muted/60 hover:bg-muted'}`}
                onClick={() => { setChosenTemplate(tpl); setDescribe(false) }}
              >
                <span className="shrink-0 text-base">{tpl.avatar}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{pickLang(tpl.name, uiLang())}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{pickLang(tpl.description, uiLang())}</span>
                </span>
                {chosenTemplate?.id === tpl.id && <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" />}
              </button>
            ))}
            {/* «Descrivilo tu» — il bot ti propone le sue istruzioni */}
            <button
              className={`flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-foreground ${describe ? 'bg-accent' : 'bg-muted/60 hover:bg-muted'}`}
              onClick={() => { setDescribe(true); setChosenTemplate(null) }}
            >
              <PenLine className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold"><Trans>Descrivilo tu</Trans></span>
                <span className="block truncate text-[13px] text-muted-foreground"><Trans>Il bot ti propone le sue istruzioni</Trans></span>
              </span>
              {describe && <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" />}
            </button>
          </div>
          {templates.length > 4 && !showAllTemplates && (
            <button
              className="mx-auto block rounded-full bg-muted px-3 py-1 text-xs transition hover:bg-accent"
              onClick={() => setShowAllTemplates(true)}
            >
              <Trans>Altri {templates.length - 4} ▾</Trans>
            </button>
          )}
          {describe && (
            <textarea
              className="min-h-20 w-full rounded-2xl bg-muted px-3 py-2 text-sm outline-none"
              placeholder={t`Per esempio: segue le ricevute email e prepara il riepilogo della settimana…`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            disabled={!canCreate}
            className={`${btn} text-background disabled:opacity-40`}
            style={{ background: c }}
            onClick={() => void create()}
          >
            <Trans>Crea {name.trim() || i18n._(msg`il bot`)}</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Cambia aspetto" del pannello destro: le stesse scelte, salva l'avatar del bot. */
export function ChangeAvatarDialog({ agentId, current, onClose }: { agentId: string; current: { family: BotFamily; color: BotColor }; onClose: () => void }) {
  const [family, setFamily] = useState<BotFamily>(current.family)
  const [color, setColor] = useState<BotColor>(current.color)
  const [busy, setBusy] = useState(false)
  const c = `var(--bot-${color})`
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl"><Trans>Cambia aspetto</Trans></DialogTitle>
        </DialogHeader>
        <div className="grid place-items-center rounded-3xl bg-muted p-5">
          <Bot family={family} color={color} state="happy" size={130} />
        </div>
        <AvatarPicker family={family} color={color} onFamily={setFamily} onColor={setColor} />
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            disabled={busy}
            className={`${btn} text-background disabled:opacity-40`}
            style={{ background: c }}
            onClick={async () => {
              setBusy(true)
              try {
                await api.updateAgent(agentId, { avatar: { family, color } })
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            <Trans>Salva</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Fase 16b (S5): «Nuova squadra» dal menu Crea — nome, scelta di 1–6 bot
 * (mascotte cliccabili) e coordinatore obbligatorio (di default il primo
 * scelto). Chiama groups:create (S1.3): la crea l'UTENTE, niente card.
 */
export function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const groupCreate = useStore((s) => s.groupCreate)
  const openGroup = useStore((s) => s.openGroup)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [coordinatorId, setCoordinatorId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  // i FIGLI non si scelgono (non sono bot) e nemmeno il bot già in squadra?
  // no: un bot può stare in più squadre — solo i figli restano fuori
  const candidates = agents.filter((a) => !a.parentId)

  const toggle = (id: string): void => {
    setPicked((cur) => {
      if (cur.includes(id)) {
        const next = cur.filter((x) => x !== id)
        if (coordinatorId === id) setCoordinatorId(next[0] ?? null)
        return next
      }
      if (cur.length >= 6) return cur
      const next = [...cur, id]
      if (coordinatorId === null) setCoordinatorId(id)
      return next
    })
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await groupCreate(name.trim(), picked, coordinatorId ?? picked[0] ?? '')
      onClose()
      // la squadra nuova è l'ultima della lista: si apre
      const groups = await api.listGroups()
      const last = groups[groups.length - 1]
      if (last) openGroup(last.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl"><Trans>Nuova squadra</Trans></DialogTitle>
        </DialogHeader>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Nome della squadra`}
          aria-label={t`Nome della squadra`}
          className="rounded-xl bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            <Trans>Scegli da 1 a 6 bot: il coordinatore risponde quando scrivi senza @.</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((a) => {
              const av = avatarOf(a, agents, effectiveMain)
              const on = picked.includes(a.id)
              const coord = coordinatorId === a.id
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  title={a.name}
                  aria-pressed={on}
                  className={`flex flex-col items-center gap-1 rounded-[14px] px-2 py-2 transition ${on ? 'bg-muted' : 'hover:bg-muted/60'}`}
                >
                  <span className="relative">
                    <Bot family={av.family} color={av.color} state={on ? 'happy' : 'idle'} size={44} track={false} />
                    {coord && (
                      <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-foreground text-[9px] font-bold text-background">★</span>
                    )}
                  </span>
                  <span className="max-w-16 truncate text-[11px]">{a.name}</span>
                </button>
              )
            })}
          </div>
          {picked.length > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span><Trans>Coordinatore</Trans></span>
              <select
                className="rounded-lg bg-muted px-2 py-1 text-xs text-foreground outline-none"
                value={coordinatorId ?? ''}
                onChange={(e) => setCoordinatorId(e.target.value || null)}
                aria-label={t`Coordinatore`}
              >
                {picked.map((id) => {
                  const a = agents.find((x) => x.id === id)
                  return <option key={id} value={id}>{a?.name ?? id}</option>
                })}
              </select>
            </div>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            disabled={!name.trim() || picked.length < 1 || picked.length > 6 || busy}
            className={`${btn} bg-foreground text-background disabled:opacity-40`}
            onClick={() => void create()}
          >
            <Trans>Crea squadra</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
