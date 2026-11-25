# DESIGN — la fonte unica del design

Le regole visive di Homun stanno in un posto solo: i token in `src/renderer/src/styles.css`, i pezzi in `src/renderer/src/components/ui/`, la guardia in `src/renderer/src/__tests__/design-scan.ts` (le eccezioni in `src/renderer/src/lib/design-exceptions.ts`). Il resto del renderer li usa e non li riscrive. Le misure di fabbrica di Tailwind (taglie di testo, raggi, pesi, interlinee) sono fuori dal tema: restano solo quelle di questa pagina.

## Token

I valori sono i letterali di `styles.css`: quelli dei colori del tema chiaro stanno in `:root`, gli stessi nomi sono ridefiniti nel blocco `.dark` (tabella in fondo); la mappa `--color-*` in `@theme inline` li porta alle utility Tailwind.

**Testo** — sei dimensioni, ognuna con la sua interlinea. Figtree per tutto; Bricolage Grotesque (`font-display`) solo per il titolo di pagina e i titoli dei documenti. La radice resta a 16 px.

| Token | Valore | Quando si usa |
|---|---|---|
| `--text-caption` | 12px | metadati, orari, badge, intestazioni di tabella, contatori |
| `--text-caption--line-height` | 16px | l'interlinea che accompagna text-caption |
| `--text-small` | 13px | seconde righe grigie, descrizioni, celle secondarie, aiuti sotto i campi |
| `--text-small--line-height` | 18px | l'interlinea che accompagna text-small |
| `--text-body` | 14px | il default dell'interfaccia (sta sul body): righe, bottoni, campi, menu, celle |
| `--text-body--line-height` | 20px | l'interlinea che accompagna text-body |
| `--text-reading` | 16px | i messaggi della chat e il testo dei documenti |
| `--text-reading--line-height` | 26px | l'interlinea che accompagna text-reading |
| `--text-title` | 20px | titoli di dialoghi, schede, pannelli; titoli di sezione grandi |
| `--text-title--line-height` | 28px | l'interlinea che accompagna text-title |
| `--text-page` | 28px | il titolo di pagina (con font-display) |
| `--text-page--line-height` | 34px | l'interlinea che accompagna text-page |

**Pesi e caratteri**

| Token | Valore | Quando si usa |
|---|---|---|
| `--font-weight-normal` | 400 | il testo |
| `--font-weight-medium` | 500 | etichette e titoli di riga |
| `--font-weight-semibold` | 600 | titoli |
| `--font-display` | "Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif | solo il titolo di pagina e i titoli dei documenti |
| `--font-sans` | "Figtree Variable", "Figtree", system-ui, sans-serif | tutto il resto dell'interfaccia (sta sul body) |

**Spaziature** — la scala di Tailwind per il resto: 0.5 1 1.5 2 3 4 5 6 8 10 12 16.

| Token | Valore | Quando si usa |
|---|---|---|
| `--spacing-page-margin` | 32px | il margine laterale della pagina |
| `--spacing-page-margin-narrow` | 24px | lo stesso margine sotto i 900 px di area |
| `--spacing-section` | 32px | fra le sezioni |
| `--spacing-section-head` | 12px | dal titolo di sezione al contenuto |
| `--spacing-block` | 16px | fra i blocchi |
| `--spacing-row` | 52px | la riga delle liste nelle pagine (con logo) |
| `--spacing-row-text` | 40px | la riga di lista di solo testo |
| `--spacing-row-nav` | 36px | la voce della barra di navigazione (R3: i 52 valgono per le liste, non per una barra) |
| `--spacing-row-pad` | 12px | il respiro verticale della riga di elenco |
| `--spacing-row-gap` | 12px | icona→testo nella riga di elenco |
| `--spacing-control` | 36px | controlli: default (bottoni, campi, ricerca) |
| `--spacing-control-sm` | 32px | controlli piccoli (toolbar, menu, icone delle testate) |
| `--spacing-col-head` | 52px | la riga in cima a ogni colonna: la fascia di trascinamento |

**Raggi**

| Token | Valore | Quando si usa |
|---|---|---|
| `--radius-control` | 8px | bottoni rettangolari, campi, menu, celle selezionate |
| `--radius-surface` | 14px | schede, bolle della chat, popover, dialoghi |

**Larghezze del contenuto** — sotto quella larghezza il contenuto occupa l'area meno i margini.

| Token | Valore | Quando si usa |
|---|---|---|
| `--w-reading` | 720px | chat, documenti |
| `--w-page` | 880px | liste, impostazioni, pagine di plugin |
| `--w-wide` | 1120px | tabelle: Collegati, Uso e costi, Attività |
| `--container-reading` | var(--w-reading) | la stessa misura come contenitore (max-w-reading) |
| `--container-page` | var(--w-page) | la stessa misura come contenitore (max-w-page) |
| `--container-wide` | var(--w-wide) | la stessa misura come contenitore (max-w-wide) |

**Ombra**

| Token | Valore | Quando si usa |
|---|---|---|
| `--shadow-soft` | 0 20px 50px -25px oklch(0.2 0.02 80 / 0.25) | l'ombra morbida degli elenchi sospesi (per esempio l'elenco del ModelPicker) |

**Colori — la mappa delle utility (`@theme inline`)** — ogni riga porta la variabile del tema all'utility Tailwind (`bg-primary`, `text-muted-foreground`, `border-border`…).

| Token | Valore | Quando si usa |
|---|---|---|
| `--color-background` | var(--background) | il fondo dell'interfaccia |
| `--color-foreground` | var(--foreground) | il testo in primo piano |
| `--color-card` | var(--card) | il fondo delle schede e del pannello destro |
| `--color-card-foreground` | var(--card-foreground) | il testo sulle schede |
| `--color-popover` | var(--popover) | il fondo dei menu e dei popover |
| `--color-popover-foreground` | var(--popover-foreground) | il testo dei menu |
| `--color-primary` | var(--primary) | il colore primario (il bottone primary) |
| `--color-primary-foreground` | var(--primary-foreground) | il testo sul primario |
| `--color-secondary` | var(--secondary) | il fondo secondario |
| `--color-secondary-foreground` | var(--secondary-foreground) | il testo sul secondario |
| `--color-muted` | var(--muted) | il fondo tenue (hover, secondario) |
| `--color-muted-foreground` | var(--muted-foreground) | il grigio delle seconde righe |
| `--color-accent` | var(--accent) | la voce di menu evidenziata (focus) |
| `--color-accent-foreground` | var(--accent-foreground) | il testo sulla voce evidenziata |
| `--color-destructive` | var(--destructive) | le azioni distruttive (Rifiuta) |
| `--color-destructive-foreground` | var(--destructive-foreground) | il testo sulle azioni distruttive |
| `--color-border` | var(--border) | i filetti |
| `--color-waiting` | var(--waiting) | l'ambra dei «ti aspetta» e delle card di rischio |
| `--color-input` | var(--input) | il bordo dei campi |
| `--color-ring` | var(--ring) | l'anello del fuoco da tastiera |
| `--color-ring-offset-background` | var(--background) | lo sfondo sotto l'anello del fuoco |
| `--color-chart-1` | var(--chart-1) | il primo colore dei grafici e dei pallini di stato |
| `--color-chart-2` | var(--chart-2) | il secondo colore dei grafici |
| `--color-guide-good` | var(--guide-good) | il verde dei testi della guida (G7) |
| `--color-chart-3` | var(--chart-3) | il terzo colore dei grafici |
| `--color-chart-4` | var(--chart-4) | il quarto colore dei grafici |
| `--color-chart-5` | var(--chart-5) | il quinto colore dei grafici |
| `--color-sidebar` | var(--sidebar) | il fondo della barra di sinistra |
| `--color-sidebar-foreground` | var(--sidebar-foreground) | il testo della barra |
| `--color-sidebar-primary` | var(--sidebar-primary) | il primario dentro la barra |
| `--color-sidebar-primary-foreground` | var(--sidebar-primary-foreground) | il testo sul primario della barra |
| `--color-sidebar-accent` | var(--sidebar-accent) | la voce evidenziata della barra |
| `--color-sidebar-accent-foreground` | var(--sidebar-accent-foreground) | il testo sulla voce evidenziata della barra |
| `--color-sidebar-border` | var(--sidebar-border) | i filetti della barra |
| `--color-sidebar-ring` | var(--sidebar-ring) | l'anello del fuoco nella barra |
| `--shadow-soft` | var(--shadow-soft) | l'utility Tailwind `shadow-soft` |

**Colori — tema chiaro (`:root`)**

| Token | Valore | Quando si usa |
|---|---|---|
| `--background` | oklch(0.975 0.006 85) | il fondo dell'app (e del velo della testata) |
| `--card` | oklch(0.995 0.003 85) | il fondo delle schede e del pannello destro |
| `--muted` | oklch(0.94 0.008 85) | il fondo tenue |
| `--muted-foreground` | oklch(0.5 0.01 80) | il grigio delle seconde righe |
| `--foreground` | oklch(0.18 0.01 80) | il testo in primo piano |
| `--border` | oklch(0.9 0.01 85) | i filetti |
| `--card-foreground` | oklch(0.129 0.042 264.695) | il testo sulle schede |
| `--popover` | oklch(1 0 0) | il fondo dei menu |
| `--popover-foreground` | oklch(0.129 0.042 264.695) | il testo dei menu |
| `--primary` | oklch(0.208 0.042 265.755) | il primario |
| `--primary-foreground` | oklch(0.984 0.003 247.858) | il testo sul primario |
| `--secondary` | oklch(0.968 0.007 247.896) | il fondo secondario |
| `--secondary-foreground` | oklch(0.208 0.042 265.755) | il testo sul secondario |
| `--accent` | oklch(0.968 0.007 247.896) | la voce di menu evidenziata |
| `--accent-foreground` | oklch(0.208 0.042 265.755) | il testo sulla voce evidenziata |
| `--destructive` | oklch(0.577 0.245 27.325) | le azioni distruttive |
| `--destructive-foreground` | oklch(0.984 0.003 247.858) | il testo sulle azioni distruttive |
| `--input` | oklch(0.929 0.013 255.508) | il bordo dei campi |
| `--ring` | oklch(0.704 0.04 256.788) | l'anello del fuoco |
| `--chart-1` | oklch(0.646 0.222 41.116) | grafici e pallini di stato |
| `--chart-2` | oklch(0.6 0.118 184.704) | grafici |
| `--guide-good` | oklch(0.48 0.11 175) | il verde dei testi della guida |
| `--chart-3` | oklch(0.398 0.07 227.392) | grafici |
| `--chart-4` | oklch(0.828 0.189 84.429) | grafici |
| `--chart-5` | oklch(0.769 0.188 70.08) | grafici |
| `--sidebar` | oklch(0.984 0.003 247.858) | la barra di sinistra |
| `--sidebar-foreground` | oklch(0.129 0.042 264.695) | il testo della barra |
| `--sidebar-primary` | oklch(0.208 0.042 265.755) | il primario della barra |
| `--sidebar-primary-foreground` | oklch(0.984 0.003 247.858) | il testo sul primario della barra |
| `--sidebar-accent` | oklch(0.968 0.007 247.896) | la voce evidenziata della barra |
| `--sidebar-accent-foreground` | oklch(0.208 0.042 265.755) | il testo sulla voce evidenziata |
| `--sidebar-border` | oklch(0.929 0.013 255.508) | i filetti della barra |
| `--sidebar-ring` | oklch(0.704 0.04 256.788) | l'anello del fuoco nella barra |
| `--waiting` | oklch(0.55 0.12 80) | l'ambra dei «ti aspetta» e delle card di rischio |
| `--bubble-user` | oklch(0.208 0.042 265.755) | la bolla dei messaggi dell'utente (stessi valori di --primary) |
| `--bubble-user-foreground` | oklch(0.984 0.003 247.858) | il testo nella bolla dell'utente |
| `--bot-ink` | oklch(0.16 0.01 80) | la mascotte: l'inchiostro |
| `--bot-screen` | oklch(0.2 0.01 80) | la mascotte: lo schermo |
| `--bot-blush` | oklch(0.75 0.15 15) | la mascotte: il blush |
| `--bot-c1` | oklch(0.68 0.2 45) | la palette della mascotte (forme grandi) |
| `--bot-c2` | oklch(0.65 0.24 355) | la palette della mascotte |
| `--bot-c3` | oklch(0.72 0.17 155) | la palette della mascotte |
| `--bot-c4` | oklch(0.62 0.19 255) | la palette della mascotte |
| `--bot-c5` | oklch(0.82 0.16 90) | la palette della mascotte |
| `--bot-c6` | oklch(0.7 0.12 195) | la palette della mascotte |
| `--bot-c7` | oklch(0.25 0.01 80) | la palette della mascotte |
| `--bot-dot-c1` | oklch(0.51 0.2 45) | i puntini di stato dei bot (R5: tinta del bot, contrasto ≥ 3:1) |
| `--bot-dot-c2` | oklch(0.59 0.24 355) | i puntini di stato dei bot |
| `--bot-dot-c3` | oklch(0.39 0.17 155) | i puntini di stato dei bot |
| `--bot-dot-c4` | oklch(0.44 0.19 255) | i puntini di stato dei bot |
| `--bot-dot-c5` | oklch(0.4 0.16 90) | i puntini di stato dei bot |
| `--bot-dot-c6` | oklch(0.39 0.12 195) | i puntini di stato dei bot |
| `--bot-dot-c7` | oklch(0.25 0.01 80) | i puntini di stato dei bot |
| `--shadow-soft` | 0 20px 50px -25px oklch(0.2 0.02 80 / 0.25) | l'ombra morbida |

**Colori — tema scuro (`.dark`)** — gli stessi nomi del tema chiaro, con i valori che il blocco `.dark` ridefinisce.

| Token | Valore | Quando si usa |
|---|---|---|
| `--background` | oklch(0.129 0.042 264.695) | il fondo dell'app in scuro |
| `--foreground` | oklch(0.984 0.003 247.858) | il testo in scuro |
| `--card` | oklch(0.208 0.042 265.755) | le schede in scuro |
| `--card-foreground` | oklch(0.984 0.003 247.858) | il testo sulle schede |
| `--popover` | oklch(0.208 0.042 265.755) | i menu in scuro |
| `--popover-foreground` | oklch(0.984 0.003 247.858) | il testo dei menu |
| `--primary` | oklch(0.929 0.013 255.508) | il primario in scuro |
| `--primary-foreground` | oklch(0.208 0.042 265.755) | il testo sul primario |
| `--secondary` | oklch(0.279 0.041 260.031) | il fondo secondario |
| `--secondary-foreground` | oklch(0.984 0.003 247.858) | il testo sul secondario |
| `--muted` | oklch(0.279 0.041 260.031) | il fondo tenue |
| `--muted-foreground` | oklch(0.704 0.04 256.788) | il grigio delle seconde righe |
| `--accent` | oklch(0.279 0.041 260.031) | la voce di menu evidenziata |
| `--accent-foreground` | oklch(0.984 0.003 247.858) | il testo sulla voce evidenziata |
| `--destructive` | oklch(0.704 0.191 22.216) | le azioni distruttive |
| `--destructive-foreground` | oklch(0.984 0.003 247.858) | il testo sulle azioni distruttive |
| `--border` | oklch(1 0 0 / 10%) | i filetti in scuro |
| `--input` | oklch(1 0 0 / 15%) | il bordo dei campi |
| `--ring` | oklch(0.551 0.027 264.364) | l'anello del fuoco |
| `--waiting` | oklch(0.78 0.11 80) | l'ambra dei «ti aspetta» |
| `--bubble-user` | oklch(0.929 0.013 255.508) | la bolla dell'utente (come --primary) |
| `--bubble-user-foreground` | oklch(0.208 0.042 265.755) | il testo nella bolla |
| `--chart-1` | oklch(0.488 0.243 264.376) | grafici e pallini di stato |
| `--chart-2` | oklch(0.696 0.17 162.48) | grafici |
| `--guide-good` | oklch(0.696 0.17 162.48) | il verde dei testi della guida |
| `--chart-3` | oklch(0.769 0.188 70.08) | grafici |
| `--chart-4` | oklch(0.627 0.265 303.9) | grafici |
| `--chart-5` | oklch(0.645 0.246 16.439) | grafici |
| `--sidebar` | oklch(0.208 0.042 265.755) | la barra di sinistra |
| `--sidebar-foreground` | oklch(0.984 0.003 247.858) | il testo della barra |
| `--sidebar-primary` | oklch(0.488 0.243 264.376) | il primario della barra |
| `--sidebar-primary-foreground` | oklch(0.984 0.003 247.858) | il testo sul primario della barra |
| `--sidebar-accent` | oklch(0.279 0.041 260.031) | la voce evidenziata della barra |
| `--sidebar-accent-foreground` | oklch(0.984 0.003 247.858) | il testo sulla voce evidenziata |
| `--sidebar-border` | oklch(1 0 0 / 10%) | i filetti della barra |
| `--sidebar-ring` | oklch(0.551 0.027 264.364) | l'anello del fuoco nella barra |
| `--bot-dot-c1` | oklch(0.76 0.2 45) | i puntini in scuro: luminosità che si vede (≥ 3:1) |
| `--bot-dot-c2` | oklch(0.81 0.24 355) | i puntini in scuro |
| `--bot-dot-c3` | oklch(0.72 0.17 155) | i puntini in scuro |
| `--bot-dot-c4` | oklch(0.71 0.19 255) | i puntini in scuro |
| `--bot-dot-c5` | oklch(0.82 0.16 90) | i puntini in scuro |
| `--bot-dot-c6` | oklch(0.71 0.12 195) | i puntini in scuro |
| `--bot-dot-c7` | oklch(0.67 0.01 80) | i puntini in scuro (il c7 era nero su nero) |

## Componenti

### stack
La colonna dell'impaginazione: i figli uno sotto l'altro alla distanza di una variante chiusa delle token — `gap` tight 8 · block 16 (default, fra i blocchi) · section 32 · none. È il pezzo che toglie i `className` di disposizione dalle pagine: fuori da `components/ui/` non si decide più la distanza fra i blocchi. Non usarlo per righe (quella è Row) né per contenere ciò che deve scorrere (lo decide il guscio della pagina).
Galleria: impaginazione.

### row
La riga dell'impaginazione (NON la riga di elenco: quella è ListRow): figli uno accanto all'altro, allineati una volta per tutti (`align` start · center · baseline · stretch) e alla distanza di una variante chiusa — `gap` tight 8 · item 12 (default) · block 16 · section 32 · none; `wrap` per mandare a capo. Chi scrive «flex items-center gap-3» fuori da ui/ sta riscrivendo questo pezzo.
Galleria: impaginazione.

### text
Il testo del catalogo: le sei taglie dei token (page 28 · title 20 · body 14, il default · small 13 · caption 12 · reading 16), ognuna con la sua interlinea; `tone` normale · grigio (le seconde righe) · errore; `weight` i tre pesi del tema (400 · 500 etichette e titoli di riga · 600 titoli); `truncate` per la riga che si taglia. Fuori da ui/ non si sceglie più la taglia di un testo col className.
Galleria: testo.

### app-logo
Il logo di un'app del catalogo: il file del repo (o un data: URL), e quando manca l'iniziale su una piastrella tenue — mai un'emoji. La misura la dà chi lo rende con `className` (size-8 nelle righe, size-10 nelle testate di scheda); il raggio e il fondo del tema scuro stanno in lib/app-logos, in un posto solo.
Galleria: identita.

### avatar
La mascotte del bot: il disegno VERO di bot/Bot (le cinque famiglie h-creature · h-robo · h-device · jelly · pixel, la palette della mascotte --bot-c*), alle misure chiuse `size` sm 20 · md 32 (default, le righe) · lg 40 (le testate) · xl 64; `state` cambia occhi e antenne, `label` la rende un'immagine col nome accessibile. Non ridisegnare la mascotte fuori da qui e non confondere la palette: il PUNTINO di stato è BotDot.
Galleria: identita.

### bot-dot
Il puntino del colore di un bot: 8 px, tinta dalla palette `--bot-dot-c1…c7` (R5: contrasto ≥ 3:1 sul fondo della riga, in chiaro e in scuro) — NON dalla palette della mascotte. Il nome del bot resta nel colore del testo: il colore del bot sta qui.
Galleria: identita.

### icon
L'icona del catalogo: SOLO Lucide, con la misura scritta dal pezzo — `size` sm 16 (default: il testo e i bottoni) · lg 20 (le testate). Senza misura lucide disegna 24, e la regola del tema è che la misura si scrive sempre: fuori da ui/ non si scrive più, la scrive questa. aria-hidden di default: l'etichetta accessibile sta nel controllo che la porta.
Galleria: testo.

### grid
La griglia dell'impaginazione: figli in colonne uguali (2 di default, oppure 3 · 4 · 6) alla distanza dei token (`gap` tight 8 · item 12 · block 16 default · section 32). Le card della Libreria e i riquadri a colonne si compongono con questa, non con una griglia scritta in pagina.
Galleria: impaginazione.

### ModelPicker
Il combobox con ricerca per scegliere un modello a mano: ogni riga mostra id, finestra di contesto, le etichette visione/ragionamento/niente tool e il prezzo $/M; si può scrivere un id libero e confermare con Invio; `pillTrigger` lo riduce a una pillola che apre l'elenco. Non usarlo dove i modelli arrivano da provider da collegare (quello è ModelSelect, che offre «Collega»), né come campo di testo qualunque.
Galleria: impostazioni-routine.

### ModelSelect
Il selettore del modello per provider: riga chiusa col nome e il provider grigio, popover con ricerca in cima, modelli raggruppati per provider con le capacità come icone e sotto i provider da collegare; il livello di ragionamento sta nel «⋯» della riga chiusa. Non usarlo per elenchi fuori dai provider collegati (lì ModelPicker), né come select generica (ui/select).
Galleria: impostazioni-modelli, chat-pannello.

### button
Il bottone unico dell'interfaccia: primary/secondary/ghost/destructive, altezze md 36 e sm 32, forma pill per le azioni principali e per il ghost solo-icona (tondo), control per il resto; `icon` per i bottoni con la sola icona (con aria-label); `asChild` per vestire un link. Non usarlo per le righe cliccabili di un elenco (FlatRow), le voci di menu (dropdown-menu) o per scrivere pillole a mano.
Galleria: da-approvare (Consenti pillola, Rifiuta destructive), dialogo-nuovo.

### column-head
La riga di 52 px in cima a OGNI colonna (barra, chat, squadra, pannello destro, pagine): è la fascia di trascinamento della finestra, marcata `data-col-head` perché la sonda la riconosca. Non usarlo per righe di contenuto né fuori dalla cima di una colonna; ogni controllo dentro porta `no-drag`, e il contenuto va in una PageColumn perché titolo e azioni stiano alla larghezza del contenuto.
Galleria: chat, barra.

### data-table
La tabella unica («Collegati», «Uso e costi», «Attività», Registro): intestazioni `text-caption` grigie, celle `text-body`, seconde righe `text-small`, righe da 52, filetti, niente a capo (`table-fixed` con la `<col>` per colonna e `truncate` col titolo intero al passaggio), scorrimento orizzontale DENTRO la tabella. `Cell` per la cella a una riga, `CellStack` per le due righe volute. Non usarlo per elenchi senza colonne (FlatList) né per contenuti che devono andare a capo.
Galleria: plugin-collegati, impostazioni-uso.

### dialog
Il dialogo modale (Radix): titolo `text-title`, descrizione `text-small`, mai più alto della finestra (scorre dentro), ✕ in alto a destra; il default di larghezza min(32rem, 100%-2rem) si sostituisce davvero con il max-w del chiamante. Non usarlo per pagine a tutta area (PageShell) né per menu agganciati a un bottone (dropdown-menu); il dialogo, il suo velo e i menu bucano le fasce di trascinamento.
Galleria: dialogo-nuovo, impostazioni-generali.

### dropdown-menu
Il menu a comparsa (Radix): voci `text-body` con icone a 16, variante destructive, checkbox e radio col segno disegnato, etichette `text-caption`, scorciatoie; resta dentro la finestra (collisionPadding 12). Non usarlo per scegliere un modello (ModelSelect), per azioni sempre visibili (button) o per schede (UnderlineTabs).
Galleria: menu-account, chat (menu «Ragiona»).

### list-row
LA riga di elenco dell'app, un solo oggetto per ogni elenco: `segno` (icona, logo, puntino o mascotte nella casa da 32) · `titolo` (text-body 500, si tronca) · `sottotitolo` (la riga grigia) · `metadato` (il dato grigio ai caption, a destra) · `azione` (a destra: in una riga è sempre Button secondary sm; Switch solo per acceso/spento; i link di testo spariscono) · `below` (ciò che sta sotto, all'ascissa del titolo). Misure fisse: min-h-row 52 col segno, 40 senza; respiro py-row-pad. `clickable` fa della riga un bottone con hover tenue solo dove si clicca. Prende il posto di SettingsRow, AppRow, YourRow e delle righe scritte a mano.
Galleria: elenchi.

### flat-list
Le righe a filo: `FlatList` è l'elenco col filetto tra le righe, `FlatRow` la riga (leading nello slot da 32, title `text-body` peso 500, subtitle grigia `text-small`, trailing a destra; min-h-row 52 con leading, 40 senza). Nessun fondo, nessun riquadro: l'hover solo dove si clicca. Non usarlo dove servono colonne (DataTable) o vere card (`rounded-surface bg-card`).
Galleria: impostazioni-cassaforte-plugin, plugin-server.

### input
Il campo di testo dell'interfaccia: 36 px (`h-control`), raggio dei controlli, testo body, anello del fuoco solo da tastiera; FIELD_CLASS è condivisa con Select così su una riga hanno la stessa altezza. Non usarlo per scegliere modelli (ModelPicker/ModelSelect) né per scrivere stile locale di campo: al più la misura (`h-control-sm`) e la larghezza.
Galleria: impostazioni-approvazioni, impostazioni-modelli (foglio di collegamento).

### notice
La riga di sistema compatta della chat: icona · testo grigio `text-small` (va a capo, non tronca) · «· N volte» · azione a destra; tono neutral, warning o destructive. È solo la vista: raggruppare e contare gli avvisi sta in lib/notice-rows.ts. Non usarlo per i messaggi di bot o le bolle (quello è il testo reso), né per blocchi: è una riga.
Galleria: chat-avvisi.

### page-header
La testata di una pagina a tutta area: indietro · icona (20, grigia) o logo (40) · titolo `text-page` in font-display · azioni a destra; la descrizione sta sotto, in una riga sua, mai dentro la riga dei 52. Le misure le decide la testata, non chi la usa. Non usarlo per le testate di colonna di chat, barra e pannelli (lì ColumnHead senza PageHeader); i controlli nelle azioni portano `no-drag`.
Galleria: plugin-lista, documento.

### page-shell
Il guscio di ogni pagina a tutta area: `PageShell` (radice inchiodata all'area, testata/descrizione/toolbar ferme, corpo che scorre figlio diretto della radice, barra di scorrimento sul bordo) e `PageColumn` (gutter col margine della pagina, contenuto centrato a reading/page/wide; margine 32, 24 sotto i 900 px di area — container query, non media query). Non usarlo per la chat a colonne e i pannelli laterali, né centrare il corpo a mano: la larghezza la dà il guscio.
Galleria: plugin-lista, libreria-griglia.

### section
La sezione: titolo · azione a destra · blocchi a 16 px (`gap-block`); dal titolo al contenuto 12 px (`gap-section-head`); titolo in tre misure — caption (default, l'etichetta di gruppo), body, title. Nessun margine esterno: la distanza fra le sezioni la decide chi le elenca (`gap-section`). Non usarlo come card (il `className` serve a quello: `rounded-surface bg-card p-4`) né per elenchi di righe a filo.
Galleria: plugin-scheda, da-approvare.

### select
La `<select>` nativa comune, gemella dell'Input: stessa altezza (36), stesso padding e corpo del testo, così su una riga coincidono. Non usarla per scegliere un modello (ModelSelect), dove serve ricerca o righe ricche, e non scrivere select con stile locale.
Galleria: impostazioni-approvazioni, impostazioni-generali.

### underline-tabs
Le schede come TESTO: l'attiva in primo piano con la sottolineatura di 2 px, le altre grigie; UNA riga sola, mai a capo — se non ci sta, scorre in orizzontale senza barra e le sfumature ai lati dicono che c'è altro; tastiera a frecce con tablist a scacchi. Non usarlo per navigazione di pagina (quella è la barra) né dove servono segmenti in pillola; il filetto di base sta sull'involucro, non sulla tablist.
Galleria: plugin-connettori, impostazioni-cassaforte.

## Schemi di pagina

- **Pagina di lista** (Plugin › lista, Da approvare, Attività, Libreria › lista): `PageShell` a larghezza `page` (880; `wide` 1120 per le tabelle: Collegati, Uso e costi). Testata `PageHeader` sulla riga `data-col-head` di 52 px, FERMA: è la fascia di trascinamento e (R2) il velo che separa ciò che scorre sotto; toolbar ferma da 40; il corpo scorre, figlio diretto della radice, con la barra di scorrimento sul bordo dell'area. Margine laterale `page-margin` 32, `page-margin-narrow` 24 sotto i 900 px di area.
- **Pagina di dettaglio** (la scheda del plugin, il documento): stessa struttura a livello 30 sopra la pagina (20); testata con «indietro» tondo da 32 e logo da 40; il documento aperto sta nella colonna `reading` (720) col titolo `text-page` in font-display.
- **Chat a colonne**: barra di sinistra (voci `row-nav` 36) · colonna di lettura `reading` 720 centrata (messaggi `text-reading`, bolla utente `--bubble-user`, card all'85%) · squadra · pannello destro. Ogni colonna ha la sua riga `data-col-head` a 52, ferma col velo `.col-head-velo` (R2): il transcript scorre SOTTO; il primo contenuto, a scorrimento zero, resta sotto la fascia. Il documento non scorre mai da solo (`overflow: clip`).
- **Impostazioni**: un dialogo che non scorre per intero — navigazione ferma a sinistra, riga ferma col titolo di sezione e la ✕, sotto la colonna che scorre col margine dentro; contenuto a larghezza `page`, sezioni e righe a filo; Cassaforte a `UnderlineTabs`, «Uso e costi» in `DataTable`.

## Regole

- Icone: solo lucide, 16 px (`size-4`) nel testo e nei bottoni, 20 px (`size-5`) nelle testate; loghi 32 (`size-8`) nelle righe, 40 (`size-10`) nelle testate di scheda — la misura si scrive sempre: senza, lucide fa 24.
- Nessuna emoji nell'interfaccia — le figure sono le icone lucide: coerenti col resto, vettoriali, misurabili dalla guardia.
- L'anello del fuoco solo su `:focus-visible` — dopo un clic del mouse non deve comparire (`data-focus-from: pointer` in styles.css); una classe `focus:` scatterebbe su ogni fuoco.
- Contrasti: testo ≥ 4,5:1; i puntini di stato dei bot ≥ 3:1 sul fondo della riga, in chiaro e in scuro (palette `--bot-dot-*`, R5).
- Errori permanenti con «Come si risolve» (apre la scheda dell'app, dove stanno configurazione e alternative); «Riprova» resta per i temporanei — riprovare una causa permanente non serve (R6).
- Nessun px arbitrario nelle classi: vietati `text-[…]`, `p-[…] gap-[…]`, `rounded-[…]`, `w-[…px]`, le taglie e i raggi di fabbrica — le misure le decidono i token (guardia design-guard; le eccezioni, una sola, in design-exceptions.ts).
- I colori stanno in styles.css — nel tema chiaro e scuro, con la mappa `--color-*`: nessun colore nuovo scritto nel renderer.
- L'interlinea è legata alla dimensione del testo: ogni taglia ha la sua (12/16 … 28/34), `leading-` non si scrive.
- Pesi 400/500/600 — testo, etichette e titoli di riga, titoli; bold e light sono fuori dal tema.
- La scala di spaziatura è quella di Tailwind (0.5 1 1.5 2 3 4 5 6 8 10 12 16) più le distanze con un nome (`--spacing-*`) — multipli di 4 px, con la radice a 16.
- Nessun maiuscoletto, nessuna spaziatura delle lettere scritta a mano (`uppercase`, `tracking-` vietati) — le etichette si leggono per misura e peso, non per maiuscole.
