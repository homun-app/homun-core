// Fase 19b (T8.2): ipcErrorMessage toglie il prefisso grezzo di Electron
// («Error invoking remote method '<canale>': ») e l'eventuale «Error: » /
// «UiError: » in testa — nella UI non si mostra più lo stack del canale.
import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../ipc-error'

describe('fase 19b (T8.2): il testo degli errori IPC', () => {
  it('il prefisso «Error invoking remote method …» si toglie', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'screen:open': Error: lo schermo non risponde"))).toBe('lo schermo non risponde')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'files:list': cartella inesistente"))).toBe('cartella inesistente')
  })

  it('anche «UiError: » in testa si toglie (lo traduce già il confine RPC)', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'terminal:open': UiError: troppo trafficato"))).toBe('troppo trafficato')
    expect(ipcErrorMessage(new Error('Error: solo il prefisso'))).toBe('solo il prefisso')
  })

  it('un testo senza prefissi resta COME È (anche se contiene «Error: » in mezzo)', () => {
    expect(ipcErrorMessage(new Error('File non trovato'))).toBe('File non trovato')
    expect(ipcErrorMessage(new Error('qualcosa con Error: dentro'))).toBe('qualcosa con Error: dentro')
  })

  it('stringhe e altri valori diventano testo; il vuoto non resta vuoto', () => {
    expect(ipcErrorMessage('semplice')).toBe('semplice')
    expect(ipcErrorMessage('')).toBe('Errore')
    expect(ipcErrorMessage(null)).toBe('null')
    expect(ipcErrorMessage(undefined)).toBe('undefined')
  })
})
