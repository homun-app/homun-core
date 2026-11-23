// W1 (fase avvio-finestra): la porta UNICA della finestra principale, PURA
// (nessun import di Electron, testabile con un BrowserWindow finto).
//
// Prima del main ricreava la principale solo quando
// BrowserWindow.getAllWindows().length === 0 — ma ESISTONO altre finestre
// (la PiP di createPipHandle, le finestre dell'aggiornamento, l'offscreen di
// ipc.ts host.printToPDF): con una di loro viva, chiudere la principale e
// cliccare il Dock non faceva NIENTE; e second-instance faceva show() di tutte
// (PiP nascosta compresa) senza MAI ricreare la principale chiusa.
//
// Ora UNA funzione sola: showMainWindow() — se la principale manca o è
// distrutta la crea, altrimenti restore() se minimizzata, poi show() e
// focus(). getMainWindow() torna SOLO la principale (o undefined): mai la
// PiP, mai un ripiego su getAllWindows()[0]. La usano activate,
// second-instance, open-url senza agente, openAgent e il clic del tray.
//
// P3.5 (fase primo-avvio): l'activate del Dock RIPARA. Alla finestra che c'è
// già, PRIMA si dà al deps la possibilità di riportarla a posto (beforeShow:
// nel main i bounds dentro uno schermo), poi restore() se minimizzata, show()
// (una finestra nascosta si mostra; una visibile non cambia), e la si porta
// davanti (bringToFront: su macOS app.focus({ steal: true }) e poi il focus).
// Una finestra che nasce NASCOSTA (show: false, P3.2) NON riceve il focus da
// qui: un focus la mostrerebbe prima del tempo — la mostra la politica di
// mostra, che la porta davanti.
export interface MainWindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  /** P3.5: la finestra è visibile? (Electron: isVisible). Se manca si intende visibile. */
  isVisible?(): boolean
}

export interface MainWindowManagerDeps<W> {
  /** P3.5: subito prima di mostrare una finestra che c'è già (i bounds dentro uno schermo). */
  beforeShow?(win: W): void
  /** P3.5: porta l'app e la finestra davanti (default: win.focus()). */
  bringToFront?(win: W): void
}

export interface MainWindowManager<W extends MainWindowLike> {
  /** La principale, o undefined se chiusa/distrutta. MAI un'altra finestra. */
  getMainWindow(): W | undefined
  /** La porta unica: crea se manca, altrimenti la ripara (a posto, minimizzata, nascosta) e la porta davanti. */
  showMainWindow(): W
  /** La finestra è stata chiusa: il manager la dimentica (solo se è LA principale). */
  forget(win: W): void
}

export function createMainWindowManager<W extends MainWindowLike>(
  createWindow: () => W,
  deps: MainWindowManagerDeps<W> = {}
): MainWindowManager<W> {
  let mainWindow: W | undefined

  const getMainWindow = (): W | undefined => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined)
  const toFront = (win: W): void => {
    if (deps.bringToFront) deps.bringToFront(win)
    else win.focus()
  }

  return {
    getMainWindow,
    showMainWindow(): W {
      let win = getMainWindow()
      if (!win) {
        win = createWindow()
        mainWindow = win
        // nasce nascosta (show: false)? La mostra la politica di mostra: qui
        // il focus la farebbe comparire prima del tempo
        if (win.isVisible?.() !== false) toFront(win)
      } else {
        deps.beforeShow?.(win)
        if (win.isMinimized()) win.restore()
        win.show()
        toFront(win)
      }
      return win
    },
    forget(win: W): void {
      if (mainWindow === win) mainWindow = undefined
    }
  }
}
