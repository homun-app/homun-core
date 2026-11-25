// C1 (fase linguaggio): EmptyState — lo stato vuoto del catalogo: l'icona
// grigia, il titolo, la frase che dice COSA fare (non la descrizione della
// pagina, che sotto il titolo non ci sta più: la frase va qui o nell'aiuto).
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Icon } from './icon'
import { Stack } from './stack'

/** Lo stato vuoto: icona · titolo · frase · (azione facoltativa). */
export function EmptyState({ icon, titolo, frase, azione, className, testId }: {
  /** l'icona dello stato vuoto (grande, grigia) */
  icon: LucideIcon
  /** il titolo dello stato vuoto */
  titolo: ReactNode
  /** la frase che dice cosa fare (qui sta la descrizione che non entra nella testata) */
  frase?: ReactNode
  /** l'azione che risolve («Creane una») */
  azione?: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <Stack
      gap="tight"
      align="center"
      className={cn('py-10 text-center', className)}
      testId={testId}
    >
      <Icon icon={icon} size="lg" className="text-muted-foreground/60" />
      <p className="text-body font-medium">{titolo}</p>
      {frase !== undefined && <p className="mx-auto max-w-reading text-small text-muted-foreground">{frase}</p>}
      {azione !== undefined && <div className="pt-1">{azione}</div>}
    </Stack>
  )
}
