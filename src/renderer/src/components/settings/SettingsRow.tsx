// Fase impostazioni (I5): la riga «nome a sinistra, controllo a destra»,
// divisa dalle sorelle da un filetto sottile (border-t dalla seconda in poi).
// Sotto i 420 px di CONTENUTO (@container del dialogo Impostazioni) il
// controllo scende sotto il nome. `clickable` fa della riga un bottone (la
// riga del provider che si apre sul posto). Fase mcp-setup ritocchi (R3):
// `muted` attenua la riga (la via OAuth del modulo quando c'è un token);
// `stacked` tiene il controllo SOTTO il nome a ogni larghezza (le righe del
// modulo di configurazione, fatte per i campi larghi della card in chat).
//
// Fase design (DS4, Impostazioni): le misure sono quelle di DS1, che stanno in
// un posto solo (styles.css). La riga è alta ALMENO 52 (min-h-row) col respiro
// verticale di 12 (py-row-pad): col solo nome resta 52; con la descrizione, o
// con un controllo più alto di 28, cresce — è la regola di DS1 («con la
// descrizione la riga cresce»), non un'eccezione. Il nome è il titolo di riga
// del sistema (text-body, peso 500), la descrizione la riga grigia
// (text-small): prima erano 15 px e 13 px scritti a mano. I filetti restano
// border-border/40. La soglia dei 420 px non cambia, e non diventa una query
// sul contenitore della scheda: le finestre di chat che usano questa riga
// dichiarano l'@container in UN punto (apps-window-ritocchi, skills-window-ritocchi).
//
// QUI STA ANCHE CIÒ CHE ENTRA NELLA RIGA E NELLA SCHEDA — i controlli delle
// Impostazioni, in un posto solo perché li usano tutte le pagine (Generali,
// Approvazioni, Modelli, Cassaforte, Routine, il foglio dei provider): le
// misure dei campi (FIELD_ROW_CLS, FIELD_PAGE_CLS), l'anello del fuoco dei
// controlli scritti a mano (FOCUS_RING), i segmenti (SettingsSegments), le
// azioni che tolgono (ROSSA_QUIETA, ROSSA_AL_PASSAGGIO), la riga «altra»
// della scheda (CARD_ROW_CLS) e la frase sotto una riga (SettingsNote).
// PERCHÉ qui e non in components/ui: i pezzi di DS2 sono chiusi (chi ha
// bisogno di un pezzo nuovo lo scrive nel suo commit), e Settings.tsx non può
// esporli — le pagine sono figlie sue, e un import all'indietro sarebbe un
// ciclo. Questo file lo importano già tutte le pagine: nessun ciclo.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * Il campo (Input o Select di components/ui) DENTRO UNA RIGA: 32 px
 * (h-control-sm, l'altezza dei controlli piccoli di DS1: toolbar, righe), il
 * raggio dei campi (rounded-control) e il testo dell'interfaccia (text-body).
 * Le classi passano da cn dentro il pezzo: vince l'ultima, sui token di DS1
 * come sulla scala di Tailwind — così la pagina decide la misura (il default
 * dei campi è 36, h-control: DS5 li ha portati anche loro ai token).
 */
export const FIELD_ROW_CLS = 'h-control-sm rounded-control text-body'

/** Il campo in una PAGINA (il modulo di un foglio, l'editor di una routine): il default dei controlli, 36 px. */
export const FIELD_PAGE_CLS = 'h-control rounded-control text-body'

/**
 * L'anello del fuoco dei controlli scritti a mano (le voci della navigazione,
 * i segmenti, le righe che si aggiungono): le STESSE classi di Button, e per
 * gli stessi motivi. Solo `focus-visible:` — mai `focus:`, che scatterebbe
 * anche dopo un clic del mouse.
 */
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

/**
 * L'azione che TOGLIE qualcosa (scollega, rimuovi, disinstalla): ROSSA, ma
 * solo nel testo. PERCHÉ non il bottone distruttivo pieno: quello è la
 * CONFERMA di un'azione distruttiva (il «Scollega» dopo la domanda, «Non
 * chiedere più»); questa è la domanda. Si aggiunge a Button `ghost`, e cn fa
 * vincere l'hover.
 */
export const ROSSA_QUIETA = 'text-destructive hover:text-destructive'

/**
 * Come ROSSA_QUIETA, ma GRIGIA finché non ci si passa sopra (elimina, revoca):
 * sta in mezzo ad altre azioni grigie, e a riposo non deve pesare più di loro.
 * Il rosso resta nel testo, mai nel fondo.
 */
export const ROSSA_AL_PASSAGGIO = 'hover:text-destructive'

/**
 * La riga «altra» di una scheda: quella che NON è nome + controllo (lo stato
 * del motore con la sua azione, una voce dello spazio su disco, una scelta
 * con i segmenti). Stesse misure di SettingsGroup/SettingsRow — alta almeno
 * 52, respiro 12, 16 ai lati — col filetto SOTTO se non è l'ultima.
 */
export const CARD_ROW_CLS = 'flex min-h-row items-center justify-between gap-3 py-row-pad [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/40'

/**
 * Il filetto sotto una frase che sta fra due righe (senza, se è l'ultima cosa della scheda). Serve
 * nudo a chi dentro la frase ci mette un <p> (un testo col suo link, che non deve entrare nel
 * messaggio di Lingui); per una frase sola c'è SettingsNote.
 */
export const CARD_NOTE_CLS = 'pb-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/40'

/**
 * La frase sotto una riga di una scheda: è la spiegazione di quella riga, e
 * sta attaccata (nessun respiro in cima). È la riga grigia di DS1 (text-small);
 * `tone="destructive"` per gli errori.
 */
export function SettingsNote({ children, tone = 'muted', className, testId }: {
  children: ReactNode
  tone?: 'muted' | 'destructive'
  className?: string
  testId?: string
}): ReactNode {
  return (
    <p
      className={cn(CARD_NOTE_CLS, 'text-small', tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground', className)}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </p>
  )
}

export function SettingsRow({ title, description, control, children, clickable, onClick, muted, stacked, testId }: {
  title: ReactNode
  description?: ReactNode
  /** il controllo a destra (interruttore, selettore, campo…) */
  control?: ReactNode
  /** contenuto libero a tutta larghezza (la scheda del provider aperta) */
  children?: ReactNode
  clickable?: boolean
  onClick?(): void
  /** R3: la riga si attenua (via alternativa momentaneamente non in gioco) */
  muted?: boolean
  /** il controllo resta sotto il nome anche in un contenitore largo */
  stacked?: boolean
  /** il testid della riga. Sta sulla riga, non su un involucro: un div in mezzo alla scheda rompebbe il filetto (la riga diventerebbe il primo figlio di quell'involucro) */
  testId?: string
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        {/* stacked: il titolo va a CAPO (le etichette lunghe del modulo non si tagliano) */}
        <span className={cn('block text-body font-medium', stacked !== true && 'truncate')}>{title}</span>
        {description !== undefined && (
          <span className="mt-0.5 block text-small text-muted-foreground">{description}</span>
        )}
      </span>
      {control !== undefined && (
        <span className="flex min-w-0 shrink-0 items-center justify-end gap-2 @[420px]:justify-end">
          {control}
        </span>
      )}
      {children}
    </>
  )
  // C3 (fase linguaggio): la riga è A FILO come quelle delle pagine (nessun
  // riquadro, nessun respiro laterale: il filetto lo porta il gruppo)
  const cls =
    'flex min-h-row w-full flex-col gap-2 py-row-pad text-left ' +
    (stacked === true ? '' : '@[420px]:flex-row @[420px]:items-center @[420px]:gap-4 ') +
    (muted === true ? 'opacity-55 transition-opacity ' : '')
  if (clickable || onClick) {
    return (
      // l'anello della riga-bottone è verso l'INTERNO (come le righe di DataTable): la riga è
      // larga quanto la scheda, che la ritaglia ai suoi angoli — un anello fuori dal bordo
      // sparirebbe ai lati. Da tastiera si vede; dopo un clic no (focus-visible)
      <button
        type="button"
        className={`${cls}transition hover:bg-muted/70 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${clickable ? '' : 'text-left'}`}
        {...(testId ? { 'data-testid': testId } : {})}
        onClick={onClick}
      >
        {body}
      </button>
    )
  }
  return <div className={cls} {...(testId ? { 'data-testid': testId } : {})}>{body}</div>
}

/**
 * I segmenti: due o più voci ESCLUSIVE in una pillola — «Sistema · Chiaro ·
 * Scuro», «Chiedi · Automatico · Non chiedere», il periodo di «Uso e costi».
 * La voce attiva è piena (in primo piano), le altre grigie. È il controllo
 * unico al posto delle pillole che ogni pagina scriveva a mano (px-2.5 py-1
 * text-xs, px-3 py-1.5 text-sm…), ognuna con la sua misura.
 *
 * Sono un radiogroup: chi ascolta sente «Tema, Sistema, selezionato, 1 di 3»,
 * non tre bottoni senza nome. Restano dei <button> (le sonde li cercano così).
 * Non c'è il giro di Tab a scacchi delle schede: qui si sceglie un valore, e
 * ogni voce deve potersi raggiungere — come nelle select native.
 *
 * `size`: sm (32) dove sta in una riga, md (36) quando sta in una pagina, come
 * ogni controllo di DS1. `fill`: le voci si dividono la larghezza (il segmento
 * largo quanto la scheda). Il contorno c'è per il tema SCURO: la scheda delle
 * impostazioni e la pillola sono quasi lo stesso colore, e senza quel filetto
 * la pillola non si vedrebbe.
 */
export function SettingsSegments<T extends string>({ options, value, onChange, label, size = 'sm', fill, disabled, testId }: {
  /** le voci, nell'ordine in cui si vedono */
  options: ReadonlyArray<{ value: T; label: ReactNode; testId?: string }>
  /** la voce attiva; null finché non si conosce (nessuna scelta: tutte le voci con aria-checked="false") */
  value: T | null
  onChange(value: T): void
  /** il nome accessibile del gruppo («Tema», «Quando chiedere»…) */
  label?: string
  /** sm: 32 px, in una riga · md: 36 px, in una pagina */
  size?: 'sm' | 'md'
  /** le voci si dividono la larghezza che c'è */
  fill?: boolean
  /** nessuna voce si può scegliere (mentre lavora) */
  disabled?: boolean
  testId?: string
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(label ? { 'aria-label': label } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn('inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card p-1', fill && 'flex w-full')}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            {...(o.testId ? { 'data-testid': o.testId } : {})}
            className={cn(
              'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full px-3 text-body transition',
              FOCUS_RING,
              'disabled:pointer-events-none disabled:opacity-50',
              size === 'sm' ? 'h-control-sm' : 'h-control',
              fill && 'min-w-0 flex-1',
              active ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
