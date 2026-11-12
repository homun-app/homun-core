// G2 (fase guida): le parti PURE della scena — l'umore della mascotte e la
// frase della nuvoletta, decisi SOLO dal passo e dai fatti (funzioni pure,
// testabili senza montare niente). I testi sono di interfaccia (macro msg di
// Lingui, cataloghi it/en), NON messaggi del bot: niente modello, niente
// token. Le frasi sono quelle del mockup approvato.
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { BotState } from '../bot/bot-state'

/** I passi della guida come li vede la scena (la UI; il daemon resta com'è). */
export type GuideUiStep = 'welcome' | 'model' | 'approvals' | 'ready'

/** I fatti della scena: ciò che la mascotte deve sapere del passo corrente. */
export interface GuideFacts {
  /** il nome scritto finora nel passo Tu (vuoto = nessuno) */
  name: string
  /** la strada del passo modello scelta (null = si è ancora in griglia) */
  providerPath: 'cloud' | 'ollama' | 'local' | null
  /** la prova della chiave del provider cloud */
  probe: 'idle' | 'testing' | 'ok' | 'bad'
  /** un modello di Ollama è già stato scelto */
  ollamaChosen: boolean
  /** il download del modello integrato */
  download: 'idle' | 'running' | 'done'
  /** c'è un modello pronto (il passo si chiude da solo) */
  modelReady: boolean
  /** il lampo felice (~1 s) dopo la scelta di una faccia o un colore */
  flashHappy: boolean
}

export const EMPTY_GUIDE_FACTS: GuideFacts = {
  name: '', providerPath: null, probe: 'idle', ollamaChosen: false,
  download: 'idle', modelReady: false, flashHappy: false
}

/**
 * (PURA) L'umore della mascotte per il passo e i fatti, come da decisione
 * approvata sul mockup: Tu idle (happy ~1 s dopo faccia/colore); Modello
 * thinking senza scelta, listening durante prova o download, happy col
 * modello pronto, waiting con la chiave rifiutata; Permessi speaking;
 * Pronto happy.
 */
export function guideMood(step: GuideUiStep, f: GuideFacts): BotState {
  switch (step) {
    case 'welcome':
      return f.flashHappy ? 'happy' : 'idle'
    case 'model':
      // la prova della chiave o il download in corso vincono su tutto
      if (f.probe === 'testing' || f.download === 'running') return 'listening'
      if (f.modelReady) return 'happy'
      if (f.probe === 'bad') return 'waiting'
      return 'thinking'
    case 'approvals':
      return 'speaking'
    case 'ready':
      return 'happy'
  }
}

/**
 * (PURA) La frase della nuvoletta per il passo e i fatti — i testi del
 * mockup approvato, in Lingui it/en. Interpolazioni: il nome nel passo Tu.
 */
export function guideBubble(step: GuideUiStep, f: GuideFacts): MessageDescriptor {
  const name = f.name.trim()
  switch (step) {
    case 'welcome':
      return name
        ? msg`${name}? Mi piace. E che faccia ho?`
        : msg`Ciao! Sono il tuo nuovo bot. Come mi chiami?`
    case 'model':
      if (f.providerPath === null) return msg`Mi serve un cervello. Con cosa penso?`
      if (f.providerPath === 'cloud') {
        if (f.modelReady) return msg`Funziona! Sento già i pensieri.`
        if (f.probe === 'testing') return msg`Provo la chiave…`
        if (f.probe === 'bad') return msg`Mmh, questa chiave non entra.`
        return msg`Incolla la chiave: la provo subito.`
      }
      if (f.providerPath === 'ollama') {
        return f.ollamaChosen ? msg`Perfetto, uso quello sul Mac.` : msg`Hai già Ollama: scegli un modello.`
      }
      // Integrato
      if (f.download === 'done' || f.modelReady) return msg`Scaricato: penso da qui.`
      if (f.download === 'running') return msg`Scarico… ci vuole qualche minuto.`
      return msg`Posso pensare tutto qui sul Mac.`
    case 'approvals':
      return msg`Quanto posso fare senza chiederti?`
    case 'ready':
      return msg`Eccomi! Andiamo?`
  }
}

/** La chiave di re-render della nuvoletta: cambia quando cambia la frase. */
export function guideBubbleKey(step: GuideUiStep, f: GuideFacts): string {
  const d = guideBubble(step, f)
  return `${step}:${d.id ?? ''}`
}
