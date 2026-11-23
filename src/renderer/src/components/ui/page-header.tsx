// Fase design (DS2): LA TESTATA DI UNA PAGINA A TUTTA AREA — indietro · icona
// (o logo) · titolo · azioni a destra — sulla riga dei 52 px che vale per
// ogni colonna (ColumnHead: la fascia di trascinamento della finestra), col
// contenuto alla larghezza della pagina (PageColumn). Sotto, facoltativa, la
// descrizione: MAI dentro la riga, sempre in una riga sua — la riga dei 52
// deve restare alta 52 in ogni pagina, è ciò che allinea le testate (DS3).
//
// Le MISURE le decide la testata, non chi la usa (è il sistema: le regole in
// un posto solo): l'icona è 20 px e grigia, il logo 40 px, «indietro» è un
// bottone tondo da 32 con l'icona a 16, il titolo è text-page in Bricolage
// Grotesque (font-display: lo portano solo il titolo di pagina e i titoli dei
// documenti). Chi passa un'icona può passarla nuda (<Puzzle />): la misura la
// mette la testata.
//
// Le azioni sono i controlli di chi chiama, e stanno nella fascia di
// trascinamento: devono portare no-drag ciascuno (la regola di DS3), come lo
// porta «indietro».
import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { ColumnHead } from './column-head'
import { PageColumn, useHeadName } from './page-shell'

export function PageHeader({ title, icon, logo, back, actions, description, testId }: {
  /** il titolo di pagina; se è una stringa, finisce anche nell'attributo title */
  title: ReactNode
  /** l'icona della pagina (20 px, grigia): un'icona lucide */
  icon?: ReactNode
  /** il logo dell'app (40 px), nelle testate di scheda: al posto dell'icona */
  logo?: ReactNode
  /** il bottone indietro; `label` è il suo nome accessibile (lo passa chi chiama), `testId` il suo testid (quello che le sonde cercano) */
  back?: { onClick(): void; label: string; testId?: string }
  /** le azioni a destra: controlli che portano ciascuno no-drag */
  actions?: ReactNode
  /** sotto la riga dei 52: text-small grigio, alla larghezza del contenuto */
  description?: ReactNode
  /** il testid della testata */
  testId?: string
}): ReactNode {
  // il nome lo dà il guscio (PageShell, headName): la sonda sa di quale colonna sta misurando la riga
  const name = useHeadName()
  // shrink-0 sulla radice: è una testata FISSA, in qualunque colonna flex la si metta
  return (
    <div className="shrink-0" data-testid={testId}>
      <ColumnHead name={name}>
        <PageColumn>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* shrink-0 su «indietro»: è un controllo di misura fissa. Senza, quando
                il titolo non ci sta si restringe ANCHE lui (fino alla larghezza
                dell'icona) e il bottone tondo diventa un ovale */}
            {back !== undefined && (
              <button
                type="button"
                aria-label={back.label}
                {...(back.testId ? { 'data-testid': back.testId } : {})}
                className="no-drag grid size-control-sm shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={back.onClick}
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            {logo !== undefined ? (
              <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center [&>img]:size-10 [&>svg]:size-10">
                {logo}
              </span>
            ) : icon !== undefined ? (
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5">
                {icon}
              </span>
            ) : null}
            {/* min-w-0 truncate: il titolo cede lo spazio alle azioni e tronca; se è
                una stringa l'attributo title fa leggere il nome intero al passaggio */}
            <h1
              className="min-w-0 truncate font-display font-semibold text-page"
              {...(typeof title === 'string' ? { title } : {})}
            >
              {title}
            </h1>
            {actions !== undefined && (
              <>
                {/* lo spazio che resta: tiene le azioni attaccate al bordo destro del contenuto */}
                <span className="flex-1" />
                <div className="flex shrink-0 items-center gap-2">{actions}</div>
              </>
            )}
          </div>
        </PageColumn>
      </ColumnHead>
      {/* una colonna a parte, DOPO la riga: pb-3 la tiene a 12 px da ciò che segue */}
      {description !== undefined && (
        <PageColumn className="pb-3 text-small text-muted-foreground">{description}</PageColumn>
      )}
    </div>
  )
}
