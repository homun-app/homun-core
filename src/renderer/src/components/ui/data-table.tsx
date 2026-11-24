// Fase design (DS2): LA TABELLA UNICA — la useranno «Collegati», «Uso e
// costi», «Attività» e ogni altra tabella dell'app. Prima ogni pagina ne
// aveva una con regole sue: in «Collegati» le intestazioni erano in
// MAIUSCOLETTO e il testo andava a capo («Tutti i / bot», «tramite /
// Composio»). Le regole, dalla spec: intestazioni text-caption grigie in tono
// normale · celle text-body · seconde righe text-small · righe da 52 px ·
// filetti tra le righe (e sotto le intestazioni) · NIENTE A CAPO nei valori
// brevi, troncati col testo intero al passaggio · scorrimento orizzontale
// DENTRO la tabella se la finestra è stretta.
//
// COME si ottengono:
//  - niente a capo: table-fixed con una <col> per colonna. Se la larghezza la
//    decide la <col> e non il contenuto, una cella non si allarga per far
//    stare il suo testo — e `truncate` lo chiude coi puntini. Le colonne
//    senza larghezza (grow) si dividono lo spazio che resta.
//  - il titolo intero al passaggio: `title` sulla riga di testo, quando il
//    contenuto è una stringa (un nodo non ha un «titolo intero» da mostrare).
//  - scorrimento dentro, mai nella pagina: la tabella è larga come il
//    contenitore e ALMENO la somma delle colonne (min-width: + 160 per ogni
//    colonna che cresce); sotto quella misura scorre il contenitore.
//  - i filetti: border-t sulla riga, border-b sulla riga delle intestazioni;
//    con border-collapse i due che si toccano sono uno.
//  - la riga che si apre: un <tr> con tabIndex, Invio e Spazio — SENZA
//    role="button". Il ruolo lo cambia per davvero: una riga che si dice
//    bottone esce dalla tabella, per gli aid. (FlatRow è un div, e il ruolo
//    serve; qui no.) Il suo anello del fuoco è esplicito e verso l'interno
//    (focus-visible:outline-2 con -outline-offset-2, nel colore --ring come
//    gli altri pezzi di components/ui): il contenitore scorre, dunque
//    ritaglia al proprio riquadro, e la riga è larga quanto il riquadro — un
//    anello fuori dal bordo, ai lati, sparirebbe.
//
// Dove stanno insieme una dimensione di testo e un colore si usa clsx, che
// concatena e basta: qui non c'è nulla da fondere. (cn, in lib/utils, conosce
// i token di DS1 dal commit 626750e2: il motivo era un cn che non li conosceva.)
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { cn } from '../../lib/utils'

export interface DataTableColumn<Row> {
  id: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** larghezza fissa della colonna in px (default 128) */
  width?: number
  /** la colonna si prende lo spazio che resta (minimo 160) */
  grow?: boolean
  /** l'allineamento della COLONNA: vale per l'intestazione e per le celle */
  align?: 'left' | 'right'
}

/** La larghezza di una colonna che non la dice. */
const DEFAULT_WIDTH = 128
/** Il minimo di una colonna che cresce: sotto questo, la tabella scorre. */
const GROW_MIN = 160

/**
 * Lo slot del leading nelle celle (logo o icona): lo stesso di FlatRow — 32
 * px, centrati. Un'icona da 16 e un logo da 32 mettono il testo alla stessa
 * ascissa, riga dopo riga.
 */
const SLOT = 'grid size-8 shrink-0 place-items-center'

/** Il testo intero da mostrare al passaggio: solo una stringa lo ha. */
const titleOf = (content: ReactNode): string | undefined => (typeof content === 'string' ? content : undefined)

export function DataTable<Row>({ columns, rows, rowKey, onRowClick, rowTestId, testId, empty }: {
  columns: ReadonlyArray<DataTableColumn<Row>>
  rows: ReadonlyArray<Row>
  rowKey: (row: Row) => string
  /** se c'è, la riga si apre: cursore, hover tenue, tasto (Invio e Spazio fanno il clic) */
  onRowClick?: (row: Row) => void
  rowTestId?: (row: Row) => string
  /** il testid del contenitore che scorre */
  testId?: string
  /** cosa mostrare senza righe, al posto della tabella (senza: restano le intestazioni) */
  empty?: ReactNode
}): ReactNode {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>
  const openable = onRowClick !== undefined
  const minWidth = columns.reduce((sum, c) => sum + (c.grow ? GROW_MIN : c.width ?? DEFAULT_WIDTH), 0)
  return (
    <div className="overflow-x-auto scroll-thin" {...(testId ? { 'data-testid': testId } : {})}>
      <table className="w-full table-fixed border-collapse text-left" style={{ minWidth }}>
        <colgroup>
          {columns.map((c) => <col key={c.id} style={c.grow ? undefined : { width: c.width ?? DEFAULT_WIDTH }} />)}
        </colgroup>
        <thead>
          <tr className="border-b border-border/50">
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                // clsx e non cn: qui stanno insieme text-caption e un colore (vedasi in testa)
                className={clsx('py-2 pr-4 align-middle font-normal text-caption text-muted-foreground whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cn('h-row border-t border-border/50', openable && 'cursor-pointer transition hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring')}
              tabIndex={openable ? 0 : undefined}
              {...(rowTestId ? { 'data-testid': rowTestId(row) } : {})}
              onClick={openable ? () => onRowClick(row) : undefined}
              onKeyDown={openable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  // lo spazio non deve far scorrere la pagina
                  e.preventDefault()
                  onRowClick(row)
                }
              } : undefined}
            >
              {columns.map((c) => (
                <td key={c.id} className={c.align === 'right' ? 'py-row-pad pr-4 align-middle text-right' : 'py-row-pad pr-4 align-middle'}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Una cella da UNA riga, troncata (niente a capo), col testo intero nel
 * title. `secondary`: la cella di dettaglio, text-small grigia (metadati,
 * seconda informazione). `leading`: logo o icona, nello slot da 32, sulla
 * stessa riga.
 */
export function Cell({ children, secondary, leading }: {
  children: ReactNode
  secondary?: boolean
  leading?: ReactNode
}): ReactNode {
  const text = (
    <span
      // clsx e non cn: con secondary stanno insieme text-small e un colore. In una riga flex
      // il testo deve poter restringersi (min-w-0) o `truncate` non avrebbe nulla da troncare
      className={clsx('block truncate', leading !== undefined && 'min-w-0 flex-1', secondary && 'text-small text-muted-foreground')}
      title={titleOf(children)}
    >
      {children}
    </span>
  )
  if (leading === undefined) return text
  return (
    <span className="flex items-center gap-row-gap">
      <span className={SLOT}>{leading}</span>
      {text}
    </span>
  )
}

/**
 * Una cella da DUE righe volute: il titolo text-body in peso medio (il
 * titolo di riga di DS1) e sotto la riga grigia text-small. Tutte e due
 * troncate, col titolo intero nel title quando sono stringhe. `leading`:
 * logo o icona nello slot da 32, accanto alle due righe.
 */
export function CellStack({ primary, secondary, leading }: {
  primary: ReactNode
  secondary?: ReactNode
  leading?: ReactNode
}): ReactNode {
  const lines = (
    <span className={clsx('block', leading !== undefined && 'min-w-0 flex-1')}>
      <span className="block truncate text-body font-medium" title={titleOf(primary)}>{primary}</span>
      {secondary !== undefined && <span className="mt-0.5 block truncate text-small text-muted-foreground" title={titleOf(secondary)}>{secondary}</span>}
    </span>
  )
  if (leading === undefined) return lines
  return (
    <span className="flex items-center gap-row-gap">
      <span className={SLOT}>{leading}</span>
      {lines}
    </span>
  )
}
