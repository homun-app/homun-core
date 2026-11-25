// C1 (fase linguaggio): Text — il testo del catalogo. Le taglie sono QUELLE
// dei token (page, title, body, small, caption, reading), ognuna con la sua
// interlinea; il tono decide il COLORE (normale, grigio, errore). Fuori da
// components/ui/ non si sceglie più la taglia di un testo col className: si
// chiede il pezzo. Il peso resta al chiamante SOLO come variante chiusa
// (normal, medium, semibold — i tre del tema).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type TextSize = 'page' | 'title' | 'body' | 'small' | 'caption' | 'reading'
export type TextTone = 'normal' | 'muted' | 'destructive'
export type TextWeight = 'normal' | 'medium' | 'semibold'

const SIZE: Record<TextSize, string> = {
  page: 'text-page',
  title: 'text-title',
  body: 'text-body',
  small: 'text-small',
  caption: 'text-caption',
  reading: 'text-reading'
}

const TONE: Record<TextTone, string> = {
  normal: '',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive'
}

const WEIGHT: Record<TextWeight, string> = {
  normal: '',
  medium: 'font-medium',
  semibold: 'font-semibold'
}

/**
 * Il testo: taglia dei token (con la sua interlinea), tono e peso come
 * varianti chiuse. `truncate` e `wrap` decidono se la riga si taglia o va a
 * capo (il default dipende dalla taglia: i titoli si troncano, il corpo no).
 */
export function Text({ size = 'body', tone = 'normal', weight = 'normal', truncate, className, children, testId, ...rest }: {
  /** la taglia: page 28 · title 20 · body 14 (default) · small 13 · caption 12 · reading 16 */
  size?: TextSize
  /** il tono: normale · grigio (le seconde righe) · errore */
  tone?: TextTone
  /** il peso: 400 (default) · 500 (etichette e titoli di riga) · 600 (titoli) */
  weight?: TextWeight
  /** su una riga sola, col ellissi */
  truncate?: boolean
  children: ReactNode
  className?: string
  testId?: string
} & React.HTMLAttributes<HTMLParagraphElement>): ReactNode {
  return (
    <p
      className={cn('min-w-0', SIZE[size], TONE[tone], WEIGHT[weight], truncate && 'truncate', className)}
      {...(testId ? { 'data-testid': testId } : {})}
      {...rest}
    >
      {children}
    </p>
  )
}
