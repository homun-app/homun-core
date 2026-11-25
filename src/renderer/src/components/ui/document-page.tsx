// C2 (fase linguaggio): DocumentPage — IL MODELLO del documento della
// Libreria: il guscio a larghezza READING (720), il titolo di documento
// (text-page in font-display), «indietro» tondo e logo da 40. Il corpo è il
// documento reso (DocumentBody typography page).
import type { ReactNode } from 'react'
import { PageShell } from './page-shell'
import { PageHeader } from './page-header'

/** La pagina di un documento: lettura, non elenco. */
export function DocumentPage({ titolo, logo, indietro, azione, toolbar, children, testId, headName, contentClassName }: {
  /** il titolo del documento (font-display: lo mette la testata) */
  titolo: ReactNode
  /** il logo da 40 accanto al titolo */
  logo?: ReactNode
  /** il «‹ indietro»: dove torna e come si chiama */
  indietro: { onClick(): void; label: string; testId?: string }
  /** le azioni della testata, a destra */
  azione?: ReactNode
  /** la barra ferma (l'indice del documento) */
  toolbar?: ReactNode
  /** il documento */
  children: ReactNode
  testId?: string
  headName?: string
  contentClassName?: string
}): ReactNode {
  return (
    <PageShell
      width="reading"
      z={30}
      testId={testId}
      headName={headName}
      header={<PageHeader title={titolo} logo={logo} back={indietro} actions={azione} />}
      toolbar={toolbar}
      contentClassName={contentClassName}
    >
      {children}
    </PageShell>
  )
}
