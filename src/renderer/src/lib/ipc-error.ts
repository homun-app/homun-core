// Fase 19b (T8.2): il testo di un errore IPC senza il prefisso grezzo di
// Electron. `ipcRenderer.invoke` wrappea qualunque errore del canale come
// «Error invoking remote method '<canale>': Error: <testo>» — nella UI si
// mostrava tutto quanto. Qui si toglie il prefisso e l'eventuale «Error: » /
// «UiError: » in testa; il resto è già il testo nella lingua dell'interfaccia
// (il confine RPC del daemon traduce gli UiError col catalogo).
const INVOKE_PREFIX = /^Error invoking remote method '[^']*': /

/** Il messaggio pulito di un errore IPC (PURO): niente prefisso né «Error: ». */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw
    .replace(INVOKE_PREFIX, '')
    .replace(/^(?:Ui)?Error: /, '')
    .trim() || 'Errore'
}
