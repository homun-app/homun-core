// C2 (fase linguaggio): ListPage — IL MODELLO della pagina di elenco: testata
// (titolo + azione principale) → barra degli strumenti FERMA (le schede, UN
// livello, a sinistra — oppure la ricerca — poi le pillole, la vista a
// destra) → corpo con ListGroup/DataTable. Larghezza UNA SOLA, wide, che non
// cambia con la scheda. Niente descrizione sotto il titolo: la frase va nello
// stato vuoto o nell'aiuto. La pagina si RIEMPIE, non si ridisegna.
import type { ReactNode } from 'react'
import { PageShell } from './page-shell'
import { PageHeader } from './page-header'
import { PageToolbar } from './page-toolbar'
import { UnderlineTabs } from './underline-tabs'

/**
 * La pagina di elenco. La barra è UNA riga di 40: `schede` (UnderlineTabs, UN
 * livello: Plugin › Tutto · Connettori · Skill · Collegati) a sinistra — se
 * non ci sono, la ricerca — poi `pillole` e `vista` a destra; con `toolbar`
 * si passa la barra già fatta.
 */
export function ListPage<T extends string>({ titolo, icona, logo, azione, schede, toolbar, ricerca, pillole, vista, children, testId, headName, contentClassName }: {
  /** il titolo della pagina (testo di pagina, font-display: lo mette la testata) */
  titolo: ReactNode
  /** l'icona da 20 accanto al titolo */
  icona?: ReactNode
  /** il logo da 40 accanto al titolo (le pagine di cosa) */
  logo?: ReactNode
  /** l'azione principale della testata, a destra («Aggiungi») */
  azione?: ReactNode
  /** UN livello di schede (UnderlineTabs), a sinistra della barra; le «strade» interne diventano pillole */
  schede?: { tabs: ReadonlyArray<readonly [T, ReactNode]>; value: T; onChange(v: T): void; testId?: string }
  /** la barra già fatta (PageToolbar): senza, la si compone con schede/ricerca/pillole/vista */
  toolbar?: ReactNode
  /** la ricerca (SearchField), a sinistra della barra quando non ci sono schede */
  ricerca?: ReactNode
  /** le pillole di filtro (FilterChips) */
  pillole?: ReactNode
  /** lo slot della vista a destra della barra */
  vista?: ReactNode
  /** il corpo che scorre: ListGroup/ListRow, oppure DataTable */
  children: ReactNode
  testId?: string
  headName?: string
  contentClassName?: string
}): ReactNode {
  const barra = toolbar ?? (
    <PageToolbar
      ricerca={schede !== undefined
        ? <UnderlineTabs<T> tabs={schede.tabs} value={schede.value} onChange={schede.onChange} {...(schede.testId ? { testId: schede.testId } : {})} className="min-w-0 flex-1" />
        : ricerca}
      pillole={pillole}
      vista={vista}
    />
  )
  return (
    <PageShell
      width="wide"
      testId={testId}
      z={20}
      headName={headName}
      header={<PageHeader title={titolo} icon={icona} logo={logo} actions={azione} />}
      toolbar={barra}
      contentClassName={contentClassName}
    >
      {children}
    </PageShell>
  )
}
