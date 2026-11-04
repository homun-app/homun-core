// Fase catalogo app (P1): la prova dello script del catalogo, SENZA RETE VERA.
// Un server HTTP finto su 127.0.0.1 serve tre pagine di toolkit (voci non
// collegabili, un toolkit locale, una pagina in camelCase come l'SDK, un logo
// SVG con dentro <script>/onload/foreignObject/href esterni, un logo PNG troppo
// grande, un logo 404, un logo dal content-type sconosciuto) e lo script gira
// come processo figlio con --base-url e una cartella d'uscita temporanea.
// Si controlla: il filtro, la paginazione, l'ordine d'uso, la pulizia dell'SVG,
// il logo: null, il determinismo (due lanci → stessi byte), le differenze
// (nuove/sparite, --prune), le categorie non mappate elencate, il messaggio
// senza la chiave quando manca o quando l'API risponde male — e che la chiave
// non compaia MAI nei file scritti né nello stdout/stderr.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const KEY = 'ak_chiave-segreta-della-prova-7f3d'
const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'aggiorna-catalogo-composio.mjs')

// ---- il server finto: le tre pagine, i loghi, l'errore ----

let base = ''
let server: Server
const toolkitsRequests: Array<{ cursor: string; auth?: string }> = []

const svgSporco = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">' +
  '<script>alert(2)</script><foreignObject><body>fuori</body></foreignObject>' +
  '<a href="https://evil.example/porta/via">esterno</a>' +
  '<a href="#dentro">interno</a><rect href="https://evil.example/rect"/>' +
  '<circle cx="5" cy="5" r="4"/></svg>'
)
const pngGrosso = Buffer.alloc(250 * 1024, 7)

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code: number, body: unknown) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

    // il logo SVG con dentro di tutto
    if (url.pathname === '/logo/gmail.svg') {
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svgSporco)
    }
    // il logo PNG troppo grande (250 KB > 200 KB)
    if (url.pathname === '/logo/notion.png') {
      return res.writeHead(200, { 'content-type': 'image/png' }).end(pngGrosso)
    }
    // il logo che non c'è
    if (url.pathname === '/logo/github.svg') return res.writeHead(404).end('non c\'è')
    // il logo dal content-type che non accettiamo
    if (url.pathname === '/logo/bad.txt') {
      return res.writeHead(200, { 'content-type': 'text/plain' }).end('non sono un logo')
    }

    // la base «sbagliata»: 401 col corpo che contiene la chiave (non deve tornare fuori)
    if (url.pathname.startsWith('/failbase/')) {
      return json(401, { detail: `invalid api key ${KEY}` })
    }

    if (url.pathname === '/api/v3/toolkits') {
      toolkitsRequests.push({ cursor: url.searchParams.get('cursor') ?? '', auth: req.headers['x-api-key'] as string | undefined })
      if (url.searchParams.get('sort_by') !== 'usage') return json(400, { error: 'sort_by richiesto' })
      const cursor = url.searchParams.get('cursor') ?? ''
      if (cursor === '') {
        return json(200, {
          items: [
            // non collegabile: auth propria, no_auth falso
            { slug: 'own_auth', name: 'Own Auth', meta: { description: 'no' }, composio_managed_auth_schemes: [], no_auth: false },
            { slug: 'gmail', name: 'Gmail', meta: { description: 'Posta', categories: [{ slug: 'communication', name: 'Communication' }], logo: `${base}/logo/gmail.svg`, tools_count: 12 }, composio_managed_auth_schemes: ['oauth2'] },
            { slug: 'slack', name: 'Slack', meta: { description: 'Chat', categories: [{ slug: 'communication', name: 'Communication' }] }, composio_managed_auth_schemes: ['oauth2'] }
          ],
          next_cursor: 'p2'
        })
      }
      if (cursor === 'p2') {
        // pagina in CAMELCASE, come la mostra l'SDK @composio/core
        return json(200, {
          items: [
            { slug: 'local_tool', name: 'Local Tool', isLocalToolkit: true, composioManagedAuthSchemes: ['oauth2'] },
            { slug: 'notion', name: 'Notion', meta: { description: 'Pagine', categories: [{ slug: 'productivity', name: 'Productivity' }], logo: `${base}/logo/notion.png`, toolsCount: 9 }, composioManagedAuthSchemes: ['oauth2'] },
            { slug: 'github', name: 'GitHub', meta: { description: 'Codice', logo: `${base}/logo/github.svg` }, composioManagedAuthSchemes: ['oauth2'] }
          ],
          nextCursor: 'p3'
        })
      }
      if (cursor === 'p3') {
        return json(200, {
          items: [
            { slug: 'linear', name: 'Linear', meta: { description: 'Issue', categories: [{ slug: 'travel', name: 'Travel' }] }, no_auth: true },
            { slug: 'badtype', name: 'Bad Type', meta: { description: 'Logo strano', logo: `${base}/logo/bad.txt` }, composio_managed_auth_schemes: ['oauth2'] }
          ],
          next_cursor: null
        })
      }
      return json(400, { error: 'cursore sconosciuto' })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

/**
 * Lancia lo script come processo figlio contro il server finto. SPAWN
 * asincrono, mai spawnSync: il server finto sta in QUESTO processo e
 * spawnSync ne blocca l'event loop — la fetch del figlio non riceverebbe
 * mai risposta (deadlock).
 */
const run = (args: string[], key: string | null = KEY): Promise<{ status: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...(key === null ? {} : { COMPOSIO_CATALOG_KEY: key }),
        HOME: process.env.HOME ?? '/tmp',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('lo script non è uscito entro 60 s'))
    }, 60_000)
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })

/** Tutti i file (ricorsivo) di una cartella, con i contenuti, per cercare la chiave. */
const filesOf = (dir: string): Array<{ path: string; content: Buffer }> => {
  const out: Array<{ path: string; content: Buffer }> = []
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push({ path: p, content: readFileSync(p) })
    }
  }
  walk(dir)
  return out
}

const tmp = () => mkdtempSync(join(tmpdir(), 'sandbot-catalogo-'))

describe('P1 — aggiorna-catalogo-composio (server finto su 127.0.0.1)', async () => {
  it('senza COMPOSIO_CATALOG_KEY esce subito con un messaggio chiaro, senza chiamare l\'API', async () => {
    const requestsBefore = toolkitsRequests.length
    // --out anche qui: se lo script un domani scrivesse comunque, mai nel repo
    const r = await run(['--base-url', base, '--limit', '4', '--out', tmp()], null)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('COMPOSIO_CATALOG_KEY')
    expect(toolkitsRequests.length).toBe(requestsBefore)
  })

  it('l\'errore HTTP dice lo stato ma NON la chiave (il corpo la contiene)', async () => {
    const r = await run(['--base-url', `${base}/failbase`, '--limit', '4', '--out', tmp()])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('401')
    expect(r.stderr).not.toContain(KEY)
  })

  it('filtra, pagina e ordina: solo le collegabili, in ordine d\'uso, con il limite', async () => {
    const out = tmp()
    const r = await run(['--base-url', base, '--limit', '4', '--out', out])
    expect(r.status).toBe(0)
    // con limite 4 la terza pagina NON si chiede
    const cursors = toolkitsRequests.slice(-2).map((q) => q.cursor)
    expect(cursors).toEqual(['', 'p2'])
    // l'intestazione x-api-key va all'API (mai ai loghi: quelli sono un'altra via)
    expect(toolkitsRequests.at(-1)?.auth).toBe(KEY)
    const rows = JSON.parse(readFileSync(join(out, 'composio-catalog.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(rows.map((x) => x.slug)).toEqual(['gmail', 'slack', 'notion', 'github'])
    expect(rows[0]).toMatchObject({ slug: 'gmail', name: 'Gmail', description: 'Posta', categories: ['communication'], toolsCount: 12, auth: 'managed' })
    expect(rows[2]).toMatchObject({ slug: 'notion', toolsCount: 9 }) // camelCase accettato
    expect(rows.map((x) => x.logo)).toEqual(['gmail.svg', null, null, null])
  })

  it('la chiave non compare in NESSUN file scritto né nello stdout', async () => {
    const out = tmp()
    const r = await run(['--base-url', base, '--limit', '4', '--out', out])
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain(KEY)
    for (const f of filesOf(out)) {
      expect(f.content.includes(KEY)).toBe(false)
    }
  })

  it('l\'SVG si ripulisce: niente <script>, on*, <foreignObject> né href esterni (i riferimenti interni restano)', async () => {
    const out = tmp()
    await run(['--base-url', base, '--limit', '4', '--out', out])
    const svg = readFileSync(join(out, 'app-logos', 'gmail.svg'), 'utf8')
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('onload')
    expect(svg).not.toContain('foreignObject')
    expect(svg).not.toContain('evil.example')
    // l'href esterno si toglie come ATTRIBUTO (l'ancora resta, senza destinazione)
    expect(svg).not.toContain('href="https')
    expect(svg).toContain('#dentro')
    expect(svg).toContain('<circle')
  })

  it('deterministico: due lanci con lo stesso input producono gli stessi byte (e il secondo non riscrive)', async () => {
    const a = tmp()
    const b = tmp()
    await run(['--base-url', base, '--limit', '4', '--out', a])
    await run(['--base-url', base, '--limit', '4', '--out', b])
    expect(readFileSync(join(a, 'composio-catalog.json'))).toEqual(readFileSync(join(b, 'composio-catalog.json')))
    expect(readFileSync(join(a, 'app-logos', 'gmail.svg'))).toEqual(readFileSync(join(b, 'app-logos', 'gmail.svg')))
    // di nuovo nella STESSA cartella: il file resta identico e le differenze sono vuote
    const before = readFileSync(join(a, 'composio-catalog.json'), 'utf8')
    const r = await run(['--base-url', base, '--limit', '4', '--out', a])
    expect(r.status).toBe(0)
    expect(readFileSync(join(a, 'composio-catalog.json'), 'utf8')).toBe(before)
    expect(r.stdout).not.toContain('app nuove')
    expect(r.stdout).not.toContain('sparite')
  })

  it('le app sparite restano nel file (senza --prune) e si tolgono solo con --prune', async () => {
    const out = tmp()
    await run(['--base-url', base, '--limit', '4', '--out', out])
    // ora il limite scende a 2: notion e github risultano «sparite»
    const senza = await run(['--base-url', base, '--limit', '2', '--out', out])
    expect(senza.status).toBe(0)
    expect(senza.stdout).toContain('sparite')
    expect(senza.stdout).toContain('notion, github')
    expect(senza.stdout).toContain('solo con --prune')
    let rows = JSON.parse(readFileSync(join(out, 'composio-catalog.json'), 'utf8')) as Array<{ slug: string }>
    expect(rows.map((x) => x.slug)).toEqual(['gmail', 'slack', 'notion', 'github'])
    // con --prune le sparite se ne vanno
    const con = await run(['--base-url', base, '--limit', '2', '--prune', '--out', out])
    expect(con.status).toBe(0)
    rows = JSON.parse(readFileSync(join(out, 'composio-catalog.json'), 'utf8')) as Array<{ slug: string }>
    expect(rows.map((x) => x.slug)).toEqual(['gmail', 'slack'])
  })

  it('no_auth vale «none», le categorie non mappate si elencano, il logo dal tipo sbagliato resta null', async () => {
    const out = tmp()
    const r = await run(['--base-url', base, '--limit', '10', '--out', out])
    expect(r.status).toBe(0)
    const rows = JSON.parse(readFileSync(join(out, 'composio-catalog.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(rows.map((x) => x.slug)).toEqual(['gmail', 'slack', 'notion', 'github', 'linear', 'badtype'])
    expect(rows.find((x) => x.slug === 'linear')).toMatchObject({ auth: 'none', categories: ['travel'] })
    expect(rows.find((x) => x.slug === 'badtype')?.logo).toBeNull()
    // 'travel' non è in curation.json → elencata come non mappata (finisce in «Altro»)
    expect(r.stdout).toContain('non mappate')
    expect(r.stdout).toContain('travel')
  })

  it('--dry-run non scrive nulla ma stampa le differenze', async () => {
    const out = tmp()
    const r = await run(['--base-url', base, '--limit', '4', '--dry-run', '--out', out])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('dry-run')
    expect(existsSync(join(out, 'composio-catalog.json'))).toBe(false)
    expect(existsSync(join(out, 'app-logos'))).toBe(false)
    expect(filesOf(out)).toEqual([])
  })
})
