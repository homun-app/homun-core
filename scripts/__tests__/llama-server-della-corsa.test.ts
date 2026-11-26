// I2 (fase isolamento-locale): la pulizia di una sonda conta solo i
// llama-server DELLA CORSA. Il controllo di prima contava tutti i
// llama-server del Mac (pgrep -x) meno quelli già in corsa all'inizio: il
// runner con cui l'Ollama dell'utente carica un modello, nato mentre la sonda
// gira, la faceva chiudere rossa («baseline 0, nuovi 1», capitato nella
// corsa di fatto.mjs della fase linguaggio-ritocchi).
//
// La regola è PURA (classificaLlamaServer, in scripts/lib/sonda.mjs — la usano
// tutte le sonde allo stesso modo): qui si prova su una tabella di processi
// finta, senza avviare nulla. La prova dal vivo, con i finti, è
// scripts/fase-isolamento-locale-probe.mjs.
import { describe, expect, it } from 'vitest'

// l'helper è un .mjs delle sonde: si importa com'è (qui niente si avvia: le funzioni provate sono pure)
const { classificaLlamaServer, fotografiaDi, messaggioLlamaServer } = await import('../lib/sonda.mjs')

type Riga = { ppid: number; comando: string }

const T = '/cartella-finta/T'
const RADICE = `${T}/sandbot-fase-prova-Ab1Cd2`
const SONDA = 50
const APP = 100
const DAEMON = 110
const OLLAMA = 900   // l'Ollama dell'utente: non è della corsa e non si tocca

const DEL_DAEMON = 120    // figlio del daemon: negli argomenti NON c'è la radice della corsa
const DEL_APP = 121       // figlio dell'app
const CON_RADICE = 130    // lo ha avviato la sonda, con la radice della corsa negli argomenti
const FUORI = 140         // lo ha avviato la sonda, senza radice: non è della corsa
const DELL_UTENTE = 150   // il runner dell'Ollama dell'utente

const NUDO = 'llama-server --host 127.0.0.1 --port 0'

/** La corsa VIVA: la sonda, l'app (figlia della sonda), il daemon (figlio dell'app), l'Ollama dell'utente. */
const processiVivi = (): Map<number, Riga> => new Map([
  [1, { ppid: 0, comando: '/sbin/launchd' }],
  [SONDA, { ppid: 1, comando: 'node scripts/fase-prova-probe.mjs' }],
  [APP, { ppid: SONDA, comando: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .' }],
  [DAEMON, { ppid: APP, comando: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --homun-daemon' }],
  [OLLAMA, { ppid: 1, comando: '/Applications/Ollama.app/Contents/MacOS/ollama' }]
])

/** La corsa viva coi cinque llama-server. */
const conLlama = (): Map<number, Riga> => new Map([
  ...processiVivi(),
  [DEL_DAEMON, { ppid: DAEMON, comando: NUDO }],
  [DEL_APP, { ppid: APP, comando: NUDO }],
  [CON_RADICE, { ppid: SONDA, comando: `llama-server -m ${RADICE}/data/modelli/finto.gguf` }],
  [FUORI, { ppid: SONDA, comando: NUDO }],
  [DELL_UTENTE, { ppid: OLLAMA, comando: '/Users/test/.ollama/llama-server --model /Users/test/.ollama/models/blobs/x' }]
])

/** La corsa SPENTA: app e daemon usciti, i loro figli orfani (sotto il pid 1), il resto al suo posto. */
const spenti = (vivono: Record<number, Riga>): Map<number, Riga> => new Map([
  ...processiVivi().entries().filter(([pid]) => pid !== APP && pid !== DAEMON),
  ...Object.entries(vivono).map(([pid, r]) => [Number(pid), r as Riga] as [number, Riga])
])

const pidi = (lista: { pid: number; perche: string; da: number | null }[]) => lista.map((l) => [l.pid, l.perche, l.da])

const TUTTI_I_LLAMA = [DEL_DAEMON, DEL_APP, CON_RADICE, FUORI, DELL_UTENTE]
const antenatiVivi = () => new Set([APP, DAEMON])

describe('I2: i llama-server DELLA CORSA — le due regole', () => {
  it('a corsa viva conta quelli che discendono dall\'app o dal daemon della sonda, e quello con la radice negli argomenti', () => {
    const lista = classificaLlamaServer({ processi: conLlama(), pidLlama: TUTTI_I_LLAMA, antenati: antenatiVivi(), radice: RADICE, home: null })
    expect(pidi(lista)).toEqual([[DEL_DAEMON, 'discendente', DAEMON], [DEL_APP, 'discendente', APP], [CON_RADICE, 'argomenti', null]])
  })

  it('NON conta quelli fuori dalla corsa: il runner dell\'Ollama dell\'utente e un llama-server avviato da chi non è la corsa', () => {
    const lista = classificaLlamaServer({ processi: conLlama(), pidLlama: TUTTI_I_LLAMA, antenati: antenatiVivi(), radice: RADICE, home: null })
    expect(lista.map((l) => l.pid)).not.toContain(FUORI)
    expect(lista.map((l) => l.pid)).not.toContain(DELL_UTENTE)
  })

  it('la catena si sale fino in fondo: un nipote del daemon è della corsa', () => {
    const NIPOTE = 125
    const lista = classificaLlamaServer({
      processi: new Map([...conLlama(), [NIPOTE, { ppid: DEL_DAEMON, comando: NUDO }]]),
      pidLlama: [NIPOTE], antenati: antenatiVivi(), radice: RADICE, home: null
    })
    expect(pidi(lista)).toEqual([[NIPOTE, 'discendente', DAEMON]])
  })

  it('la HOME finta negli argomenti basta, anche fuori dalla radice della corsa', () => {
    const HOME_FINTA = `${T}/casa-finta-della-sonda`
    const lista = classificaLlamaServer({
      processi: new Map([...processiVivi(), [FUORI, { ppid: SONDA, comando: `llama-server --home ${HOME_FINTA}` }]]),
      pidLlama: [FUORI], antenati: antenatiVivi(), radice: RADICE, home: HOME_FINTA
    })
    expect(pidi(lista)).toEqual([[FUORI, 'argomenti', null]])
  })

  it('la radice della corsa in un argomento di un processo che NON è un llama-server non conta: si guardano solo i pid dati', () => {
    const lista = classificaLlamaServer({ processi: conLlama(), pidLlama: [DELL_UTENTE, FUORI], antenati: antenatiVivi(), radice: RADICE, home: null })
    expect(lista).toEqual([])
  })
})

describe('I2: dopo lo spegnimento — la catena non c\'è più, serve la fotografia', () => {
  it('senza fotografia l\'orfano del daemon si perde (resta solo quello con la radice negli argomenti)', () => {
    const lista = classificaLlamaServer({ processi: spenti({ [DEL_DAEMON]: { ppid: 1, comando: NUDO }, [CON_RADICE]: { ppid: 1, comando: conLlama().get(CON_RADICE)!.comando } }), pidLlama: [DEL_DAEMON, CON_RADICE], antenati: new Set(), radice: RADICE, home: null })
    expect(pidi(lista)).toEqual([[CON_RADICE, 'argomenti', null]])
  })

  it('con la fotografia fatta PRIMA lo ritrova: stesso pid e stessa riga di comando', () => {
    const prima = classificaLlamaServer({ processi: conLlama(), pidLlama: TUTTI_I_LLAMA, antenati: antenatiVivi(), radice: RADICE, home: null })
    const fotografia = fotografiaDi(prima)
    expect([...fotografia.keys()]).toEqual([DEL_DAEMON, DEL_APP])
    const lista = classificaLlamaServer({
      processi: spenti({ [DEL_DAEMON]: { ppid: 1, comando: NUDO }, [CON_RADICE]: { ppid: 1, comando: conLlama().get(CON_RADICE)!.comando } }),
      pidLlama: [DEL_DAEMON, CON_RADICE, FUORI], antenati: new Set(), radice: RADICE, home: null, fotografia
    })
    expect(pidi(lista)).toEqual([[DEL_DAEMON, 'discendente', DAEMON], [CON_RADICE, 'argomenti', null]])
  })

  it('un pid RIUSATO da un altro llama-server non è della corsa: la riga di comando è cambiata', () => {
    const fotografia = fotografiaDi(classificaLlamaServer({ processi: conLlama(), pidLlama: TUTTI_I_LLAMA, antenati: antenatiVivi(), radice: RADICE, home: null }))
    const lista = classificaLlamaServer({
      processi: spenti({ [DEL_DAEMON]: { ppid: OLLAMA, comando: 'llama-server --model /Users/test/.ollama/models/blobs/y' } }),
      pidLlama: [DEL_DAEMON], antenati: new Set(), radice: RADICE, home: null, fotografia
    })
    expect(lista).toEqual([])
  })

  it('un daemon rimasto vivo dopo la corsa si vede dalla catena viva, senza fotografia', () => {
    const lista = classificaLlamaServer({
      processi: new Map([...processiVivi(), [DEL_DAEMON, { ppid: DAEMON, comando: NUDO }]].filter(([pid]) => pid !== APP)),
      pidLlama: [DEL_DAEMON], antenati: new Set([DAEMON]), radice: RADICE, home: null
    })
    expect(pidi(lista)).toEqual([[DEL_DAEMON, 'discendente', DAEMON]])
  })
})

describe('I2: il messaggio del controllo', () => {
  it('vuoto quando non c\'è nessuno: il dettaglio di un controllo verde non dice nulla', () => {
    expect(messaggioLlamaServer([])).toBe('')
  })

  it('dice quanti, quali pid e perché sono della corsa', () => {
    const lista = classificaLlamaServer({ processi: conLlama(), pidLlama: TUTTI_I_LLAMA, antenati: antenatiVivi(), radice: RADICE, home: null })
    const testo = messaggioLlamaServer(lista)
    expect(testo).toContain('3 della corsa')
    expect(testo).toContain(`pid ${DEL_DAEMON}`)
    expect(testo).toContain(`pid ${DEL_APP}`)
    expect(testo).toContain(`pid ${CON_RADICE}`)
    expect(testo).toContain('argomenti')
    expect(testo).not.toContain(`pid ${FUORI}`)
    expect(testo).not.toContain(`pid ${DELL_UTENTE}`)
  })
})
