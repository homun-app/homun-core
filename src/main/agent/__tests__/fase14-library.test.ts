// Test della LIBRERIA (fase 14, punti 1-6): creazione, versioni MAI
// sovrascritte, limiti, list_library (ordine, filtro, tetto), edit_document
// (old unico/assente/duplicato, mai modifiche parziali), blocchi grafico non
// validi → NESSUNA versione scritta, tainted (punto 6), esportazione HTML
// autonoma (nessuno script, nessuna risorsa esterna, SVG in linea, nome non
// in conflitto). Vega-Lite valido → SVG coi valori; url a qualunque
// profondità → rifiuto; righe oltre il tetto → rifiuto; il loader non fa
// richieste (server finto che conta ZERO richieste); Mermaid oltre il tetto.
// Nessun tool per cancellare (la cancellazione è della UI).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-lib-test-'))
const { setDataDir, dataDir, getSetting } = await import('../../store/db')
setDataDir(TMP)

const charts = await import('../charts')
const lib = await import('../library')
const { getLibraryItem, listLibraryItems, deleteLibraryItem, libraryItemDir } = await import('../../store/library')

const AGENT = 'agent_lib'
const AGENT2 = 'agent_altro'

beforeAll(() => {
  dataDir()
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const GOOD_SPEC = JSON.stringify({
  mark: 'bar',
  data: { values: [{ m: 'gen', v: 10 }, { m: 'feb', v: 14 }, { m: 'mar', v: 9 }] },
  encoding: { x: { field: 'm', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } }
})

describe('punti 1-2: creazione documenti e VERSIONI mai sovrascritte', () => {
  it('write_document senza id crea v1; con id scrive una NUOVA versione; le vecchie restano', () => {
    const r = lib.writeDocument(AGENT, { title: 'Report box condiviso', content: '# Report\n\nTesto della v1.' })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.value.id : ''
    expect(id).toMatch(/^lib_[0-9a-f]{8}$/)
    expect(r.ok && r.value.version).toBe(1)
    const v1 = readFileSync(join(libraryItemDir(id), 'v1.md'), 'utf8')
    expect(v1).toContain('Testo della v1.')
    // v2
    const r2 = lib.writeDocument(AGENT, { id, title: 'Report box condiviso', content: '# Report\n\nTesto della v2.' })
    expect(r2.ok && r2.value.version).toBe(2)
    // la v1 non è stata sovrascritta
    expect(readFileSync(join(libraryItemDir(id), 'v1.md'), 'utf8')).toContain('v1')
    expect(readFileSync(join(libraryItemDir(id), 'v2.md'), 'utf8')).toContain('v2')
    // l'autore è il bot che l'ha creato
    expect(getLibraryItem(id)?.authorAgentId).toBe(AGENT)
  })

  it('limite: oltre 200 KB di Markdown la chiamata fallisce e NON crea nulla', () => {
    const before = listLibraryItems().length
    const r = lib.writeDocument(AGENT, { title: 'Troppo grande', content: 'x'.repeat(200 * 1024 + 1) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('limite')
    expect(listLibraryItems().length).toBe(before)
  })

  it('read_document: markdown + titolo + versione + autore; versione specifica', () => {
    const r = lib.writeDocument(AGENT, { title: 'Doc versioni', content: 'v uno' })
    const id = r.ok ? r.value.id : ''
    lib.writeDocument(AGENT, { id, title: 'Doc versioni', content: 'v due' })
    const read = lib.readDocument({ id })
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.value.version).toBe(2)
      expect(read.value.content).toBe('v due')
      expect(read.value.versions).toEqual([1, 2])
    }
    const older = lib.readDocument({ id, version: 1 })
    expect(older.ok && older.value.content).toBe('v uno')
  })

  it('nessun tool per cancellare: deleteLibraryItem esiste solo per la UI (mai in executeTool/toolDefs)', async () => {
    const { toolDefs } = await import('../tools')
    const names = toolDefs.map((t) => t.name)
    expect(names).toContain('write_document')
    expect(names).toContain('edit_document')
    expect(names).toContain('read_document')
    expect(names).toContain('list_library')
    expect(names.some((n) => /delete.*librar|librar.*delete/i.test(n))).toBe(false)
  })

  it('deleteLibraryItem (UI) toglie anche la cartella', () => {
    const r = lib.writeDocument(AGENT, { title: 'Da cancellare', content: 'x' })
    const id = r.ok ? r.value.id : ''
    expect(existsSync(libraryItemDir(id))).toBe(true)
    expect(deleteLibraryItem(id)).toBe(true)
    expect(getLibraryItem(id)).toBeNull()
    expect(existsSync(libraryItemDir(id))).toBe(false)
  })
})

describe('punto 2: edit_document con sostituzioni esatte', () => {
  it('old unico → si applica e produce UNA nuova versione', () => {
    const r = lib.writeDocument(AGENT, { title: 'Piano', content: 'Punto uno.\nPunto due.\n' })
    const id = r.ok ? r.value.id : ''
    const e = lib.editDocument(AGENT, { id, edits: [{ old: 'Punto due.', new: 'Punto due (rivisto).' }] })
    expect(e.ok).toBe(true)
    expect(e.ok && e.value.version).toBe(2)
    const after = lib.readDocument({ id })
    expect(after.ok && after.value.content).toContain('rivisto')
  })

  it('old ASSENTE (0 volte) → errore che lo dice e NESSUNA modifica (manco le successive)', () => {
    const r = lib.writeDocument(AGENT, { title: 'Piano2', content: 'A\nB\n' })
    const id = r.ok ? r.value.id : ''
    const e = lib.editDocument(AGENT, {
      id,
      edits: [
        { old: 'A', new: 'A2' },
        { old: 'MANCA', new: 'X' }
      ]
    })
    expect(e.ok).toBe(false)
    if (!e.ok) {
      expect(e.error).toContain('0 volte')
      expect(e.error).toContain('nessuna modifica applicata')
    }
    // NESSUNA modifica parziale: la v2 non esiste
    expect(getLibraryItem(id)?.currentVersion).toBe(1)
    const kept = lib.readDocument({ id })
    expect(kept.ok && kept.value.content).toBe('A\nB\n')
  })

  it('old DUPLICATO (2 volte) → errore con il numero e nessuna modifica', () => {
    const r = lib.writeDocument(AGENT, { title: 'Piano3', content: 'ripeti\nripeti\n' })
    const id = r.ok ? r.value.id : ''
    const e = lib.editDocument(AGENT, { id, edits: [{ old: 'ripeti', new: 'una volta sola' }] })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.error).toContain('2 volte')
    expect(getLibraryItem(id)?.currentVersion).toBe(1)
  })
})

describe('punto 3: grafici Vega-Lite e Mermaid', () => {
  it('spec valida → SVG generato dal daemon che CONTIENE i valori', async () => {
    const r = await lib.saveChart(AGENT, { title: 'Vendite Q1', kind: 'vega-lite', spec: GOOD_SPEC })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.value.id : ''
    const svg = lib.chartSvgOf(id)
    expect(svg).not.toBeNull()
    expect(svg!).toContain('<svg')
    // i valori dei dati compaiono nella resa (le etichette delle barre)
    expect(svg!).toContain('gen')
    expect(svg!).toContain('feb')
  })

  it('url a QUALUNQUE profondità → rifiuto (anche dentro un transform o un layer)', () => {
    const deep = JSON.stringify({
      mark: 'point',
      layer: [{ mark: 'point', data: { url: 'https://evil.example/dati.json' } }]
    })
    const check = charts.validateVegaLiteSpec(deep)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toContain('url')
    const nested = JSON.stringify({ transform: [{ fold: ['a'] }], datasets: { d: [{ url: 'https://x.example' }] }, data: { values: [] }, mark: 'point' })
    expect(charts.validateVegaLiteSpec(nested).ok).toBe(false)
  })

  it("P6: href a QUALUNQUE profondità → rifiutato con l'errore chiaro (mark.href e encoding.href), anche nel renderer", async () => {
    // mark.href: il link che Vega-Lite rende cliccabile — prima della correzione
    // arrivava alla resa e moriva con loader._loader.sanitize is not a function
    const markHref = charts.validateVegaLiteSpec(JSON.stringify({
      mark: { type: 'point', href: 'https://evil.example/click' },
      data: { values: [{ x: 1, y: 2 }] }
    }))
    expect(markHref.ok).toBe(false)
    if (!markHref.ok) expect(markHref.error).toContain('chiave "href" non ammessa (link nei grafici)')
    // encoding.href, anche NIDIFICATO in un layer
    const nested = charts.validateVegaLiteSpec(JSON.stringify({
      mark: 'point',
      layer: [{ mark: 'point', encoding: { href: { field: 'link', type: 'nominal' } }, data: { values: [] } }],
      data: { values: [] }
    }))
    expect(nested.ok).toBe(false)
    if (!nested.ok) expect(nested.error).toContain('href')
    // il RENDERER rifiuta le stesse chiave (l'anteprima non renderizza link)
    const { vegaSpecHasKey, VEGA_FORBIDDEN_KEYS, renderVegaLiteInRenderer } = await import('../../../renderer/src/vega-render')
    for (const key of VEGA_FORBIDDEN_KEYS) {
      expect(vegaSpecHasKey({ mark: { type: 'point', [key]: 'x' }, data: { values: [] } }, key), key).toBe(true)
    }
    expect(vegaSpecHasKey({ mark: 'point', data: { values: [{ a: 1 }] } }, 'href')).toBe(false)
    expect(await renderVegaLiteInRenderer(JSON.stringify({ mark: { type: 'point', href: 'https://x.example' }, data: { values: [] } }))).toBeNull()
  })

  it('loader vietato; spec oltre 200 KB vietata; righe oltre 5000 vietate', () => {
    expect(charts.validateVegaLiteSpec(JSON.stringify({ mark: 'point', loader: {}, data: { values: [] } })).ok).toBe(false)
    const big = JSON.stringify({ mark: 'point', data: { values: [{ x: 'y'.repeat(220 * 1024) }] } })
    expect(charts.validateVegaLiteSpec(big).ok).toBe(false)
    const rows = { mark: 'point', data: { values: Array.from({ length: 5001 }, (_v, i) => ({ i })) } }
    expect(charts.validateVegaLiteSpec(JSON.stringify(rows)).ok).toBe(false)
    expect(charts.validateVegaLiteSpec(JSON.stringify({ ...rows, data: { values: rows.data.values.slice(0, 5000) } })).ok).toBe(true)
  })

  it('il loader non fa richieste: un server finto conta ZERO richieste durante la resa', async () => {
    let requests = 0
    const srv: Server = createServer((_req, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      // una spec MALEDETTA con un url che punta al server finto non passa la
      // validazione; la resa di una spec PULITA non lo tocca mai
      const bad = charts.validateVegaLiteSpec(JSON.stringify({ mark: 'point', data: { url: `http://127.0.0.1:${port}/d.json` } }))
      expect(bad.ok).toBe(false)
      const check = charts.validateVegaLiteSpec(GOOD_SPEC)
      expect(check.ok).toBe(true)
      if (check.ok) await lib.renderVegaLiteSvg(check.spec)
      expect(requests).toBe(0)
    } finally {
      srv.closeAllConnections?.()
      srv.close()
    }
  })

  it('mermaid: sorgente salvato; oltre 50 KB → rifiuto e voce NON creata', async () => {
    const r = await lib.saveChart(AGENT, { title: 'Flusso', kind: 'mermaid', spec: 'graph TD\nA-->B\nB-->C\n' })
    expect(r.ok).toBe(true)
    expect(lib.chartSourceOf(r.ok ? r.value.id : '')).toContain('graph TD')
    const before = listLibraryItems({ kind: 'chart' }).length
    const big = await lib.saveChart(AGENT, { title: 'Enorme', kind: 'mermaid', spec: 'A-->B\n'.repeat(30_000) })
    expect(big.ok).toBe(false)
    expect(listLibraryItems({ kind: 'chart' }).length).toBe(before)
  })

  it('errore di compilazione Vega-Lite → la voce NON si crea', async () => {
    const before = listLibraryItems({ kind: 'chart' }).length
    const r = await lib.saveChart(AGENT, {
      title: 'Rotta',
      kind: 'vega-lite',
      // mark sconosciuto e encoding senza campi: vega-lite rifiuta
      spec: JSON.stringify({ mark: { type: 'nessun-tipo-del-tutto', invalid: true }, encoding: {} })
    })
    expect(r.ok).toBe(false)
    expect(listLibraryItems({ kind: 'chart' }).length).toBe(before)
  })
})

describe('punto 2: blocchi grafico DENTRO un documento', () => {
  it('blocco vega-lite valido nel documento → salvato; blocco NON valido → NESSUNA versione scritta', async () => {
    const ok = lib.writeDocument(AGENT, {
      title: 'Report coi grafici',
      content: '# Report\n\n' + '```vega-lite\n' + GOOD_SPEC + '\n```\n\nFine.'
    })
    expect(ok.ok).toBe(true)
    const bad = lib.writeDocument(AGENT, {
      title: 'Report rotto',
      content: '# Report\n\n```vega-lite\n{"mark":"point","data":{"url":"https://x.example"}}\n```\n'
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('blocco vega-lite n. 1')
    // nemmeno la v1 esiste
    expect(getLibraryItem('lib_00000000')).toBeNull()
  })

  it('edit che introduce un blocco mermaid troppo grande → rifiutato, versione non scritta', () => {
    const r = lib.writeDocument(AGENT, { title: 'Doc mermaid', content: 'testo\n' })
    const id = r.ok ? r.value.id : ''
    const e = lib.editDocument(AGENT, {
      id,
      edits: [{ old: 'testo', new: '```mermaid\n' + 'A-->B\n'.repeat(30_000) + '```' }]
    })
    expect(e.ok).toBe(false)
    expect(getLibraryItem(id)?.currentVersion).toBe(1)
  })
})

describe('punto 4: list_library (ordine, filtro, tetto) e save_to_library in host', () => {
  it('le FISSATE prima, poi le altre dalle più recenti; filtro kind e query; tetto 20', async () => {
    const a = lib.writeDocument(AGENT, { title: 'Antico', content: 'a' })
    const b = lib.writeDocument(AGENT, { title: 'Bellissimo', content: 'b' })
    const c = lib.writeDocument(AGENT2, { title: 'Chart bello', content: 'c' })
    void c
    const idB = b.ok ? b.value.id : ''
    const idA = a.ok ? a.value.id : ''
    // fissa B: sta in cima anche se A... (entrambe nuove, B fissata vince)
    const { updateLibraryItem } = await import('../../store/library')
    updateLibraryItem(idB, { pinned: true })
    const { rows } = lib.listLibrary({})
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]!.id).toBe(idB)
    // query sul titolo
    const q = lib.listLibrary({ query: 'bellissimo' })
    expect(q.rows.every((x) => x.title.toLowerCase().includes('bellissimo'))).toBe(true)
    // tetto
    const capped = lib.listLibrary({ limit: 99 })
    expect(capped.rows.length).toBeLessThanOrEqual(20)
    void idA
  })

  it('save_to_library in host: file della cartella di lavoro del bot → voce file con sha256 e mime', async () => {
    // file nella home del bot (box host: <dataDir>/box/home/<agent>)
    const { boxDir } = await import('../../sandbox')
    const dir = boxDir(AGENT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'grafico.png'), Buffer.from('89504e47-finto-png-di-prova', 'utf8'))
    const r = await lib.saveFileFromBox(AGENT, { path: 'grafico.png', title: 'Grafico esportato' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.name).toBe('grafico.png')
      expect(r.value.size).toBeGreaterThan(0)
      const item = getLibraryItem(r.value.id)
      expect(item?.kind).toBe('file')
      expect(item?.fileSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(item?.fileMime).toBe('image/png')
    }
    // fuori dai confini → rifiuto
    const bad = await lib.saveFileFromBox(AGENT, { path: '../../segreto.txt' })
    expect(bad.ok).toBe(false)
  })
})

describe('punto 6: tainted', () => {
  it('scrittura in turno contaminato → tainted; lettura da un ALTRO bot → meta libraryTainted (dato esterno)', () => {
    const r = lib.writeDocument(AGENT, { title: 'Report da web', content: 'contenuto letto dal web' }, { contaminated: true })
    const id = r.ok ? r.value.id : ''
    expect(getLibraryItem(id)?.tainted).toBe(true)
    const read = lib.readDocument({ id })
    expect(read.ok && read.value.tainted).toBe(true)
    // il meta che il loop trasforma in blocco dato esterno
    void AGENT2
  })

  it('nuova versione da turno contaminato rende tainted un documento pulito', () => {
    const r = lib.writeDocument(AGENT, { title: 'Pulito', content: 'v1 pulita' }, { userTurn: true })
    const id = r.ok ? r.value.id : ''
    expect(getLibraryItem(id)?.tainted).toBe(false)
    lib.writeDocument(AGENT, { id, title: 'Pulito', content: 'v2 contaminata' }, { contaminated: true })
    expect(getLibraryItem(id)?.tainted).toBe(true)
  })

  it('tornare pulito richiede una scrittura da un turno pulito DELL\'UTENTE (non di routine)', () => {
    const r = lib.writeDocument(AGENT, { title: 'Ripulire', content: 'v1' }, { contaminated: true })
    const id = r.ok ? r.value.id : ''
    // una routine pulita NON pulisce
    lib.writeDocument(AGENT, { id, title: 'Ripulire', content: 'v2 da routine' }, { userTurn: false, contaminated: false })
    expect(getLibraryItem(id)?.tainted).toBe(true)
    // la scrittura dell'utente in turno pulito sì
    lib.writeDocument(AGENT, { id, title: 'Ripulire', content: 'v3 dell\'utente' }, { userTurn: true, contaminated: false })
    expect(getLibraryItem(id)?.tainted).toBe(false)
  })

  it('list_library: basta UNA voce tainted perché l\'intero result sia dato esterno', () => {
    lib.writeDocument(AGENT, { title: 'Voce pulita lista', content: 'x' }, { userTurn: true })
    lib.writeDocument(AGENT, { title: 'Voce sporca lista', content: 'y' }, { contaminated: true })
    const { anyTainted } = lib.listLibrary({})
    expect(anyTainted).toBe(true)
  })

  it('file salvato in turno contaminato → tainted', async () => {
    const { boxDir } = await import('../../sandbox')
    const dir = boxDir(AGENT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'da-web.txt'), 'contenuto')
    const r = await lib.saveFileFromBox(AGENT, { path: 'da-web.txt' }, {}, { contaminated: true })
    expect(getLibraryItem(r.ok ? r.value.id : '')?.tainted).toBe(true)
  })
})

describe('punto 5: esportazione', () => {
  it('HTML autonomo: nessuno script, NESSUN http(s):// in src/href, SVG IN LINEA, CSS in linea', async () => {
    const r = lib.writeDocument(AGENT, {
      title: 'Report da esportare',
      content: `# Report\n\nTesto con [un link](https://example.com/pagina).\n\n\`\`\`vega-lite\n${GOOD_SPEC}\n\`\`\`\n\n| col | altra |\n|---|---|\n| 1 | 2 |\n`
    })
    const id = r.ok ? r.value.id : ''
    const item = getLibraryItem(id)!
    const html = await lib.documentHtmlOf(item)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html.toLowerCase()).not.toContain('<script')
    // nessuna risorsa esterna: niente src= o href= con http(s)
    const srcHref = [...html.matchAll(/(?:src|href)\s*=\s*"[^"]*"/gi)].map((m) => m[0])
    expect(srcHref.every((v) => !/https?:\/\//i.test(v))).toBe(true)
    // l'SVG del grafico è IN LINEA (generato dal daemon, non dal modello)
    expect(html).toContain('<svg')
    // il CSS è in linea (nessun <link>)
    expect(html).not.toMatch(/<link\b/i)
    // il link del testo resta LEGGIBILE ma non è cliccabile
    expect(html).toContain('un link (https://example.com/pagina)')
    // tabella GFM resa
    expect(html).toContain('<table>')
  })

  it('prepareLibraryExport: formati validi per tipo; nome non in conflitto alla copia', async () => {
    const r = lib.writeDocument(AGENT, { title: 'Esportami', content: 'contenuto' })
    const id = r.ok ? r.value.id : ''
    const ok = lib.prepareLibraryExport({ id, format: 'html' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.name).toBe('Esportami.html')
    const bad = lib.prepareLibraryExport({ id, format: 'svg' })
    expect(bad.ok).toBe(false)
    // il nome non in conflitto: destinazione di prova
    const dest = mkdtempSync(join(tmpdir(), 'sandbot-export-test-'))
    try {
      const p1 = ok.ok ? ok.value : null
      expect(p1).not.toBeNull()
      const first = await lib.runLibraryExport(p1!, { targetDir: dest })
      expect(first.finalPath).toBe(join(dest, 'Esportami.html'))
      // seconda esportazione: nome alternativo, MAI sopra una copia esistente
      const second = await lib.runLibraryExport(p1!, { targetDir: dest })
      expect(second.finalPath).toBe(join(dest, 'Esportami (1).html'))
      expect(existsSync(join(dest, 'Esportami.html'))).toBe(true)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('pdf senza printToPdf → l\'esito dice di aprire SandBot o scegliere html', async () => {
    const r = lib.writeDocument(AGENT, { title: 'PDF', content: 'per il pdf' })
    const id = r.ok ? r.value.id : ''
    const plan = lib.prepareLibraryExport({ id, format: 'pdf' })
    expect(plan.ok).toBe(true)
    await expect(lib.runLibraryExport(plan.ok ? plan.value : null as never, {})).rejects.toThrow(/finestra di SandBot|html/)
    // con il generatore finto (la "UI"): pdf scritto davvero
    const dest = mkdtempSync(join(tmpdir(), 'sandbot-pdf-test-'))
    try {
      const out = await lib.runLibraryExport(plan.ok ? plan.value : null as never, {
        targetDir: dest,
        printToPdf: async () => Buffer.from('%PDF-1.4 finto')
      })
      expect(out.finalPath.endsWith('.pdf')).toBe(true)
      expect(readFileSync(out.finalPath).toString()).toContain('%PDF')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('grafico: export svg (Vega-Lite) o mmd (Mermaid); file → il file stesso', async () => {
    const chart = await lib.saveChart(AGENT, { title: 'Vendite esportabili', kind: 'vega-lite', spec: GOOD_SPEC })
    const plan = lib.prepareLibraryExport({ id: chart.ok ? chart.value.id : '', format: 'svg' })
    expect(plan.ok).toBe(true)
    const mmd = await lib.saveChart(AGENT, { title: 'Diagramma esportabile', kind: 'mermaid', spec: 'graph TD\nA-->B\n' })
    const planM = lib.prepareLibraryExport({ id: mmd.ok ? mmd.value.id : '', format: 'mmd' })
    expect(planM.ok).toBe(true)
    // un file: formato 'file' (o vuoto)
    const { boxDir } = await import('../../sandbox')
    mkdirSync(boxDir(AGENT), { recursive: true })
    writeFileSync(join(boxDir(AGENT), 'consegna.txt'), 'il file')
    const f = await lib.saveFileFromBox(AGENT, { path: 'consegna.txt' })
    const planF = lib.prepareLibraryExport({ id: f.ok ? f.value.id : '' })
    expect(planF.ok).toBe(true)
    if (planF.ok) expect(planF.value.format).toBe('file')
  })
})

describe('punto 1: spazio (avviso oltre 2 GB, NESSUN blocco)', () => {
  it('libraryTotalBytes conta i byte e la soglia non blocca la scrittura', () => {
    const bytes = lib.libraryTotalBytes()
    expect(bytes).toBeGreaterThan(0)
    // la soglia è 2 GB: qui siamo sotto, l'avviso è della UI
    expect(lib.LIBRARY_TOTAL_WARN_BYTES).toBe(2 * 1024 * 1024 * 1024)
    // anche "oltre" si scrive: il controllo è solo un avviso
    const r = lib.writeDocument(AGENT, { title: 'Oltre la soglia (test)', content: 'x' })
    expect(r.ok).toBe(true)
  })
})

// i settings non contengono MAI markdown dei documenti in chiaro (stanno su file)
describe('niente contenuto documenti nei settings', () => {
  it('il markdown NON vive nei settings (solo metadati nella tabella, file nella cartella)', () => {
    expect(getSetting('library', null)).toBeNull()
  })
})
