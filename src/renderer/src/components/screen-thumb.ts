// SV2/SV3 (fase schermo-vivo) — l'ANTEPRIMA DAL VIVO dello schermo del bot
// nella card «Computer»: qui vive la logica PURA di collegamento
// (thumbShouldConnect: la tabella dei casi sta nei test) e il controller
// della connessione (una sola peek per bot, RFB sempre in sola lettura, senza
// NESSUN input al box, ultima immagine velata per 60 s). Il componente
// ScreenThumb.tsx è un guscio sottile: raccoglie i fatti dallo store e dal
// documento e li porta qui.
//
// Decisioni (scritte anche nel REPORT):
// - «mai due peek per bot per finestra» la garantisce il RENDERER: il
//   controller scollega la connessione esistente PRIMA di aprirne un'altra e
//   non apre mai in parallelo;
// - l'anteprima usa qualityLevel BASSO e compressionLevel ALTO (valori sotto):
//   il riquadro è piccolo, la banda conta più della fedeltà.

/** La qualità JPEG richiesta all'anteprima (0 = minima, 9 = massima). */
export const THUMB_QUALITY_LEVEL = 2

/** La compressione richiesta all'anteprima (0 = minima, 9 = massima). */
export const THUMB_COMPRESSION_LEVEL = 6

/** Quanto resta l'«Ultima immagine» prima di tornare al riquadro di oggi. */
export const THUMB_LAST_IMAGE_MS = 60_000

/** SV3: dopo un tentativo fallito si riprova dopo questo ritardo. */
export const THUMB_RETRY_MS = 1_000

/** SV3: dopo 3 tentativi falliti di fila l'anteprima smette di riprovare. */
export const THUMB_MAX_FAILURES = 3

/** I fatti che decidono se l'anteprima si collega: TUTTI insieme o niente. */
export interface ThumbFacts {
  /** il browser del bot è acceso (screenStatus.browser === 'running') */
  browserRunning: boolean
  /** la scheda Attività del pannello è quella visibile */
  activityTabVisible: boolean
  /** la finestra è visibile (document.visibilityState === 'visible') */
  windowVisible: boolean
  /** la scheda Computer di quel bot è aperta: la stessa cosa in grande basta una volta */
  computerTabOpen: boolean
  /** la finestra PiP di quel bot è aperta (SV4) */
  pipOpen: boolean
}

/**
 * L'anteprima si collega SOLO se valgono tutte: browser acceso, scheda
 * Attività visibile, finestra visibile, scheda Computer e PiP di quel bot
 * chiuse. Appena una cade ci si scollega; quando tornano tutte vere si riapre
 * con una capability NUOVA (peek, SV1). Funzione PURA: la tabella dei casi
 * sta nei test.
 */
export function thumbShouldConnect(facts: ThumbFacts): boolean {
  return (
    facts.browserRunning &&
    facts.activityTabVisible &&
    facts.windowVisible &&
    !facts.computerTabOpen &&
    !facts.pipOpen
  )
}

/** La fase visibile dell'anteprima. */
export type ThumbPhase =
  | 'idle' // il riquadro di oggi (browser spento o niente da mostrare)
  | 'connecting' // capability chiesta / handshake in corso (già in 16:10)
  | 'connected' // la vista dal vivo
  | 'last' // l'ultima immagine, velata, per 60 s

/** La superficie di RFB che usa il controller (iniettabile per i test). */
export interface ThumbRfb {
  disconnect(): void
  addEventListener(type: 'connect' | 'disconnect', listener: (e: { detail?: { clean?: boolean } }) => void): void
  viewOnly: boolean
  scaleViewport: boolean
  clipViewport: boolean
  focusOnClick: boolean
  qualityLevel: number
  compressionLevel: number
}

/** Le dipendenze del controller (tutte iniettabili: i test passano finti). */
export interface ThumbDeps {
  /** apre la vista peek — nel componente: api.screenOpen(agentId, 'view', { peek: true }) */
  openScreen: () => Promise<{ url: string } | null>
  /**
   * Costruisce l'RFB sul contenitore. Nel componente è un import DINAMICO di
   * @novnc/novnc (il modulo non entra nel grafo statico del renderer: la card
   * «Computer» si rende anche dove il canvas non serve).
   */
  createRfb: (el: unknown, url: string, wsProtocols: string[]) => Promise<ThumbRfb> | ThumbRfb
  /** l'ultimo fotogramma del canvas del contenitore (dataURL), o null */
  captureImage: (el: unknown) => string | null
  /** il contenitore del canvas */
  element: () => unknown
  /** pianifica un ritardo e torna la sua cancellazione */
  schedule: (fn: () => void, ms: number) => () => void
  /** notifica la fase (e l'eventuale ultima immagine) al componente */
  onPhase: (phase: ThumbPhase, lastImage: string | null) => void
}

/**
 * Il controller dell'anteprima: una macchinetta sincrona sui fatti. Il
 * componente la crea quando monta e la distrugge quando smonta (cambio di
 * scheda compreso: la scheda Attività si SMONTA quando non è più visibile).
 * Mai due connessioni: se ne esiste una, non se ne apre un'altra; prima di
 * aprirne una nuova la vecchia viene scollegata.
 */
export class ScreenThumbController {
  private rfb: ThumbRfb | null = null
  private opening = false
  private gen = 0
  private phase: ThumbPhase = 'idle'
  private lastImage: string | null = null
  private cancelLastTimer: (() => void) | null = null
  private cancelRetryTimer: (() => void) | null = null
  private failures = 0
  private givenUp = false
  private facts: ThumbFacts | null = null

  constructor(private readonly deps: ThumbDeps) {}

  /** I fatti sono cambiati (visibilità, scheda, stato del browser, PiP). */
  onFacts(facts: ThumbFacts): void {
    this.facts = facts
    if (!thumbShouldConnect(facts)) {
      this.close()
      return
    }
    if (this.rfb !== null || this.opening) return
    if (this.givenUp) return // SV3: tre fallimenti di fila, si riprova solo al prossimo evento `screen`
    void this.open()
  }

  /**
   * SV3: il segnale che lo stato del browser è CAMBIATO (evento `screen` del
   * daemon, a ogni cambio): azzera i fallimenti e riapre i tentativi se i
   * fatti sono ancora tutti veri (l'evento arriva anche quando il browser si
   * spegne: in quel caso non si apre niente, ci pensano i fatti).
   */
  browserStateChanged(): void {
    this.failures = 0
    this.givenUp = false
    if (this.facts && thumbShouldConnect(this.facts) && this.rfb === null && !this.opening) void this.open()
  }

  /** Chiusura definitiva (smontaggio del componente). */
  destroy(): void {
    this.close()
    this.cancelRetryTimer?.()
    this.cancelRetryTimer = null
    this.cancelLastTimer?.()
    this.cancelLastTimer = null
    this.lastImage = null
    this.setPhase('idle')
  }

  /** La fase attuale (per il componente, al render). */
  get currentPhase(): ThumbPhase {
    return this.phase
  }

  private close(): void {
    // invalida le aperture in volo (i listener dell'RFB vecchio non contano più)
    this.gen++
    this.cancelRetryTimer?.()
    this.cancelRetryTimer = null
    if (this.rfb) {
      const image = this.deps.captureImage(this.deps.element())
      this.rfb.disconnect()
      this.rfb = null
      if (image && (this.phase === 'connected' || this.phase === 'connecting')) this.showLast(image)
      else this.setPhase('idle')
    }
  }

  private async open(): Promise<void> {
    const gen = ++this.gen
    this.opening = true
    this.cancelLastTimer?.()
    this.cancelLastTimer = null
    this.setPhase('connecting')
    try {
      const opened = await this.deps.openScreen()
      if (gen !== this.gen) return // nel frattempo i fatti sono cambiati: butta via
      if (!opened) {
        // il browser è SPENTO: nessun avvio, nessun riprovino (lo stato del
        // browser tornerà con l'evento `screen`)
        this.setPhase('idle')
        return
      }
      const rfb = await this.deps.createRfb(this.deps.element(), opened.url, ['binary'])
      // NESSUN input al box: sola lettura, niente focus al clic, niente clip
      rfb.viewOnly = true
      rfb.scaleViewport = true
      rfb.clipViewport = false
      rfb.focusOnClick = false
      // l'anteprima è piccola: qualità bassa, compressione alta
      rfb.qualityLevel = THUMB_QUALITY_LEVEL
      rfb.compressionLevel = THUMB_COMPRESSION_LEVEL
      rfb.addEventListener('connect', () => {
        if (gen !== this.gen) return
        this.failures = 0 // SV3: collegato, la serie dei fallimenti riparte
        this.setPhase('connected')
      })
      rfb.addEventListener('disconnect', () => {
        if (gen !== this.gen) return
        // la connessione è CADUTA (o il browser si è chiuso): l'ultima
        // immagine resta velata per 60 s, mai mostrata come dal vivo
        const wasConnected = this.phase === 'connected'
        const image = this.deps.captureImage(this.deps.element())
        this.rfb = null
        this.gen++
        if (image) this.showLast(image)
        else {
          if (!wasConnected) this.countFailure() // caduta prima di connettersi
          this.setPhase('idle')
        }
      })
      this.rfb = rfb
    } catch {
      if (gen !== this.gen) return
      this.rfb = null
      this.countFailure() // openScreen rifiutata: è un tentativo fallito
      this.setPhase('idle')
    } finally {
      if (gen === this.gen) this.opening = false
    }
  }

  /**
   * SV3: un tentativo è FALLITO (apertura rifiututa o connessione caduta prima
   * di connettersi). Dopo THUMB_RETRY_MS si riprova se i fatti sono ancora
   * tutti veri; dopo THUMB_MAX_FAILURES di fila ci si ferma — niente cicli di
   * riconnessione — finché non arriva un evento `screen` nuovo.
   */
  private countFailure(): void {
    this.failures++
    if (this.failures >= THUMB_MAX_FAILURES) {
      this.givenUp = true
      return
    }
    this.cancelRetryTimer?.()
    this.cancelRetryTimer = this.deps.schedule(() => {
      this.cancelRetryTimer = null
      if (this.facts && thumbShouldConnect(this.facts) && this.rfb === null && !this.opening) void this.open()
    }, THUMB_RETRY_MS)
  }

  /** L'ultima immagine, velata, per 60 s: mai mostrata come se fosse dal vivo. */
  private showLast(image: string): void {
    this.lastImage = image
    this.setPhase('last')
    this.cancelLastTimer?.()
    this.cancelLastTimer = this.deps.schedule(() => {
      this.lastImage = null
      this.cancelLastTimer = null
      this.setPhase('idle')
    }, THUMB_LAST_IMAGE_MS)
  }

  private setPhase(phase: ThumbPhase): void {
    if (phase === this.phase && phase !== 'last') return
    this.phase = phase
    this.deps.onPhase(phase, this.lastImage)
  }
}
