// Fase 19b (T6/T7): la vista FILE del computer del bot. Qui si prova la
// parte in HOST (fs vero su una mkdtemp in /var/folders/nb/…): i confini sul
// PERCORSO REALE (.., path assoluti, symlink verso /etc e /browser),
// l'anteprima (testo UTF-8 rigoroso, immagine, binario, troppo grande),
// l'upload (il percorso di T0, exists → «Sostituire?», tetto 100 MB) e il
// download (solo file). Il parse della listing di find -printf è PURO e si
// prova sull'output VERO del formato. Il bot esiste sempre: il db è FINTO.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { COMPUTER_ACTIONS_DDL } from '../../store/computer-actions'

const TMP = mkdtempSync(join('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T', 'sandbot-files-test-'))
const mode = vi.hoisted(() => ({ value: 'host' as string }))
// il db del daemon è FINTO: un :memory: con computer_actions
const mem = new DatabaseSync(':memory:')
mem.exec(COMPUTER_ACTIONS_DDL)
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? mode.value : fallback),
  dataDir: () => TMP,
  db: () => mem,
  getAgent: (id: string) => (id === 'agent_x' ? { id, name: 'Bot X', parentId: null } : null),
  familyAgents: (owner: string) => (owner === 'agent_x' ? [{ id: 'agent_x', name: 'Bot X' }] : [])
}))
vi.mock('../../sandbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // boxOwnerOf: l'id stesso (il proprietario del pannello); la copia box → Mac
  // usa il fs vero dell'host (come l'originale, qui senza docker cp)
  boxOwnerOf: (id: string) => id
}))

const { parseFilesRelPath, parseFindListing, sortFileEntries, listBotFiles, readBotFile, exportBotFile, importMacFile, FILES_LIST_MAX_ENTRIES } = await import('../computer-files')
const { recordComputerAction } = await import('../computer-activity')
const { recentComputerActionsOf } = await import('../../store/computer-actions')

describe('fase 19b (T7, puro): il parse della listing di find -printf', () => {
  it('tipi, dimensioni, mtime e nomi con TAB; le righe malformate si scartano', () => {
    const out = [
      'd\t4096\t1770000000.1234567890\tcartella',
      'f\t42\t1770000001.5\tfile.txt',
      'l\t31\t1770000002\tcollegamento',
      'f\t7\t1770000003\tnome con\ttab dentro',
      'c\t3\t1770000004\tchar-device-mappato-file',
      'f\tNONNUMERICO\t1770000005\trotta',
      'f\t12\t1770000006',
      'f\t1\t1770000007\t'
    ].join('\n')
    const { entries, truncated } = parseFindListing(out)
    expect(truncated).toBe(false)
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['cartella', 'dir'],
      ['file.txt', 'file'],
      ['collegamento', 'link'],
      ['nome con\ttab dentro', 'file'],
      ['char-device-mappato-file', 'file']
    ])
    expect(entries[0]!.size).toBe(4096)
    expect(entries[0]!.mtime).toBe(1770000000123) // epoch secondi → ms, floor
    expect(entries[1]!.mtime).toBe(1770000001500)
  })

  it('oltre FILES_LIST_MAX_ENTRIES voci: truncated e l\'elenco fermato al tetto', () => {
    const rows = Array.from({ length: FILES_LIST_MAX_ENTRIES + 5 }, (_, i) => `f\t${i}\t1770000000\tfile-${i}`).join('\n')
    const { entries, truncated } = parseFindListing(rows)
    expect(truncated).toBe(true)
    expect(entries).toHaveLength(FILES_LIST_MAX_ENTRIES)
  })

  it('l\'ordine: PRIMA le cartelle, poi per nome', () => {
    const sorted = sortFileEntries([
      { name: 'zeta.txt', kind: 'file', size: 1, mtime: 0 },
      { name: 'beta', kind: 'dir', size: 2, mtime: 0 },
      { name: 'alfa.txt', kind: 'file', size: 3, mtime: 0 },
      { name: 'Alpha2', kind: 'dir', size: 4, mtime: 0 }
    ])
    expect(sorted.map((e) => e.name)).toEqual(['Alpha2', 'beta', 'alfa.txt', 'zeta.txt'])
  })
})

describe('fase 19b (T6, puro): i path relativi della vista', () => {
  it('il vuoto è la radice; .. e path assoluti si rifiutano; i segmenti vuoti si normalizzano', () => {
    expect(parseFilesRelPath('')).toEqual({ ok: true, rel: '' })
    expect(parseFilesRelPath('home/a//b/./c')).toEqual({ ok: true, rel: 'home/a/b/c' })
    expect(parseFilesRelPath('..').ok).toBe(false)
    expect(parseFilesRelPath('home/../..').ok).toBe(false)
    expect(parseFilesRelPath('/etc/passwd').ok).toBe(false)
    expect(parseFilesRelPath('/box/home/x').ok).toBe(false)
    expect(parseFilesRelPath('a\0b').ok).toBe(false)
  })
})

describe('fase 19b (T6): i file del box in host — confini sul PERCORSO REALE', () => {
  // la radice del box della directory dati iniettata: <TMP>/box. FUORI dalla
  // radice, una cartella che fa da «browser» (sul Mac /browser non esiste:
  // il realpath di un symlink a destinazione ASSENTE darebbe «not found»,
  // qui si prova il caso VERO: la destinazione esiste ED è fuori)
  const OUTSIDE = mkdtempSync(join('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T', 'sandbot-files-outside-'))
  beforeAll(() => {
    mkdirSync(join(TMP, 'box', 'home', 'agent_x'), { recursive: true })
    writeFileSync(join(TMP, 'box', 'home', 'agent_x', 'testo.txt'), 'ciao\nàè\n')
    writeFileSync(join(TMP, 'box', 'home', 'agent_x', 'binario.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    writeFileSync(join(TMP, 'box', 'home', 'agent_x', 'immagine.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(TMP, 'box', 'home', 'agent_x', '.nascosto'), 'nascosto')
    mkdirSync(join(TMP, 'box', 'workspace'), { recursive: true })
    writeFileSync(join(TMP, 'box', 'workspace', 'condiviso.txt'), 'shared')
    // i symlink che EScono dalla radice: verso /etc e verso il «browser»
    mkdirSync(join(OUTSIDE, 'browser'), { recursive: true })
    writeFileSync(join(OUTSIDE, 'browser', 'mcp.pid'), '123')
    symlinkSync('/etc', join(TMP, 'box', 'home', 'agent_x', 'verso-etc'))
    symlinkSync(join(OUTSIDE, 'browser'), join(TMP, 'box', 'home', 'agent_x', 'verso-browser'))
  })
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(OUTSIDE, { recursive: true, force: true })
  })

  it('files:list della radice risponde la HOME del bot; i NASCOSTI ci sono, le cartelle prima', async () => {
    const r = await listBotFiles('agent_x', '')
    expect(r.home).toBe('home/agent_x')
    expect(r.entries.map((e) => e.name)).toContain('home')
    expect(r.entries.map((e) => e.name)).toContain('workspace')
    const home = await listBotFiles('agent_x', 'home/agent_x')
    expect(home.entries.map((e) => e.name)).toContain('.nascosto')
    expect(home.entries.find((e) => e.name === 'home')?.kind).toBeUndefined() // non è nella sua home
    // l'alias workspace si apre (il confine lo permette)
    const ws = await listBotFiles('agent_x', 'workspace')
    expect(ws.entries.map((e) => e.name)).toContain('condiviso.txt')
  })

  it('.. e path fuori radice → rifiuto; il symlink verso /etc o /browser → rifiuto (realpath fuori)', async () => {
    await expect(listBotFiles('agent_x', '..')).rejects.toThrow(/fuori dal computer|outside/i)
    await expect(listBotFiles('agent_x', '/etc')).rejects.toThrow()
    await expect(listBotFiles('agent_x', 'home/agent_x/verso-etc')).rejects.toThrow(/fuori dal computer|outside/i)
    await expect(readBotFile('agent_x', 'home/agent_x/verso-etc/passwd')).rejects.toThrow(/fuori dal computer|outside/i)
    await expect(readBotFile('agent_x', 'home/agent_x/verso-browser/mcp.pid')).rejects.toThrow(/fuori dal computer|outside/i)
  })

  it('files:read: testo UTF-8 valido, binario NON testo, immagine in base64, inesistente', async () => {
    const text = await readBotFile('agent_x', 'home/agent_x/testo.txt')
    expect(text).toEqual({ kind: 'text', content: 'ciao\nàè\n' })
    const bin = await readBotFile('agent_x', 'home/agent_x/binario.bin')
    expect(bin).toEqual({ kind: 'binary', size: 4 })
    const img = await readBotFile('agent_x', 'home/agent_x/immagine.png')
    expect(img.kind).toBe('image')
    if (img.kind === 'image') {
      expect(img.mime).toBe('image/png')
      expect(Buffer.from(img.base64, 'base64').compare(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(0)
    }
    await expect(readBotFile('agent_x', 'home/agent_x/manca.txt')).rejects.toThrow()
  })

  it('files:read: un testo oltre i 2 MB è too-large', async () => {
    const big = join(TMP, 'box', 'home', 'agent_x', 'grande.txt')
    writeFileSync(big, 'a')
    truncateSync(big, 2 * 1024 * 1024 + 1) // sparse: pesa 1 byte sul disco
    const r = await readBotFile('agent_x', 'home/agent_x/grande.txt')
    expect(r.kind).toBe('too-large')
    rmSync(big, { force: true })
  })

  it('files:export: SOLO file (una cartella si rifiuta) e la copia arriva sul Mac', async () => {
    const dest = join(TMP, 'mac-out', 'testo.txt')
    const r = await exportBotFile('agent_x', 'home/agent_x/testo.txt', dest)
    expect(r.ok).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('ciao\nàè\n')
    await expect(exportBotFile('agent_x', 'home/agent_x', join(TMP, 'mac-out', 'cartella'))).rejects.toThrow()
  })

  it('files:import: scrive col percorso di T0; exists senza overwrite → reason exists; con overwrite passa', async () => {
    const macPath = join(TMP, 'mac-src.bin')
    writeFileSync(macPath, Buffer.from([0xff, 0xfe, 0x00]))
    const r = await importMacFile('agent_x', 'home/agent_x', macPath)
    expect(r).toEqual({ ok: true, name: 'mac-src.bin', bytes: 3 })
    // byte IDENTICI byte per byte (mai una stringa UTF-8 di mezzo)
    expect(Buffer.compare(readFileSync(join(TMP, 'box', 'home', 'agent_x', 'mac-src.bin')), Buffer.from([0xff, 0xfe, 0x00]))).toBe(0)
    // esiste già: senza overwrite → { ok: false, reason: 'exists' } (la UI chiede «Sostituire?»)
    const again = await importMacFile('agent_x', 'home/agent_x', macPath)
    expect(again).toEqual({ ok: false, reason: 'exists', name: 'mac-src.bin' })
    // con overwrite: passa e il file è quello NUOVO (rename atomico)
    writeFileSync(macPath, Buffer.from([0x01, 0x02]))
    const over = await importMacFile('agent_x', 'home/agent_x', macPath, true)
    expect(over.ok).toBe(true)
    expect(Buffer.compare(readFileSync(join(TMP, 'box', 'home', 'agent_x', 'mac-src.bin')), Buffer.from([0x01, 0x02]))).toBe(0)
  })

  it('files:import: oltre 100 MB si rifiuta; una cartella di destinazione assente si rifiuta', async () => {
    const big = join(TMP, 'big.bin')
    writeFileSync(big, 'x')
    truncateSync(big, 100 * 1024 * 1024 + 1)
    await expect(importMacFile('agent_x', 'home/agent_x', big)).rejects.toThrow(/troppo grande|too large/i)
    await expect(importMacFile('agent_x', 'cartella/che/non/esiste', join(TMP, 'mac-src.bin'))).rejects.toThrow()
    rmSync(big, { force: true })
  })

  it('upload e download finiscono nel feed (actor user; il target del download col NOME del file del Mac)', async () => {
    const rows = recentComputerActionsOf(mem, 'agent_x', 10)
    const kinds = rows.map((r) => r.kind)
    expect(kinds).toContain('upload')
    expect(kinds).toContain('download')
    expect(rows.every((r) => r.actor === 'user')).toBe(true)
    // il target del download porta il NOME del file del Mac, MAI il percorso completo
    const dl = rows.find((r) => r.kind === 'download')!
    expect(dl.target).toContain('→ testo.txt')
    expect(dl.target).not.toContain(TMP)
  })

  it('un bot che non esiste: errore per TUTTE le RPC di file (T3.1)', async () => {
    await expect(listBotFiles('ghost', '')).rejects.toThrow()
    await expect(readBotFile('ghost', 'home/agent_x/testo.txt')).rejects.toThrow()
  })

  it('la REGISTRAZIONE fallita NON fa fallire il tool (regola di Rakazo)', () => {
    const broken = {
      prepare: () => {
        throw new Error('db rotto')
      }
    } as unknown as DatabaseSync
    expect(() =>
      recordComputerAction({ agentId: 'agent_x', kind: 'write_file', target: 'x', bytes: 1, db: broken })
    ).not.toThrow()
  })
})
