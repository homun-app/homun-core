// I1 (fase isolamento-locale): il servizio LOCALE FINTO — un Ollama che NON
// è quello dell'utente. Ascolta su 127.0.0.1 con porta 0 (la sceglie il
// sistema: mai una porta fissa, mai le porte dei servizi veri) e risponde alle
// due richieste che l'app fa a Ollama per scoprirlo ed elencarne i modelli:
//   GET  /api/tags  — un elenco FISSO di modelli (sempre lo stesso numero)
//   POST /api/show  — le capability di un modello dell'elenco (tools sì, vision no, nessun ragionamento)
// Tutto il resto è un 404 JSON e resta REGISTRATO: la galleria segna ROSSA
// una richiesta che non si aspettava (per esempio una completazione, che in
// una scena non deve mai partire).
// `richieste` tiene { n, metodo, url, modello, at } per i controlli di chi
// l'ha avviato. Nessuna rete fuori da 127.0.0.1.
//
// Come ci arriva l'app: l'indirizzo si INIETTA (SANDBOT_TEST_LOCAL_LLM_URLS,
// letto da src/main/agent/local-services-address.ts) al posto di quello noto
// di Ollama — solo in prova, e solo al momento della richiesta. Il registro
// dei servizi locali veri (src/main/local-services-registry.ts) resta vuoto:
// verso le porte vere non parte nulla.
import { createServer } from 'node:http'

/**
 * I modelli del servizio finto. FISSI: il loro numero è quello che la riga
 * «Ollama (locale)» dice nelle catture della galleria («Sul tuo Mac · 3
 * modelli»). I nomi dicono che sono di prova.
 */
export const MODELLI_OLLAMA_FINTO = Object.freeze([
  Object.freeze({ name: 'prova:piccolo', model: 'prova:piccolo', size: 2_000_000_000, digest: 'finto-piccolo-1b', details: Object.freeze({ family: 'prova', families: Object.freeze(['prova']), parameter_size: '1B', quantization_level: 'Q4_K_M' }) }),
  Object.freeze({ name: 'prova:medio', model: 'prova:medio', size: 5_000_000_000, digest: 'finto-medio-8b', details: Object.freeze({ family: 'prova', families: Object.freeze(['prova']), parameter_size: '8B', quantization_level: 'Q4_K_M' }) }),
  Object.freeze({ name: 'prova:grande', model: 'prova:grande', size: 40_000_000_000, digest: 'finto-grande-70b', details: Object.freeze({ family: 'prova', families: Object.freeze(['prova']), parameter_size: '70B', quantization_level: 'Q4_K_M' }) })
])

/** Il corpo di /api/show per un modello dell'elenco: capability FISSE. */
const mostraModello = (nome) => ({
  modelfile: `# Modulo di prova del servizio finto\nFROM ${nome}`,
  parameters: '',
  template: '{{ .Prompt }}',
  details: MODELLI_OLLAMA_FINTO.find((m) => m.name === nome)?.details ?? {},
  model_info: { 'general.architecture': 'prova' },
  capabilities: ['completion', 'tools']
})

/** Il servizio finto: avvia() sceglie la porta, richieste è il registro, chiudi() spegne. */
export const ollamaFinto = () => {
  let url = null
  const richieste = []
  const json = (res, codice, corpo) => {
    res.writeHead(codice, { 'content-type': 'application/json' })
    res.end(JSON.stringify(corpo))
  }
  const server = createServer((req, res) => {
    const percorso = (req.url ?? '/').split('?')[0]
    let modello = null
    req.on('error', () => { /* il client è andato via: la risposta non serve più */ })
    res.on('close', () => { /* come sopra */ })
    if (req.method === 'GET' && percorso === '/api/tags') {
      richieste.push({ n: richieste.length + 1, metodo: 'GET', url: percorso, modello, at: Date.now() })
      json(res, 200, { object: 'list', models: MODELLI_OLLAMA_FINTO })
      return
    }
    if (req.method === 'POST' && percorso === '/api/show') {
      let corpo = ''
      req.on('data', (c) => (corpo += c))
      req.on('end', () => {
        try { modello = JSON.parse(corpo)?.model ?? null } catch { /* non JSON: modello ignoto */ }
        modello = typeof modello === 'string' ? modello : null
        richieste.push({ n: richieste.length + 1, metodo: 'POST', url: percorso, modello, at: Date.now() })
        if (modello === null || !MODELLI_OLLAMA_FINTO.some((m) => m.name === modello)) {
          json(res, 404, { error: `model '${modello ?? ''}' not found` })
          return
        }
        json(res, 200, mostraModello(modello))
      })
      return
    }
    // tutto il resto: l'app in prova non deve chiederlo a un servizio locale
    req.resume()
    richieste.push({ n: richieste.length + 1, metodo: req.method ?? '?', url: percorso, modello, at: Date.now() })
    json(res, 404, { error: `il servizio finto non risponde a ${req.method ?? '?'} ${percorso}` })
  })
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* già chiuso */ } })
  return {
    richieste,
    /** L'indirizzo del servizio finto (null prima di avvia()): si inietta con SANDBOT_TEST_LOCAL_LLM_URLS. */
    get url() { return url },
    get porta() { return url === null ? null : Number(new URL(url).port) },
    avvia: async () => {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      url = `http://127.0.0.1:${server.address().port}`
      return url
    },
    chiudi: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  }
}
