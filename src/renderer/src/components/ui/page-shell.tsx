// Fase design (DS2): IL GUSCIO DI OGNI PAGINA A TUTTA AREA — Plugin, Libreria,
// Attività, Da approvare, i documenti… Prende il posto di PluginShell (che
// serviva alla sola pagina Plugin) e ne cambia la regola fondamentale:
//
//   IL CONTENITORE CHE SCORRE È LARGO QUANTO L'AREA. In PluginShell la colonna
//   centrata (mx-auto max-w-4xl) stava attorno a TUTTO, corpo compreso: la
//   barra di scorrimento nasceva dentro la colonna. Dal vivo (beta.19): la
//   barra attaccata alla colonna, a metà finestra, invece che al bordo; e la
//   colonna che non si adattava quando la finestra si allargava. Qui la
//   radice È la colonna: testata e barra degli strumenti stanno alla
//   larghezza dell'area; il corpo che scorre è un figlio diretto della radice
//   (barra di scorrimento sul bordo destro); solo DENTRO il corpo, e dentro
//   la testata, il contenuto è centrato alla larghezza scelta (PageColumn).
//
// Lo schema che fa sì che il corpo scorra DAVVERO è quello di PP1 (spiegato in
// PluginShell): la radice è inchiodata al contenitore (absolute inset-0:
// un'altezza definita); testata, descrizione e barra degli strumenti sono
// shrink-0 (non si accartoccano); il corpo è min-h-0 flex-1 overflow-y-auto
// — la sua altezza è quella che resta, il di più scorre. Togli uno dei due e
// il corpo torna a crescere quanto il contenuto. La colonna intermedia di
// PluginShell (min-h-0 flex-1) qui non serve: il corpo è già figlio diretto
// della radice flex — ed è proprio quella colonna, centrata, a tenere la
// barra di scorrimento lontana dal bordo.
//
// IL MARGINE DIPENDE DALL'AREA, non dalla finestra: 32 px, 24 sotto i 900 px
// di area (DS1). Per questo la radice è un contenitore (@container) e il
// gutter della colonna chiede «larghezza dell'area < 900 px» con la variante
// @max-[900px]: di Tailwind, che compila in una container query. Una media
// query sulla finestra non andrebbe bene: a una finestra di 900 px l'area
// (meno la barra di sinistra) è molto più stretta di 900, e il margine
// resterebbe largo.
//
// La radice è no-drag: copre la fascia di trascinamento della chat sotto di
// lei, e le fasce ignorano lo z-index (Electron) — senza no-drag la parte di
// pagina che cade sulla fascia della chat perde i clic (la freccia indietro
// sta proprio lì). La testata che ci si mette sopra (PageHeader) ridichiara
// la SUA fascia con drag-region.
//
// Il respiro verticale del contenuto non è del guscio: lo decide la pagina
// con contentClassName (per esempio «flex flex-col gap-section pb-6»),
// perché da lì in giù il ritmo è suo (le sezioni, le tabelle).
import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * Le DUE larghezze del contenuto (C2, fase linguaggio): reading 720 (chat,
 * documenti) · wide 1120 (OGNI elenco, scheda e impostazione: una larghezza
 * sola, che non cambia con la scheda). La terza di una volta, page 880, è
 * via: era la larghezza che cambiava da pagina a pagina.
 */
export type PageWidth = 'reading' | 'wide'

/** Il livello della radice: la pagina sta sopra la chat (20), la scheda sopra la pagina (30). */
const LAYER = { 20: 'z-20', 30: 'z-30' } as const

// ciò che il guscio passa ai pezzi che ha dentro (PageColumn, PageHeader):
// valori primitivi, così non c'è un oggetto da tenere stabile tra un render e l'altro
/** La larghezza di colonna del guscio; fuori da un guscio vale «wide». */
const PageWidthContext = createContext<PageWidth>('wide')
/** Il nome della testata per la sonda; fuori da un guscio vale «pagina». */
const HeadNameContext = createContext('pagina')

/** Il nome della testata: lo legge PageHeader per la sua riga in cima alla colonna. */
export function useHeadName(): string {
  return useContext(HeadNameContext)
}

/**
 * La colonna della pagina: due elementi, uno dentro l'altro.
 *   - il «gutter» (data-page-gutter): largo quanto il suo contenitore, col
 *     margine laterale della pagina — 32 px, 24 sotto i 900 px di AREA;
 *   - il contenuto (data-page-content): centrato (mx-auto) e largo al più
 *     la larghezza scelta — cioè min(larghezza scelta, area − 2 margini).
 * È quello che guardano i test e la sonda di misura: da data-page-content si
 * risale al gutter e al corpo che scorre.
 *
 * Il gutter porta w-full min-w-0 per via della testata, che è una riga flex
 * (ColumnHead): lì la colonna deve riempire la riga — altrimenti sarebbe
 * larga quanto il suo contenuto e le azioni resterebbero appiccicate al
 * titolo — e deve potersi restringere, altrimenti la sua larghezza minima
 * sarebbe quella del titolo intero, che quindi non troncherebbe mai. In un
 * contenitore a blocchi (il corpo che scorre, gli slot) le due classi non
 * contano: un blocco è già largo quanto il suo contenitore.
 */
export function PageColumn({ width, children, className, testId, sottoTestata = false }: {
  /** la larghezza scelta; se manca, quella del guscio che la contiene (fuori da un guscio: wide) */
  width?: PageWidth
  children: ReactNode
  /**
   * classi in più per l'ELEMENTO DEL CONTENUTO — il ritmo della pagina:
   * flex flex-col gap-section… — non per il gutter
   */
  className?: string
  /** il testid del gutter, la radice della colonna */
  testId?: string
  /**
   * K3 (fase conversione-chat): la colonna comincia SOTTO LA TESTATA della
   * chat — la testata è sospesa in cima alla colonna (52, col-head) e il
   * primo del flusso (il riquadro delle approvazioni, i messaggi) si
   * riserva da sé lo spazio: 64, la testata più il respiro di 12
   */
  sottoTestata?: boolean
}): ReactNode {
  const shellWidth = useContext(PageWidthContext)
  return (
    <div
      className="w-full min-w-0 px-page-margin @max-[900px]:px-page-margin-narrow"
      data-page-gutter
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {/* la larghezza si legge dalla variabile in uno stile in linea: arriva
          dal contesto a runtime, e una classe costruita pezzo per pezzo
          (max-w-${…}) non verrebbe mai generata — Tailwind cerca i nomi interi
          nei sorgenti. Le variabili --w-* escono sempre nel CSS (@theme static) */}
      <div
        className={cn('mx-auto w-full', sottoTestata && 'pt-16', className)}
        data-page-content
        style={{ maxWidth: `var(--w-${width ?? shellWidth})` }}
      >
        {children}
      </div>
    </div>
  )
}

export function PageShell({
  width, header, description, toolbar, children, testId, z = 20, headName = 'pagina', contentClassName, scrollTestId
}: {
  /** la larghezza del contenuto, in tutte le colonne del guscio (PageColumn la legge da qui se non la riceve) */
  width: PageWidth
  /** la testata fissa: un <PageHeader />; sta in cima, larga quanto l'area */
  header?: ReactNode
  /** sotto la riga dei 52: text-small grigio, alla larghezza del contenuto */
  description?: ReactNode
  /**
   * sotto la testata e FERMA (ricerca, segmenti, schede): una riga alta 40,
   * allo stesso margine del contenuto
   */
  toolbar?: ReactNode
  /** il contenuto che scorre */
  children: ReactNode
  /** il testid della radice (plugin-page, plugin-card: quelli di oggi restano) */
  testId?: string
  /** il livello della radice: sopra la chat (20) o sopra la pagina (30) */
  z?: 20 | 30
  /** il nome della testata per la sonda: «pagina» o «pannello» */
  headName?: string
  /**
   * classi in più per l'elemento del contenuto del corpo (vedi in cima:
   * il ritmo, da lì in giù, è della pagina)
   */
  contentClassName?: string
  /** il testid del contenitore che scorre */
  scrollTestId?: string
}): ReactNode {
  return (
    <PageWidthContext.Provider value={width}>
      <HeadNameContext.Provider value={headName}>
        <div
          className={cn('no-drag @container absolute inset-0 flex flex-col bg-background', LAYER[z])}
          data-page-shell="root"
          data-testid={testId}
        >
          {/* TAL QUALE, senza colonna intorno: il ColumnHead della testata
              deve essere largo quanto l'area (è la fascia di trascinamento).
              I tre slot fermi portano px-1.5 (6 px per lato): la barra di
              scroll-thin OCCUPA 6 px, e il corpo li riserva su tutti e due i
              lati (scrollbar-gutter, in fondo) — così testata, descrizione,
              barra degli strumenti e contenuto hanno la stessa larghezza
              utile e colonne allineate */}
          {header !== undefined && (
            <div className="shrink-0 px-1.5" data-page-shell="header">{header}</div>
          )}
          {/* text-small E colore stanno bene assieme solo se cn() conosce le
              dimensioni di DS1: quello di fabbrica scambiava text-small per un
              colore e lo toglieva (lib/utils.ts; lo fissa un test) */}
          {description !== undefined && (
            <div className="shrink-0 px-1.5" data-page-shell="description">
              <PageColumn className="pb-3 text-small text-muted-foreground">{description}</PageColumn>
            </div>
          )}
          {toolbar !== undefined && (
            <div className="shrink-0 px-1.5" data-page-shell="toolbar">
              <PageColumn>
                <div className="flex min-h-10 items-center gap-3">{toolbar}</div>
              </PageColumn>
            </div>
          )}
          {/* il corpo che scorre: figlio diretto della radice, largo quanto l'area
              (overflow-x-hidden: se una pagina è più larga la taglia fuori — le
              tabelle larghe scorrono dentro se stesse).
              scrollbar-gutter: stable both-edges — la barra di scroll-thin è
              disegnata dall'app, quindi NON è a sovrapposizione: occupa 6 px.
              Riservati su un lato solo, il contenuto sarebbe 3 px a sinistra
              del centro dell'area e delle colonne ferme (lo misura la sonda:
              «contenuto non centrato»); riservati su tutti e due i lati sono
              simmetrici, e con px-1.5 sugli slot fermi tutto si allinea */}
          <div
            className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
            data-page-shell="scroll"
            data-testid={scrollTestId}
          >
            <PageColumn className={contentClassName}>{children}</PageColumn>
          </div>
        </div>
      </HeadNameContext.Provider>
    </PageWidthContext.Provider>
  )
}
