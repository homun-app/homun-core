// Fase design (DS2): LA RIGA IN CIMA A OGNI COLONNA — barra di sinistra, area
// principale, pannelli laterali, pagine a tutta area. È alta SEMPRE 52 px
// (h-col-head, il token col-head), ed è la condizione perché le testate di
// tutte le colonne stiano allineate: i semafori di macOS (titleBarStyle:
// 'hiddenInset') e le icone accanto hanno il centro sulla stessa riga
// orizzontale solo se ogni colonna ha in cima LA STESSA riga, non «una
// testata più o meno alta» (DS3).
//
// È la FASCIA DI TRASCINAMENTO della finestra (drag-region: la barra del
// titolo è nascosta, la finestra si trascina da qui). I figli di una fascia
// restano nella fascia: OGNI controllo che ci finisce dentro (bottone, campo,
// menu) porta no-drag, altrimenti il clic serve a trascinare la finestra e il
// controllo non risponde. E chi copre con lo z-index la fascia di un'altra
// colonna (una pagina sopra la chat) porta no-drag sulla propria radice: le
// fasce ignorano lo z-index (Electron).
//
// Il contenuto va in una PageColumn (components/ui/page-shell): così titolo e
// azioni stanno alla larghezza del contenuto, con lo stesso margine del corpo,
// mentre la riga resta larga quanto l'area e si trascina da un bordo all'altro.
//
// `name` non si vede: è il nome con cui la sonda di misura (DS6) riconosce la
// riga — «barra», «chat», «pannello», «pagina»… — e controlla, colonna per
// colonna, che sia alta 52 px.
import type { ReactNode } from 'react'

export function ColumnHead({ name, children, className }: {
  /**
   * il nome della riga per la sonda di misura («barra», «chat», «pannello»,
   * «pagina»…)
   */
  name: string
  children?: ReactNode
  /**
   * classi in più per la riga (per esempio justify-between). Sono AGGIUNTE,
   * non fuse: le classi proprie della riga non si sovrascrivono — è la riga
   * dei 52 con la sua fascia, sempre
   */
  className?: string
}): ReactNode {
  // le classi proprie stanno FISSE nel testo dell'attributo, non dentro
  // cn(): la guardia di DS3 (__tests__/window-frame.test.ts) legge il testo
  // fisso di className e per ogni riga data-col-head pretende di trovarvi
  // drag-region e h-col-head
  return (
    <div
      data-col-head={name}
      className={`drag-region flex h-col-head shrink-0 items-center${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}
