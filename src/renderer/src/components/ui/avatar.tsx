// C1 (fase linguaggio): Avatar — la mascotte del bot, pezzo d'identità del
// catalogo. Avvolge il disegno VERO (bot/Bot.tsx: le cinque famiglie, la
// palette della mascotte) e ne chiude le misure: la demo della galleria
// disegnava un cerchio qualsiasi e le cinque famiglie si vedevano tutte
// uguali — il disegno vero si chiede a questo pezzo, non lo si rifà.
import { Bot, type BotProps } from '../../bot/Bot'
import type { BotColor, BotFamily } from '../../../../shared/types'

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE: Record<AvatarSize, number> = {
  sm: 20, // accanto a un nome nel testo
  md: 32, // la riga di elenco (come i loghi da 32)
  lg: 40, // la testata di scheda (come i loghi da 40)
  xl: 64 // la presentazione (la card, il pannello)
}

/** La mascotte del bot: famiglia e colore suoi, la misura del catalogo. */
export function Avatar({ family, color, size = 'md', state, label }: {
  family: BotFamily
  color: BotColor
  /** sm 20 · md 32 (default, le righe) · lg 40 (le testate) · xl 64 */
  size?: AvatarSize
  /** lo stato del bot (idle di default): cambia gli occhi e le antenne */
  state?: BotProps['state']
  /** il nome accessibile («Competitoor»): senza, il disegno è aria-hidden */
  label?: string
}): React.ReactNode {
  return <Bot family={family} color={color} state={state ?? 'idle'} size={SIZE[size]} label={label} />
}
