// I1 (fase isolamento-locale): LA CORREZIONE. L'indirizzo dei servizi LLM
// locali (Ollama e LM Studio) si inietta dal motore di sonde e galleria, non
// si scrive fisso. Tre stati, qui provati sulla rete finta (fetch sostituito):
//   · APP VERA: non cambia niente — si chiama l'indirizzo noto, sempre, anche
//     se nell'env c'è la variabile dell'iniezione senza quella della prova;
//   · IN PROVA senza servizio: verso l'indirizzo noto non parte NESSUNA richiesta;
//   · IN PROVA col servizio FINTO: si chiama l'indirizzo iniettato, e il
//     provider salvato resta con l'indirizzo noto (il record è quello dell'app vera).
// Un indirizzo SCELTO (un'altra porta: il provider finto di una sonda) non si
// tocca in nessuno dei tre. Le quattro strade del main sono provate una per
// una: scoperta, elenco vivo, capability (/api/show) e adattatore. Le porte
// vere non si scrivono: si leggono da KNOWN_BASE_URLS, e qui non si chiamano.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_TMP_BASE } from '../../test-tmp'
import { setDataDir, setSetting } from '../store/db'
import { KNOWN_BASE_URLS, readOllamaCapabilities, resetOllamaCapabilities, setRisolutoreServizioLocale } from '../agent/live-models'
import { discoverProviders, listProviderModels, probeProvider, storedProviders, testProvider } from '../agent/providers'
import { piCacheEntryFor } from '../agent/llm-pi'
import type { ProviderConfig } from '../../shared/types'
import {
  ENV_INDIRIZZI_LOCALI_IN_PROVA, ENV_PROVA, INDIRIZZO_ASSENTE_IN_PROVA,
  baseLocaleInProva, eIndirizzoNoto, indirizziLocaliInProva, indirizziLocaliInProvaDaEnv,
  indirizzoIniettatoDaTesto, installaIndirizziLocaliInProva
} from '../agent/local-services-address'

const OLLAMA = KNOWN_BASE_URLS.ollama!
const LMSTUDIO = KNOWN_BASE_URLS.lmstudio!
// i servizi FINTI del motore: origini di questa macchina, porte scelte dal sistema
const FINTO_OLLAMA = 'http://127.0.0.1:43111'
const FINTO_LMSTUDIO = 'http://127.0.0.1:43112'
const INIEZIONE = `ollama=${FINTO_OLLAMA},lmstudio=${FINTO_LMSTUDIO}`
// un indirizzo SCELTO: un Ollama finto di una sonda su un'altra porta
const ALTRO_OLLAMA = 'http://127.0.0.1:43199'

const risposta = (corpo: unknown): Response => new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } })

/** Il fetch finto: un Ollama (GET /api/tags con un modello, POST /api/show), un LM Studio (GET /v1/models); il resto è 404. */
const fetchFinto = (): Mock<(input: unknown) => Promise<Response>> => {
  const f = vi.fn()
  f.mockImplementation(async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) return risposta({ models: [{ name: 'finto:1b', digest: 'd1', details: { parameter_size: '1B' } }] })
    if (url.endsWith('/api/show')) return risposta({ capabilities: ['tools'] })
    if (url.endsWith('/v1/models')) return risposta({ data: [{ id: 'finto-lm' }] })
    return new Response('{}', { status: 404 })
  })
  return f as unknown as Mock<(input: unknown) => Promise<Response>>
}
const chiamate = (f: Mock<(input: unknown) => Promise<Response>>): string[] => f.mock.calls.map((c) => String(c[0]))

const provider = (id: string, kind: ProviderConfig['kind'], baseUrl: string): ProviderConfig => ({ id, name: id, kind, baseUrl, apiKey: '', enabled: true })

const APP_VERA = {}
const PROVA_SENZA = { [ENV_PROVA]: '/dati/della/prova' }
const PROVA_CON = { [ENV_PROVA]: '/dati/della/prova', [ENV_INDIRIZZI_LOCALI_IN_PROVA]: INIEZIONE }

describe('I1: l\'indirizzo dei servizi locali si inietta — le regole pure', () => {
  it('una voce dell\'iniezione è un\'origine http(s) di QUESTA macchina, con la porta e senza percorso', () => {
    expect(indirizzoIniettatoDaTesto(FINTO_OLLAMA)).toBe(FINTO_OLLAMA)
    expect(indirizzoIniettatoDaTesto('  http://localhost:43111/ ')).toBe('http://localhost:43111')
    expect(indirizzoIniettatoDaTesto('http://[::1]:43111')).toBe('http://[::1]:43111')
    expect(indirizzoIniettatoDaTesto('https://127.0.0.2:43111')).toBe('https://127.0.0.2:43111')
  })

  it('non si inietta: un servizio VERO (le sue porte), un altro computer, un percorso, senza porta, roba illeggibile', () => {
    // l'indirizzo di un servizio vero si vorrebbe sostituire con sé stesso
    expect(indirizzoIniettatoDaTesto(OLLAMA)).toBeNull()
    expect(indirizzoIniettatoDaTesto(LMSTUDIO)).toBeNull()
    expect(indirizzoIniettatoDaTesto(`http://127.0.0.1:${new URL(OLLAMA).port}`)).toBeNull()
    expect(indirizzoIniettatoDaTesto('http://192.168.1.4:43111')).toBeNull()
    expect(indirizzoIniettatoDaTesto('https://esempio.it:43111')).toBeNull()
    expect(indirizzoIniettatoDaTesto(`${FINTO_OLLAMA}/ollama`)).toBeNull()
    expect(indirizzoIniettatoDaTesto(`${FINTO_OLLAMA}?x=1`)).toBeNull()
    expect(indirizzoIniettatoDaTesto('http://127.0.0.1')).toBeNull()
    expect(indirizzoIniettatoDaTesto('http://127.0.0.1:0')).toBeNull()
    expect(indirizzoIniettatoDaTesto('ftp://127.0.0.1:43111')).toBeNull()
    expect(indirizzoIniettatoDaTesto('non è un url')).toBeNull()
    expect(indirizzoIniettatoDaTesto('')).toBeNull()
    expect(indirizzoIniettatoDaTesto(undefined)).toBeNull()
  })

  it('la tabella dall\'env: null nell\'app vera; in prova una voce che manca o non è valida vale «assente»', () => {
    expect(indirizziLocaliInProvaDaEnv({})).toBeNull()
    // la variabile dell'iniezione DA SOLA non è una prova: l'app vera non cambia
    expect(indirizziLocaliInProvaDaEnv({ [ENV_INDIRIZZI_LOCALI_IN_PROVA]: INIEZIONE })).toBeNull()
    expect(indirizziLocaliInProvaDaEnv(PROVA_SENZA)).toEqual({ ollama: null, lmstudio: null })
    expect(indirizziLocaliInProvaDaEnv(PROVA_CON)).toEqual({ ollama: FINTO_OLLAMA, lmstudio: FINTO_LMSTUDIO })
    expect(indirizziLocaliInProvaDaEnv({ ...PROVA_SENZA, [ENV_INDIRIZZI_LOCALI_IN_PROVA]: `ollama=${OLLAMA},lmstudio=${FINTO_LMSTUDIO},openai=https://api.openai.com` }))
      .toEqual({ ollama: null, lmstudio: FINTO_LMSTUDIO })
    expect(indirizziLocaliInProvaDaEnv({ ...PROVA_SENZA, [ENV_INDIRIZZI_LOCALI_IN_PROVA]: 'ollama' })).toEqual({ ollama: null, lmstudio: null })
  })

  it('l\'indirizzo NOTO di un kind è la porta vera di QUEL servizio su questa macchina, sola', () => {
    expect(eIndirizzoNoto('ollama', OLLAMA)).toBe(true)
    expect(eIndirizzoNoto('ollama', `http://127.0.0.1:${new URL(OLLAMA).port}/`)).toBe(true)
    expect(eIndirizzoNoto('lmstudio', LMSTUDIO)).toBe(true)
    // la porta dell'altro servizio non è il suo indirizzo noto
    expect(eIndirizzoNoto('ollama', LMSTUDIO)).toBe(false)
    // un'altra porta, un altro computer, un percorso: scelte
    expect(eIndirizzoNoto('ollama', FINTO_OLLAMA)).toBe(false)
    expect(eIndirizzoNoto('ollama', `http://192.168.1.4:${new URL(OLLAMA).port}`)).toBe(false)
    expect(eIndirizzoNoto('ollama', `${OLLAMA}/ollama`)).toBe(false)
    expect(eIndirizzoNoto('ollama', 'localhost')).toBe(false)
  })

  it('baseLocaleInProva: app vera → l\'indirizzo letto, sempre; in prova il noto diventa l\'iniettato o null; il resto non si tocca', () => {
    const assente = { ollama: null, lmstudio: null }
    const iniettato = { ollama: FINTO_OLLAMA, lmstudio: null }
    // app vera
    expect(baseLocaleInProva('ollama', OLLAMA, null)).toBe(OLLAMA)
    expect(baseLocaleInProva('ollama', ALTRO_OLLAMA, null)).toBe(ALTRO_OLLAMA)
    // in prova
    expect(baseLocaleInProva('ollama', OLLAMA, iniettato)).toBe(FINTO_OLLAMA)
    expect(baseLocaleInProva('ollama', OLLAMA, assente)).toBeNull()
    expect(baseLocaleInProva('lmstudio', LMSTUDIO, iniettato)).toBeNull()
    // un indirizzo scelto resta suo in tutti gli stati
    expect(baseLocaleInProva('ollama', ALTRO_OLLAMA, iniettato)).toBe(ALTRO_OLLAMA)
    expect(baseLocaleInProva('ollama', ALTRO_OLLAMA, assente)).toBe(ALTRO_OLLAMA)
    // gli altri kind non sono servizi del Mac: nemmeno quando il loro indirizzo è quello
    expect(baseLocaleInProva('openai-compatible', OLLAMA, assente)).toBe(OLLAMA)
    expect(baseLocaleInProva('homun-local', OLLAMA, iniettato)).toBe(OLLAMA)
  })
})

describe('I1: l\'indirizzo dei servizi locali si inietta — sul main, con la rete finta', () => {
  let dir: string
  let f: Mock<(input: unknown) => Promise<Response>>
  beforeAll(() => {
    dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-i1-indirizzi-'))
    setDataDir(dir)
  })
  beforeEach(() => {
    setSetting('providers', [])
    resetOllamaCapabilities()
    f = fetchFinto()
    vi.stubGlobal('fetch', f)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setRisolutoreServizioLocale(null)
    installaIndirizziLocaliInProva({})
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('la scoperta (discoverProviders)', () => {
    it('nell\'app vera non cambia niente: prova i due indirizzi noti e li salva com\'erano', async () => {
      // anche con la variabile dell'iniezione nell'env: senza quella della prova non è una prova
      expect(installaIndirizziLocaliInProva({ [ENV_INDIRIZZI_LOCALI_IN_PROVA]: INIEZIONE })).toBeNull()
      expect(indirizziLocaliInProva()).toBeNull()
      const trovati = await discoverProviders()
      expect(chiamate(f).sort()).toEqual([`${OLLAMA}/api/tags`, `${LMSTUDIO}/v1/models`].sort())
      expect(trovati.map((p) => [p.id, p.baseUrl]).sort()).toEqual([['lmstudio', LMSTUDIO], ['ollama', OLLAMA]].sort())
    })

    it('in prova SENZA servizio non prova nessun indirizzo locale: nessuna richiesta, nessun provider nuovo', async () => {
      setSetting('providers', [provider('mio', 'openai-compatible', ALTRO_OLLAMA)])
      expect(installaIndirizziLocaliInProva(PROVA_SENZA)).toEqual({ ollama: null, lmstudio: null })
      const trovati = await discoverProviders()
      expect(f).not.toHaveBeenCalled()
      expect(trovati.map((p) => p.id)).toEqual(['mio'])
    })

    it('in prova COL servizio finto prova gli indirizzi iniettati — mai quelli veri — e salva il provider con l\'indirizzo noto', async () => {
      installaIndirizziLocaliInProva(PROVA_CON)
      const trovati = await discoverProviders()
      expect(chiamate(f).sort()).toEqual([`${FINTO_OLLAMA}/api/tags`, `${FINTO_LMSTUDIO}/v1/models`].sort())
      for (const url of chiamate(f)) expect(url).not.toContain(new URL(OLLAMA).port)
      expect(storedProviders().map((p) => [p.id, p.baseUrl]).sort()).toEqual([['lmstudio', LMSTUDIO], ['ollama', OLLAMA]].sort())
      expect(trovati.find((p) => p.id === 'ollama')?.discovered).toBe(true)
    })

    it('in prova COL servizio finto che non risponde il provider non compare (com\'è per un servizio spento)', async () => {
      f.mockImplementation(async () => new Response('{}', { status: 503 }))
      installaIndirizziLocaliInProva(PROVA_CON)
      expect(await discoverProviders()).toEqual([])
      expect(chiamate(f).sort()).toEqual([`${FINTO_OLLAMA}/api/tags`, `${FINTO_LMSTUDIO}/v1/models`].sort())
    })
  })

  describe('l\'elenco vivo (listProviderModels)', () => {
    it('Ollama: app vera → /api/tags e /api/show sull\'indirizzo noto', async () => {
      installaIndirizziLocaliInProva(APP_VERA)
      const modelli = await listProviderModels(provider('p-vera', 'ollama', OLLAMA))
      expect(modelli.map((m) => m.id)).toEqual(['finto:1b'])
      expect(chiamate(f)).toEqual([`${OLLAMA}/api/tags`, `${OLLAMA}/api/show`])
    })

    it('Ollama: in prova SENZA servizio la richiesta non parte — la prova del provider dice «irraggiungibile»', async () => {
      installaIndirizziLocaliInProva(PROVA_SENZA)
      await expect(listProviderModels(provider('p-assente', 'ollama', OLLAMA))).rejects.toThrow(/fetch failed/)
      expect(f).not.toHaveBeenCalled()
      expect(await testProvider(provider('p-assente-2', 'ollama', OLLAMA))).toMatchObject({ ok: false })
      expect(await probeProvider({ kind: 'ollama', baseUrl: OLLAMA })).toEqual({ ok: false, error: 'unreachable' })
      expect(f).not.toHaveBeenCalled()
    })

    it('Ollama: in prova COL servizio finto l\'elenco viene dall\'indirizzo iniettato', async () => {
      installaIndirizziLocaliInProva(PROVA_CON)
      const modelli = await listProviderModels(provider('p-finto', 'ollama', OLLAMA))
      expect(modelli.map((m) => [m.id, m.tools])).toEqual([['finto:1b', true]])
      expect(chiamate(f)).toEqual([`${FINTO_OLLAMA}/api/tags`, `${FINTO_OLLAMA}/api/show`])
    })

    it('LM Studio: app vera → l\'indirizzo noto; in prova assente → nulla; col finto → l\'iniettato', async () => {
      installaIndirizziLocaliInProva(APP_VERA)
      expect((await listProviderModels(provider('lm-vera', 'lmstudio', LMSTUDIO))).map((m) => m.id)).toEqual(['finto-lm'])
      expect(chiamate(f)).toEqual([`${LMSTUDIO}/v1/models`])
      f.mockClear()
      installaIndirizziLocaliInProva(PROVA_SENZA)
      await expect(listProviderModels(provider('lm-assente', 'lmstudio', LMSTUDIO))).rejects.toThrow(/fetch failed/)
      expect(f).not.toHaveBeenCalled()
      installaIndirizziLocaliInProva(PROVA_CON)
      expect((await listProviderModels(provider('lm-finto', 'lmstudio', LMSTUDIO))).map((m) => m.id)).toEqual(['finto-lm'])
      expect(chiamate(f)).toEqual([`${FINTO_LMSTUDIO}/v1/models`])
    })

    it('un Ollama SU UN ALTRO INDIRIZZO (il finto di una sonda) si chiama com\'è in tutti e tre gli stati', async () => {
      for (const env of [APP_VERA, PROVA_SENZA, PROVA_CON]) {
        f.mockClear()
        installaIndirizziLocaliInProva(env)
        await listProviderModels(provider(`p-altro-${Object.keys(env).length}-${chiamate(f).length}`, 'ollama', ALTRO_OLLAMA))
        expect(chiamate(f)).toEqual([`${ALTRO_OLLAMA}/api/tags`, `${ALTRO_OLLAMA}/api/show`])
      }
    })
  })

  describe('le capability (/api/show: readOllamaCapabilities)', () => {
    it('app vera → l\'indirizzo noto; in prova assente → nessuna richiesta, capability sconosciute; col finto → l\'iniettato', async () => {
      installaIndirizziLocaliInProva(APP_VERA)
      expect(await readOllamaCapabilities(provider('cap-vera', 'ollama', OLLAMA), 'finto:1b')).toMatchObject({ caps: ['tools'], thinking: null })
      expect(chiamate(f)).toEqual([`${OLLAMA}/api/show`])
      f.mockClear()
      installaIndirizziLocaliInProva(PROVA_SENZA)
      expect(await readOllamaCapabilities(provider('cap-assente', 'ollama', OLLAMA), 'finto:1b')).toMatchObject({ caps: null, thinking: null })
      expect(f).not.toHaveBeenCalled()
      installaIndirizziLocaliInProva(PROVA_CON)
      expect(await readOllamaCapabilities(provider('cap-finto', 'ollama', OLLAMA), 'finto:1b')).toMatchObject({ caps: ['tools'] })
      expect(chiamate(f)).toEqual([`${FINTO_OLLAMA}/api/show`])
    })
  })

  describe('l\'adattatore (il base URL con cui parla il turno)', () => {
    it('app vera → l\'indirizzo noto con la regola /v1; in prova col finto → l\'iniettato; assente → un indirizzo dove non ascolta nessuno', () => {
      installaIndirizziLocaliInProva(APP_VERA)
      expect(piCacheEntryFor(provider('ad-vera', 'ollama', OLLAMA)).baseUrl).toBe(`${OLLAMA}/v1`)
      expect(piCacheEntryFor(provider('ad-vera-lm', 'lmstudio', LMSTUDIO)).baseUrl).toBe(`${LMSTUDIO}/v1`)
      installaIndirizziLocaliInProva(PROVA_CON)
      expect(piCacheEntryFor(provider('ad-finto', 'ollama', OLLAMA)).baseUrl).toBe(`${FINTO_OLLAMA}/v1`)
      expect(piCacheEntryFor(provider('ad-finto-lm', 'lmstudio', LMSTUDIO)).baseUrl).toBe(`${FINTO_LMSTUDIO}/v1`)
      installaIndirizziLocaliInProva(PROVA_SENZA)
      const assente = piCacheEntryFor(provider('ad-assente', 'ollama', OLLAMA)).baseUrl
      expect(assente).toBe(`${INDIRIZZO_ASSENTE_IN_PROVA}/v1`)
      // non è nessuno dei due servizi veri
      expect(assente).not.toContain(new URL(OLLAMA).port)
      expect(assente).not.toContain(new URL(LMSTUDIO).port)
    })

    it('un indirizzo scelto e gli altri kind restano loro in tutti gli stati', () => {
      for (const env of [APP_VERA, PROVA_SENZA, PROVA_CON]) {
        installaIndirizziLocaliInProva(env)
        expect(piCacheEntryFor(provider(`ad-altro-${Object.keys(env).length}`, 'ollama', ALTRO_OLLAMA)).baseUrl).toBe(`${ALTRO_OLLAMA}/v1`)
        expect(piCacheEntryFor(provider(`ad-compat-${Object.keys(env).length}`, 'openai-compatible', OLLAMA)).baseUrl).toBe(`${OLLAMA}/v1`)
      }
    })
  })

  it('i due punti d\'ingresso del main installano la regola dall\'env (guardia sul sorgente)', () => {
    const main = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    expect(main).toMatch(/^installaIndirizziLocaliInProva\(process\.env\)$/m)
    expect(main.indexOf('installaIndirizziLocaliInProva(process.env)')).toBeLessThan(main.indexOf("app.setPath('userData'"))
    const daemon = readFileSync(fileURLToPath(new URL('../../daemon/index.ts', import.meta.url)), 'utf8')
    expect(daemon).toMatch(/^installaIndirizziLocaliInProva\(process\.env\)$/m)
  })

  it('la regola sta in UN posto: in providers.ts e live-models.ts ogni funzione che fa una richiesta ha prima passato l\'indirizzo da baseServizioLocale', () => {
    const agent = fileURLToPath(new URL('../agent/', import.meta.url)) + '/'
    const sorgenti: Array<[string, string]> = [
      ['providers.ts', readFileSync(`${agent}providers.ts`, 'utf8')],
      ['live-models.ts', readFileSync(`${agent}live-models.ts`, 'utf8')]
    ]
    let funzioniConRichieste = 0
    const eRigaDiRichiesta = (r: string): boolean => /\bfetch\(/.test(r) && !/^\s*(\/\/|\*)/.test(r)
    for (const [nome, testo] of sorgenti) {
      // ogni funzione di primo livello, col suo corpo fino alla prima richiesta
      let corpo: string[] = []
      const chiudi = (): void => {
        if (corpo.length === 0) return
        const prima = corpo.findIndex(eRigaDiRichiesta)
        if (prima >= 0) {
          funzioniConRichieste++
          expect(corpo.slice(0, prima + 1).join('\n'), nome).toContain('baseServizioLocale(')
        }
        corpo = []
      }
      for (const riga of testo.split('\n')) {
        if (/^(?:export )?(?:async )?function /.test(riga)) chiudi()
        corpo.push(riga)
      }
      chiudi()
    }
    // scoperta, elenco vivo, capability: tre funzioni, tutte con la regola
    expect(funzioniConRichieste).toBe(3)
  })
})
