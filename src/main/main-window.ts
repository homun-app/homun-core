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
export interface MainWindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface MainWindowManager<W extends MainWindowLike> {
  /** La principale, o undefined se chiusa/distrutta. MAI un'altra finestra. */
  getMainWindow(): W | undefined
  /** La porta unica: crea se manca, altrimenti restore (se minimizzata) + show + focus. */
  showMainWindow(): W
  /** La finestra è stata chiusa: il manager la dimentica (solo se è LA principale). */
  forget(win: W): void
}

export function createMainWindowManager<W extends MainWindowLike>(createWindow: () => W): MainWindowManager<W> {
  let mainWindow: W | undefined

  const getMainWindow = (): W | undefined => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined)

  return {
    getMainWindow,
    showMainWindow(): W {
      let win = getMainWindow()
      if (!win) {
        win = createWindow()
        mainWindow = win
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
      }
      win.focus()
      return win
    },
    forget(win: W): void {
      if (mainWindow === win) mainWindow = undefined
    }
  }
}
