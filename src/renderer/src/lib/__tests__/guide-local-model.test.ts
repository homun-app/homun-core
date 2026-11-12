// GC6.2 (fase guida-correzioni): il polling dello stato del modello
// integrato DENTRO la guida — il driver (lib/guide-local-model) con l'api
// FINTA: dopo «Scarica» il pannello passa subito a «Scarico…» e il polling
// riprende FINO a ready, anche se prima lo stato non era già downloading
// (il difetto: il loop partiva solo all'apertura del pannello e continuava
// solo se lo stato era già downloading — dopo localInstall() nessuno lo
// riavviava e la finestra restava ferma su «Pronto a scaricare.»).
import { describe, expect, it } from 'vitest'
import { runLocalModelPolling, type LocalModelStatusLike, type LocalModelUi } from '../guide-local-model'

/** L'api finta: risponde la sequenza data, poi resta sull'ultima. */
const fakeApi = (seq: LocalModelStatusLike[]) => {
  let i = 0
  return {
    status: async (): Promise<LocalModelStatusLike> => seq[Math.min(i++, seq.length - 1)]!,
    delays: [] as number[]
  }
}

const st = (state: string, pct?: number): LocalModelStatusLike => ({
  state,
  model: { sizeGb: 2.5 },
  ...(pct !== undefined ? { progress: { bytes: (pct / 100) * 1000, total: 1000 } } : {})
})

describe('GC6.2: il driver del polling del modello integrato', () => {
  it('install → downloading 40% → downloading 80% → ready: la barra si MUOVE e il passo si chiude da solo', async () => {
    const api = fakeApi([st('downloading', 40), st('downloading', 80), st('ready')])
    const ui: LocalModelUi[] = []
    await runLocalModelPolling({
      status: api.status,
      onUi: (u) => ui.push({ ...u }),
      delay: async (ms) => { api.delays.push(ms) },
      isAlive: () => true
    })
    expect(ui.map((u) => `${u.state}:${u.pct}`)).toEqual(['downloading:40', 'downloading:80', 'ready:100'])
    // il polling continua a ogni secondo FINO a ready (due attese per tre letture)
    expect(api.delays).toEqual([1_000, 1_000])
  })

  it('la PRIMA lettura parte anche se lo stato non è downloading (download appena avviato: si ATTESA che giri)', async () => {
    const api = fakeApi([st('not-installed'), st('downloading', 10), st('ready')])
    const ui: LocalModelUi[] = []
    await runLocalModelPolling({
      status: api.status,
      onUi: (u) => ui.push({ ...u }),
      delay: async () => { api.delays.push(1) },
      isAlive: () => true,
      expecting: () => true
    })
    // not-installed non ferma il LOOP: la lettura dopo (downloading) deve
    // arrivare — è il caso «Scarica» premuto da poco, lo stato del daemon
    // sta per girare (il pannello intanto è già su «Scarico…»)
    expect(ui.map((u) => u.state)).toEqual(['idle', 'downloading', 'ready'])
  })

  it('senza download in corso il loop SI FERMA (niente polling eterno)', async () => {
    const api = fakeApi([st('other')])
    const ui: LocalModelUi[] = []
    await runLocalModelPolling({
      status: api.status,
      onUi: (u) => ui.push({ ...u }),
      delay: async () => { api.delays.push(1) },
      isAlive: () => true
    })
    expect(ui).toHaveLength(1)
    expect(api.delays).toEqual([])
  })

  it('l\'errore dello status arriva in parole e il loop si ferma', async () => {
    let boom = true
    const ui: LocalModelUi[] = []
    await runLocalModelPolling({
      status: async () => { if (boom) throw new Error('giù'); boom = false; return st('idle') },
      onUi: (u) => ui.push({ ...u }),
      delay: async () => undefined,
      isAlive: () => true
    })
    expect(ui).toEqual([{ state: 'error', pct: 0, sizeGb: null }])
  })
})
