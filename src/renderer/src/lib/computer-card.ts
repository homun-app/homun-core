// CC3 (fase computer-card): la card «Computer» dice lo stato VERO del
// computer del bot — il BOX, la macchina Linux dove girano comandi, file e
// browser, non solo il browser. La logica sta QUI, PURA: il componente la
// mostra soltanto. Tre fatti distinti, una sola card:
// - lo stato del BOX (box-runtime del daemon, evento `box` / RPC box:runtime);
// - cosa fa il bot ADESSO (activity: SOLO gli strumenti del computer);
// - il browser APERTO (screen).
// L'ordine di priorità è quello della spec: la preparazione vince su tutto,
// poi box acceso con attività del computer, box acceso in attesa, spento,
// non in uso. Sotto l'etichetta, in piccolo, UNA riga: la frase dell'attività
// (la stessa della riga «lavora…» della chat; MAI il testo di un comando),
// oppure «Browser aperto», oppure niente.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { BoxRuntime, BoxSetupPhase, ScreenStatus } from '../../../shared/types'
import { boxSetupActive } from './box-setup-rows'
import { activityPhrase, isComputerTool, type BotActivity } from './activity'

/** il pallino verde dello stato attivo (la classe di oggi). */
export const DOT_ON = 'bg-chart-2'
/** il pallino d'attesa (in preparazione e in attesa). */
export const DOT_WAITING = 'bg-waiting'
/** il pallino grigio (spento, non in uso). */
export const DOT_OFF = 'bg-muted-foreground/40'

export type ComputerCardStatus = 'prep' | 'on' | 'waiting' | 'off' | 'unavailable'

export interface ComputerCardView {
  status: ComputerCardStatus
  /** la classe del pallino */
  dot: string
  /** l'etichetta dello stato */
  label: MessageDescriptor
  /** la riga sotto l'etichetta (null = niente riga) */
  line: MessageDescriptor | null
}

/** I fatti che la card legge (tutti nello store del renderer, più la modalità sandbox). */
export interface ComputerCardFacts {
  /** lo stato del box (evento `box`; null = non ancora arrivato) */
  boxRuntime: BoxRuntime | null
  /** l'attività in corso del bot (null = il bot non sta facendo) */
  activity: BotActivity | null
  /** il browser del bot è aperto? (ScreenStatus.browser) */
  browser: ScreenStatus['browser']
  /** la fase della preparazione del computer del bot (box-setup) */
  boxSetupPhase: BoxSetupPhase | null
  /** sandbox.mode è box (o il valore storico docker): il computer del bot c'è */
  boxInUse: boolean
}

/** Lo stato della card «Computer» dai tre fatti + la preparazione (PURa). */
export function computerCardState(f: ComputerCardFacts): ComputerCardView {
  // 1. la preparazione del computer del bot VINCE su tutto, qualunque sia il resto
  if (f.boxSetupPhase !== null && boxSetupActive(f.boxSetupPhase)) {
    return { status: 'prep', dot: DOT_WAITING, label: msg`In preparazione`, line: null }
  }
  // 2. questa installazione non usa il computer del bot
  if (!f.boxInUse) {
    return { status: 'unavailable', dot: DOT_OFF, label: msg`Non in uso`, line: null }
  }
  // la riga sotto: la frase dell'attività del computer (activityPhrase dei
  // comandi dice SOLO «esegue un comando…», il testo non passa MAI), oppure
  // «Browser aperto», oppure niente
  const busy = f.activity !== null && isComputerTool(f.activity.tool)
  const line = busy
    ? activityPhrase(f.activity, 'present')
    : f.browser === 'running' ? msg`Browser aperto` : null
  if (f.boxRuntime?.state === 'running') {
    return busy
      ? { status: 'on', dot: DOT_ON, label: msg`Acceso`, line }
      : { status: 'waiting', dot: DOT_WAITING, label: msg`In attesa`, line }
  }
  // 3. il box non gira: stopped, missing — o non ancora letto (null): Spento
  // come oggi finché la prima lettura (RPC all'apertura, tick ogni 60 s)
  // porta lo stato vero
  return { status: 'off', dot: DOT_OFF, label: msg`Spento`, line }
}
