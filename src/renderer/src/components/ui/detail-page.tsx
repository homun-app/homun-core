// C2 (fase linguaggio): DetailPage — IL MODELLO della scheda (di un plugin,
// di un server): la testata della pagina di elenco (con «indietro»), la
// STESSA larghezza wide, le schede, e sotto sezioni ListGroup. Sta a livello
// 30 sopra la pagina che l'ha aperta (20).
import type { ReactNode } from 'react'
import { PageShell } from './page-shell'
import { PageHeader } from './page-header'

/**
 * La scheda di una cosa (plugin, server): «indietro», l'icona o il logo, il
 * titolo, le azioni; il corpo con le sezioni. La larghezza è quella delle
 * pagine (wide): la scheda non è più stretta dell'elenco che l'ha aperta.
 */
export function DetailPage({ titolo, icona, logo, indietro, azione, toolbar, children, testId, headName, contentClassName }: {
  /** il titolo della scheda */
  titolo: ReactNode
  /** l'icona da 20 accanto al titolo */
  icona?: ReactNode
  /** il logo da 40 accanto al titolo */
  logo?: ReactNode
  /** il «‹ indietro»: dove torna e come si chiama */
  indietro: { onClick(): void; label: string; testId?: string }
  /** le azioni della testata, a destra */
  azione?: ReactNode
  /** la barra ferma (schede della scheda) */
  toolbar?: ReactNode
  /** il corpo che scorre: sezioni ListGroup */
  children: ReactNode
  testId?: string
  headName?: string
  contentClassName?: string
}): ReactNode {
  return (
    <PageShell
      width="wide"
      z={30}
      testId={testId}
      headName={headName}
      header={<PageHeader title={titolo} icon={icona} logo={logo} back={indietro} actions={azione} />}
      toolbar={toolbar}
      contentClassName={contentClassName}
    >
      {children}
    </PageShell>
  )
}
