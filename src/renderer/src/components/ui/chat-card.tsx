// K2 (fase conversione-chat): ChatCard — IL GUSCIO DI OGNI CARD IN CHAT.
// Prima (K1) ogni card si disegnava da sé il guscio: la superficie da
// CardShell (DecidedRow.tsx) e poi, card per card, la testata, le righe e la
// riga delle azioni, ciascuna con le sue misure. Ora il guscio sta QUI, una
// volta sola: la superficie (il raggio di superficie, il respiro di 16, larga
// al massimo l'85% della colonna — il testo lungo va a capo DENTRO), il tono
// del fondo, la TESTATA (il segno da 32 — il file del logo, l'iniziale o
// un'icona — · il titolo · ciò che completa il titolo, contro il bordo
// destro) e la RIGA DELLE AZIONI, in fondo. La card porta solo il corpo e i
// clic: dentro, i blocchi stanno a 8 px l'uno dall'altro (Stack, Text).
// È il guscio che la sonda di K6 misura: due card che differiscono (margine
// interno, raggio, testata, azioni) sono una differenza.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LOGO_CLASS } from '../../lib/app-logos'
import { AppLogo } from './app-logo'
import { Icon } from './icon'
import { Text } from './text'

export type ChatCardTone = 'muted' | 'waiting' | 'error'

/** Il fondo, per tono: tenue (il default) · l'attesa (ambra) · l'errore (rosso). */
const TONE: Record<ChatCardTone, string> = {
  muted: 'bg-muted',
  waiting: 'bg-waiting/10',
  error: 'bg-destructive/10'
}

export function ChatCard({ tone = 'muted', avviso, logo, nome, icona, titolo, sottotitolo, nota, azioni, className, testId, children }: {
  /** il fondo della card: tenue (il default) · attesa · errore */
  tone?: ChatCardTone
  /** l'avviso in cima alla card (per esempio la proposta nata dopo letture esterne) */
  avviso?: ReactNode
  /** il file del logo (un URL): nella testata, ai 32 delle righe */
  logo?: string | null
  /** senza file del logo, l'iniziale di questo nome sulla piastrella */
  nome?: string
  /** senza logo né iniziale, il segno del collegamento: un'icona lucide nella piastrella da 32 */
  icona?: LucideIcon
  /** il titolo: il testo del corpo in peso medio; va a capo dentro la card */
  titolo?: ReactNode
  /** la riga grigia sotto il titolo (si tronca) */
  sottotitolo?: ReactNode
  /** ciò che completa il titolo, contro il bordo destro: un'etichetta (Tag), una didascalia */
  nota?: ReactNode
  /** la riga delle azioni: in fondo, i bottoni in fila */
  azioni?: ReactNode
  className?: string
  testId?: string
  /** il corpo della card */
  children?: ReactNode
}): ReactNode {
  const haTestata = titolo !== undefined || Boolean(logo) || nome !== undefined || icona !== undefined
  return (
    <div
      className={cn('flex max-w-[85%] min-w-0 flex-col gap-2 rounded-surface p-4 wrap-anywhere', TONE[tone], className)}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {avviso}
      {haTestata && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {logo ? (
            <img src={logo} alt="" className={cn(LOGO_CLASS, 'size-8')} />
          ) : nome !== undefined ? (
            <AppLogo logo={null} name={nome} className="size-8 text-reading" />
          ) : icona !== undefined ? (
            <span className="grid size-8 shrink-0 place-items-center text-muted-foreground"><Icon icon={icona} /></span>
          ) : null}
          {titolo !== undefined && (
            <span className="min-w-0 flex-1">
              <Text weight="medium">{titolo}</Text>
              {sottotitolo !== undefined && <Text size="small" tone="muted" truncate>{sottotitolo}</Text>}
            </span>
          )}
          {nota !== undefined && <span className="shrink-0">{nota}</span>}
        </div>
      )}
      {children}
      {azioni !== undefined && <div className="mt-2 flex flex-wrap items-center gap-2">{azioni}</div>}
    </div>
  )
}
