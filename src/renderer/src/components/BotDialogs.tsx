// Dialoghi della mascotte (fase 16, U5): "Crea nuovo bot" come il NewBotDialog
// di Lovable (anteprima happy 130 px, nome, 5 famiglie, 7 colori), collegato
// a createAgent + updateAgent(avatar), e "Cambia aspetto" del pannello destro
// (le stesse famiglie e colori, salva con updateAgent(id, { avatar })).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
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

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui()
  const createAgent = useStore((s) => s.createAgent)
  const select = useStore((s) => s.select)
  const [name, setName] = useState('')
  const [family, setFamily] = useState<BotFamily>('h-creature')
  const [color, setColor] = useState<BotColor>('c1')
  const [busy, setBusy] = useState(false)
  // i template esistenti (come nella scheda Bot delle Impostazioni)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [showTemplates, setShowTemplates] = useState(false)
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  const c = `var(--bot-${color})`

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl"><Trans>Crea nuovo bot</Trans></DialogTitle>
        </DialogHeader>
        <div className="grid place-items-center rounded-3xl bg-muted p-5">
          <Bot family={family} color={color} state="happy" size={130} />
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Dai un nome al tuo bot`}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <AvatarPicker family={family} color={color} onFamily={setFamily} onColor={setColor} />
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            disabled={!name.trim() || busy}
            className={`${btn} text-background disabled:opacity-40`}
            style={{ background: c }}
            onClick={async () => {
              setBusy(true)
              try {
                await createAgent(name.trim(), { family, color })
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            <Trans>Crea</Trans>
          </button>
        </DialogFooter>
        {/* i template di bot che la UI offre già oggi (Settings → Bot) */}
        {templates.length > 0 && (
          <div className="border-t border-border pt-3 text-center">
            <button
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowTemplates((v) => !v)}
            >
              <Trans>oppure parti da un modello</Trans>
            </button>
            {showTemplates && (
              <div className="mt-2 grid grid-cols-2 gap-2 text-left">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className="rounded-xl border border-border px-3 py-2 transition hover:border-muted-foreground"
                    title={pickLang(t.description, uiLang())}
                    onClick={async () => {
                      try {
                        const a = await api.createAgentFromTemplate(t.id)
                        await select(a.id)
                        onClose()
                      } catch (e) {
                        console.error('createAgentFromTemplate:', e instanceof Error ? e.message : e)
                      }
                    }}
                  >
                    <span className="mr-1">{t.avatar}</span>
                    {/* fase 17c (C5): la galleria mostra la lingua dell'interfaccia */}
                    <span className="text-sm">{pickLang(t.name, uiLang())}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{pickLang(t.description, uiLang())}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
