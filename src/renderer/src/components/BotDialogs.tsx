// Dialoghi della mascotte (fase 16, U5): "Crea nuovo bot" come il NewBotDialog
// di Lovable (anteprima happy 130 px, nome, 5 famiglie, 7 colori), collegato
// a createAgent + updateAgent(avatar), e "Cambia aspetto" del pannello destro
// (le stesse famiglie e colori, salva con updateAgent(id, { avatar })).
// B2 (fase beta.4): il dialogo chiede SOLO nome e aspetto — come Rakazo
// (create-bot-dialog.tsx). Niente menu «Nuovo bot / Nuova squadra», niente
// «Cosa farà?» né «Descrivilo tu»: appena creato, il bot SI PRESENTA con un
// turno suo (chiede a cosa serve e si scrive il profilo con update_self). In
// fondo il link «Parti da un modello» apre l'elenco di oggi: lo stesso flusso
// col kickstart, niente si perde. La squadra nasce in chat (create_agent +
// create_group), non da un dialogo.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
// fase 16c correzioni (R8.2): la spunta della riga scelta
import { Check } from 'lucide-react'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
import { BOT_FAMILIES, BOT_COLORS } from '../../../shared/avatar'
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
 * B2 (fase beta.4): «Nuovo» — la mascotte grande SOSPESA (nessun riquadro,
 * solo l'ombra ovale), le cinque famiglie a pillola, i colori e il campo
 * Nome: SOLO questo (come il create-bot-dialog di Rakazo). Il bottone «Crea»
 * è attivo solo con un nome; il bot nasce «Come gli altri» e SI PRESENTA da
 * solo (turno BOT_INTRO). In fondo il link piccolo «Parti da un modello» apre
 * l'elenco dei template di oggi: stesso flusso col kickstart, niente si perde.
 */
export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useLingui()
  const select = useStore((s) => s.select)
  const [name, setName] = useState('')
  const [family, setFamily] = useState<BotFamily>('h-creature')
  const [color, setColor] = useState<BotColor>('c1')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // «Parti da un modello» (fase 16c, tavola 7): l'elenco di oggi, RIGHE senza
  // bordo su bg-muted/60, emoji e titolo a 8 px, descrizione su UNA riga
  // troncata (l'intera nel title), massimo 4 visibili più «Altri N ▾»
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [showAllTemplates, setShowAllTemplates] = useState(false)
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  const c = `var(--bot-${color})`

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      // il bot nasce col SOLO nome: a cosa serve lo chiederà LUI (turno di
      // presentazione), con l'aspetto scelto qui
      const a = await api.createAgent(name.trim())
      await api.updateAgent(a.id, { avatar: { family, color } })
      await select(a.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const createFromTemplate = async (tpl: TemplateInfo): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      // il template crea nome/descrizione/kickstart; nome e aspetto scelti
      // qui si applicano DOPO (updateAgent). Nessuna presentazione: c'è il
      // kickstart del template
      const a = await api.createAgentFromTemplate(tpl.id)
      await api.updateAgent(a.id, { ...(name.trim() ? { name: name.trim() } : {}), avatar: { family, color } })
      await select(a.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const visibleTemplates = showAllTemplates ? templates : templates.slice(0, 4)
  const canCreate = !busy && name.trim().length > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto scroll-thin">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl"><Trans>Nuovo</Trans></DialogTitle>
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
          <p className="pt-0.5 text-xs text-muted-foreground">
            <Trans>Appena creato si presenta lui: ti chiede a cosa serve e impara dal tuo lavoro.</Trans>
          </p>
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}
        <DialogFooter className="items-center sm:justify-between">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 transition hover:underline"
            onClick={() => setShowTemplates((v) => !v)}
          >
            <Trans>Parti da un modello</Trans>
          </button>
          <div className="flex gap-2">
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
          </div>
        </DialogFooter>

        {/* «Parti da un modello»: l'elenco di OGGI, con il suo kickstart */}
        {showTemplates && (
          <div className="space-y-2">
            <div className="flex flex-col gap-1.5">
              {visibleTemplates.map((tpl) => (
                <button
                  key={tpl.id}
                  disabled={busy}
                  title={`${pickLang(tpl.name, uiLang())} — ${pickLang(tpl.description, uiLang())}`}
                  className={`flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-foreground ${busy ? 'opacity-40' : 'bg-muted/60 hover:bg-muted'}`}
                  onClick={() => void createFromTemplate(tpl)}
                >
                  <span className="shrink-0 text-base">{tpl.avatar}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{pickLang(tpl.name, uiLang())}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">{pickLang(tpl.description, uiLang())}</span>
                  </span>
                  <Check className="size-4 shrink-0 text-foreground opacity-0" aria-hidden="true" />
                </button>
              ))}
            </div>
            {templates.length > 4 && !showAllTemplates && (
              <button
                className="mx-auto block rounded-full bg-muted px-3 py-1 text-xs transition hover:bg-accent"
                onClick={() => setShowAllTemplates(true)}
              >
                <Trans>Altri {templates.length - 4} ▾</Trans>
              </button>
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
