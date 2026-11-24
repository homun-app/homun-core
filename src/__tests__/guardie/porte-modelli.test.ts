// F3 (fase fondamenta): GUARDIA — nessuna PORTA dei modelli veri nei test e
// nelle sonde: mai 11434 (Ollama) e mai 1234 (LM Studio), nemmeno come stringa
// in un dato finto che non la contatta. Le sonde e i test ascoltano SOLO su
// 127.0.0.1 con porte libere (listen(0)) e i modelli veri restano fuori.
// Vista ROSSA prima: un pid-file finto con port: 11434 (local-model-server),
// un baseUrl finto :11434 (providers-keys) e un port: 1234 (daemon-build) —
// corretti a porte finte innocue. Le eccezioni sono i test che verificano
// PROPRIO di non toccarle.
import { describe, it, expect } from 'vitest'
import { leggiSorgenti } from './sorgenti'

const file = [
  ...leggiSorgenti('scripts', ['.probe.mjs'], { escludi: ['vetrina'] }),
  ...leggiSorgenti('src', ['.test.ts'])
]

/** Le porte dei modelli veri, come PORTE (url con porta, o campo port). */
const PORTA = /:11434\b|:1234\b|\b(?:port|PORT)\s*[:=]\s*(?:11434|1234)\b/

/** Le eccezioni, ognuna col motivo: i test che verificano di NON toccarle. */
const ECCEZIONI: ReadonlyArray<{ file: string; perché: string }> = [
  { file: 'src/daemon/__tests__/local-model-server.test.ts', perché: 'il test del server locale verifica CHE LE REGOLE TENGANO: le porte vietate sono l\'oggetto del test (i dati fatti a mano con la porta sono il caso che NON deve partire)' },
  { file: 'scripts/fase-impostazioni-probe.mjs', perché: 'la sonda delle Impostazioni si PRESENTA (nel commento) senza la scansione del Mac che toccherebbe 127.0.0.1:11434/1234: la porta compare solo nel perché della regola' }
]

describe('nessuna porta dei modelli veri (11434, 1234) nei test e nelle sonde', () => {
  it('nessun :11434 o :1234, né port: 11434/1234, fuori dalle eccezioni', () => {
    const violazioni: string[] = []
    for (const { rel, testo } of file) {
      if (rel === 'src/__tests__/guardie/porte-modelli.test.ts') continue // la guardia porta le PORTE vietate nel suo testo (il pattern)
      if (ECCEZIONI.some((e) => e.file === rel)) continue
      const codice = testo.split('\n').map((r) => (r.trim().startsWith('//') ? '' : r)).join('\n')
      if (PORTA.test(codice)) violazioni.push(rel)
    }
    expect(violazioni).toEqual([])
  })
})
