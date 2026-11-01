// Fase 19a (V4): @novnc/novnc (1.7.0, MPL-2.0) non porta tipi TypeScript —
// qui la superficie che usa BotScreen (classe RFB, opzioni ed eventi). Si
// importa la classe direttamente nel renderer, senza iframe.
declare module '@novnc/novnc' {
  /** Il client RFB di noVNC: costruito su un elemento DOM e un URL WebSocket. */
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrDataChannel: string | WebSocket,
      options?: {
        /** sottoprotocolli WebSocket richiesti (noVNC parla `binary`) */
        wsProtocols?: string[]
        credentials?: { username?: string; password?: string; target?: string }
        shared?: boolean
        showDotCursor?: boolean
        background?: string
        scaleViewport?: boolean
        resizeSession?: boolean
      }
    )
    /** sola lettura: il client non invia input */
    viewOnly: boolean
    /** il desktop viene scalato per stare nel contenitore */
    scaleViewport: boolean
    /** il desktop viene tagliato al contenitore (senza scaling) */
    clipViewport: boolean
    /** il server può ridimensionare la sessione alla finestra */
    resizeSession: boolean
    disconnect(): void
    sendCredentials(creds: { username?: string; password?: string; target?: string }): void
    sendCtrlAltDel(): void
    focus(options?: { preventScroll?: boolean }): void
    blur(): void
    clipboardPasteFromClipboard(text: string): void
    addEventListener(
      type: 'connect' | 'disconnect' | 'securityfailure' | 'clipboard' | 'credentialsrequired' | 'serververification',
      listener: (ev: CustomEvent<never>) => void
    ): void
  }
}
