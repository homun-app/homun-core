// Fase design (DS3): LA CORNICE DELLA FINESTRA — dove stanno i semafori di
// macOS e quanto è alta la riga in cima a ogni colonna. La legge il main
// (BrowserWindow: titleBarStyle «hiddenInset», trafficLightPosition) e il
// renderer (le testate della barra, dell'area principale e dei pannelli): in
// un posto solo, così i semafori non possono coprire nulla e le icone della
// barra non possono finire fuori dalla loro riga.
//
// La barra del titolo è nascosta: i tre semafori (chiudi, riduci, espandi)
// restano e l'app deve lasciar loro libero il posto in alto a sinistra.

/** L'angolo sinistro alto del bottone «chiudi», dalla cima e dal bordo sinistro della finestra. */
export const TRAFFIC_LIGHT_POSITION = { x: 12, y: 19 } as const
/** Un bottone dei semafori è alto e largo 14 px (il cerchio disegnato 12). */
export const TRAFFIC_LIGHT_BUTTON = 14
/** Fra il centro di un semaforo e il successivo: 20 px. */
export const TRAFFIC_LIGHT_PITCH = 20
/** Dal bordo sinistro del primo bottone al bordo destro dell'ultimo: 54 px. */
export const TRAFFIC_LIGHTS_WIDTH: number = TRAFFIC_LIGHT_BUTTON + TRAFFIC_LIGHT_PITCH * 2
/** L'altezza della testata di OGNI colonna: la riga dei semafori e delle icone, la fascia di trascinamento. */
export const COLUMN_HEAD_HEIGHT = 52
/** La prima icona della barra (apri/chiudi la colonna) sta a 12 px dai semafori: da qui comincia il contenuto della testata. */
export const SIDEBAR_HEAD_PAD: number = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHTS_WIDTH + 12
/** Il centro verticale dei semafori: la riga su cui devono stare anche le icone (tolleranza 1 px). */
export const TRAFFIC_LIGHT_ROW: number = TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_BUTTON / 2
