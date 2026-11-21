// Q1 (fase squadra): la schermata 3 del disegno — «Autonomia della squadra».
// Si apre dal riquadro Autonomia del pannello del team; i tre valori sono
// groups.autonomy ('ask' | 'box' | 'box_review'). Testi e struttura vengono
// dalla tela E1UivWqEiuZqVjkkR9K5hx (tavola 3): il gruppo di radio «Quanto fa
// da sola», le due colonne «Fa da sola» / «Chiede sempre a te» (quella di destra
// non si può svuotare) e la nota su chi decide: regole fisse e, se scelto, il
// revisore — MAI il coordinatore.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ShieldCheck } from 'lucide-react'
import { useStore } from '../store'
import type { GroupAutonomy, GroupInfo } from '../../../shared/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog'

const btn = 'rounded-full px-4 py-2 text-sm transition'

/** Le tre voci del disegno, nell'ordine (i testi via descriptor, it/en). */
export const AUTONOMY_CHOICES: ReadonlyArray<{
  value: GroupAutonomy
  title: MessageDescriptor
  short: MessageDescriptor
  description: MessageDescriptor
  /** la spunta «consigliata» del disegno, solo per box */
  recommended?: boolean
}> = [
  {
    value: 'ask',
    title: msg`Chiede tutto`,
    short: msg`chiede tutto`,
    description: msg`Ogni azione con effetti passa da te. Per provare un team nuovo.`
  },
  {
    value: 'box',
    title: msg`Libera nel computer`,
    short: msg`nel computer`,
    description: msg`Tutto quello che resta nel computer isolato lo fa da sola. Fuori dal computer chiede.`,
    recommended: true
  },
  {
    value: 'box_review',
    title: msg`Libera nel computer + revisore`,
    short: msg`computer + revisore`,
    description: msg`In più, un revisore controlla ogni clic sui siti rispetto alla tua richiesta e lascia passare quelli che servono. I dubbi arrivano a te.`
  }
]

/** Le righe delle due colonne del disegno (statiche, come nella tavola 3). */
const FA_DA_SOLA: MessageDescriptor[] = [
  msg`creare e modificare file nel computer`,
  msg`eseguire comandi e codice nel computer, senza rete`,
  msg`leggere e cercare pagine web`,
  msg`parlarsi tra bot del team`,
  msg`lanciare sottoagenti`,
  msg`scrivere documenti nella Libreria`
]

const CHIEDE_SEMPRE: MessageDescriptor[] = [
  msg`moduli con i tuoi dati, login, Cassaforte`,
  msg`pagamenti e acquisti`,
  msg`email, messaggi e post verso fuori`,
  msg`azioni sul tuo Mac fuori dal computer`,
  msg`eliminare un bot`
]

type I18n = ReturnType<typeof useLingui>['i18n']

/** L'etichetta corta dell'autonomia (la pillola nella fascia alta della chat). */
export function autonomyShortLabel(a: GroupAutonomy, i18n: I18n): string {
  const c = AUTONOMY_CHOICES.find((x) => x.value === a)
  return c ? i18n.t(c.short) : i18n.t(msg`nel computer`)
}

/** La descrizione breve del riquadro Autonomia del pannello del team. */
export function autonomyBlurb(a: GroupAutonomy, i18n: I18n): string {
  if (a === 'ask') return i18n.t(msg`Ogni azione con effetti passa da te.`)
  if (a === 'box_review') {
    return i18n.t(msg`File, comandi e letture fanno da soli; i clic sui siti li controlla il revisore. Dati tuoi, pagamenti e invii chiedono sempre a te.`)
  }
  return i18n.t(msg`File, comandi e letture fanno da soli. Dati tuoi, pagamenti e invii chiedono sempre a te.`)
}

/**
 * La schermata 3: radio dell'autonomia + le due colonne del disegno.
 * La colonna di destra è FISSA (insieme del codice): qui non si toglie nulla.
 */
export function TeamAutonomySheet({ group, onClose }: { group: GroupInfo; onClose(): void }) {
  const { i18n } = useLingui()
  const groupUpdate = useStore((s) => s.groupUpdate)
  const [value, setValue] = useState<GroupAutonomy>(group.autonomy)
  const [busy, setBusy] = useState(false)
  useEffect(() => setValue(group.autonomy), [group.id, group.autonomy])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="team-autonomy">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-2xl">
            <ShieldCheck className="size-5 text-muted-foreground" />
            <Trans>Autonomia del team</Trans>
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            <Trans>{group.name} · vale per tutti i bot del team, finché il team esiste</Trans>
          </p>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold text-muted-foreground"><Trans>Quanto fa da sola</Trans></legend>
          {AUTONOMY_CHOICES.map((c) => (
            <label
              key={c.value}
              className={`flex cursor-pointer items-start gap-3 rounded-[14px] px-3 py-2.5 transition ${value === c.value ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <input
                type="radio"
                name="autonomia-squadra"
                className="mt-1 accent-foreground"
                checked={value === c.value}
                onChange={() => setValue(c.value)}
              />
              <span className="min-w-0">
                <span className="text-sm font-medium">
                  {i18n.t(c.title)}
                  {c.recommended ? <span className="ml-2 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"><Trans>consigliata</Trans></span> : null}
                </span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{i18n.t(c.description)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[16px] bg-muted/60 p-3.5">
            <p className="text-sm font-semibold"><Trans>Fa da sola</Trans></p>
            <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-foreground/80">
              {FA_DA_SOLA.map((r, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-muted-foreground">✓</span>{i18n.t(r)}</li>)}
            </ul>
          </div>
          <div className="rounded-[16px] bg-muted/60 p-3.5">
            <p className="text-sm font-semibold"><Trans>Chiede sempre a te</Trans></p>
            <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-foreground/80">
              {CHIEDE_SEMPRE.map((r, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-muted-foreground">•</span>{i18n.t(r)}</li>)}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground"><Trans>Questa colonna non si può svuotare.</Trans></p>
          </div>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          <Trans>Decidono regole fisse e, se scelto, un revisore che vede solo la tua richiesta e l'azione. Il coordinatore non approva al posto tuo: legge le pagine del web, e una pagina ostile potrebbe convincerlo.</Trans>
        </p>
        <DialogFooter>
          <button className={`${btn} bg-muted`} onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            data-testid="team-autonomy-save"
            disabled={busy || value === group.autonomy}
            className={`${btn} bg-foreground text-background disabled:opacity-40`}
            onClick={() => {
              setBusy(true)
              void groupUpdate(group.id, { autonomy: value }).finally(() => {
                setBusy(false)
                onClose()
              })
            }}
          >
            <Trans>Salva</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
