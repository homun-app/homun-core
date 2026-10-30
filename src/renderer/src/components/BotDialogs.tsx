// Dialoghi della mascotte (fase 16, U5): "Crea nuovo bot" come il NewBotDialog
// di Lovable (anteprima happy 130 px, nome, 5 famiglie, 7 colori), collegato
// a createAgent + updateAgent(avatar), e "Cambia aspetto" del pannello destro
// (le stesse famiglie e colori, salva con updateAgent(id, { avatar })).
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
import { BOT_FAMILIES, BOT_COLORS } from '../../../shared/avatar'
import type { BotColor, BotFamily, TemplateInfo } from '../../../shared/types'

/** Le 5 famiglie con il loro nome per la UI (come in Lovable). */
export const FAMILY_NAMES: Record<BotFamily, string> = {
  'h-creature': 'Creatura',
  'h-robo': 'Robottino',
  'h-device': 'Tech',
  jelly: 'Gelatina',
  pixel: 'Pixel'
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
  return (
    <>
      <div className="grid grid-cols-5 gap-2">
        {BOT_FAMILIES.map((f) => (
          <button
            key={f}
            onClick={() => onFamily(f)}
            aria-label={FAMILY_NAMES[f]}
            className={`grid place-items-center gap-1 rounded-2xl border p-2 text-[11px] transition ${
              family === f ? 'border-foreground' : 'border-border hover:border-muted-foreground'
            }`}
          >
            <Bot family={f} color={color} state="idle" size={48} track={false} />
            {FAMILY_NAMES[f]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {BOT_COLORS.map((col) => (
          <button
            key={col}
            aria-label={`Colore ${col}`}
            onClick={() => onColor(col)}
            className={`size-7 rounded-full transition ${color === col ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''}`}
            style={{ background: `var(--bot-${col})` }}
          />
        ))}
      </div>
    </>
  )
}

export function NewBotDialog({ onClose }: { onClose: () => void }) {
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
          <DialogTitle className="font-display text-2xl">Crea nuovo bot</DialogTitle>
        </DialogHeader>
        <div className="grid place-items-center rounded-3xl bg-muted p-5">
          <Bot family={family} color={color} state="happy" size={130} />
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dai un nome al tuo bot"
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <AvatarPicker family={family} color={color} onFamily={setFamily} onColor={setColor} />
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            Annulla
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
            Crea
          </button>
        </DialogFooter>
        {/* i template di bot che la UI offre già oggi (Settings → Bot) */}
        {templates.length > 0 && (
          <div className="border-t border-border pt-3 text-center">
            <button
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowTemplates((v) => !v)}
            >
              oppure parti da un modello
            </button>
            {showTemplates && (
              <div className="mt-2 grid grid-cols-2 gap-2 text-left">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className="rounded-xl border border-border px-3 py-2 transition hover:border-muted-foreground"
                    title={t.description}
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
                    <span className="text-sm">{t.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.description}</span>
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
          <DialogTitle className="font-display text-2xl">Cambia aspetto</DialogTitle>
        </DialogHeader>
        <div className="grid place-items-center rounded-3xl bg-muted p-5">
          <Bot family={family} color={color} state="happy" size={130} />
        </div>
        <AvatarPicker family={family} color={color} onFamily={setFamily} onColor={setColor} />
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            Annulla
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
            Salva
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
