// PP1 (fase plugin-pulita): L'INVASO delle viste della pagina Plugin e
// della scheda — il posto UNICO dove vive lo schema «colonna che non cresce
// col contenuto, corpo che scorre». Prima ogni vista rifaceva lo schema a
// mano (PluginPanel ×4 e PluginCard ×1), tutte uguale e sbagliato: la
// colonna centrale era `flex flex-col` SENZA `min-h-0 flex-1`, quindi
// cresceva quanto il contenuto e l'`overflow-y-auto` del corpo non aveva mai
// un'altezza limitata — non scorreva, e il resto finiva sotto il bordo
// («Rimuovi», «Per sviluppatori» e metà delle autorizzazioni irraggiungibili).
//
// Lo schema, spiegato: la radice è inchiodata al contenitore (absolute
// inset-0: un'altezza DEFINITA); la colonna è un suo figlio flex con
// `min-h-0 flex-1` (prende lo spazio che resta, non lo chiede); testata e
// toolbar sono `shrink-0` (non si accartociano); il corpo è `min-h-0 flex-1
// overflow-y-auto`: la sua altezza è quella che resta, il di più scorre.
// Togli uno dei due `min-h-0` e il figlio torna a crescere.
import type { ReactNode } from 'react'

/** Il livello della radice: la pagina sta sopra la chat (20), la scheda sopra la pagina (30). */
const LAYER = { 20: 'z-20', 30: 'z-30' } as const
const WIDTH = { lg: 'max-w-4xl', md: 'max-w-3xl' } as const

export function PluginShell({ header, toolbar, children, testId, size = 'lg', z = 20, outerClassName, columnClassName }: {
  /** la testata: indietro, titolo (o logo e nome, nella scheda) */
  header: ReactNode
  /** quello che sta sotto la testata e NON scorre (ricerca, segmenti, schede) */
  toolbar?: ReactNode
  /** il contenuto che scorre */
  children: ReactNode
  /** il testid della radice (plugin-page, plugin-card: quelli di oggi restano) */
  testId?: string
  /** la larghezza massima della colonna: lg = max-w-4xl (la pagina), md = max-w-3xl (le viste interne, la scheda) */
  size?: 'lg' | 'md'
  z?: 20 | 30
  /** classi in più per la radice (il respiro della pagina: px-8 py-6) */
  outerClassName?: string
  /** classi in più per la colonna (il respiro della scheda: px-6 py-5) */
  columnClassName?: string
}): ReactNode {
  return (
    <div
      className={`no-drag absolute inset-0 ${LAYER[z]} flex flex-col bg-background ${outerClassName ?? ''}`}
      data-testid={testId}
      data-plugin-shell="root"
    >
      <div
        className={`mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 ${WIDTH[size]} ${columnClassName ?? ''}`}
        data-plugin-shell="column"
      >
        <div className="shrink-0" data-plugin-shell="header">{header}</div>
        {toolbar !== undefined && <div className="shrink-0" data-plugin-shell="toolbar">{toolbar}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin pb-6" data-plugin-shell="body">{children}</div>
      </div>
    </div>
  )
}
