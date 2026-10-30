// Scambio di file Mac <-> box (fase 11, punto 4): policy PURA dei path
// sensibili e del nome alternativo, piano della card, copie reali su
// directory temporanee (nessuna home reale) e card SEMPRE nel loop.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-copy-test-'))
const MAC = join(TMP, 'macHome') // la home del Mac (fake)
const DATA = join(TMP, 'data') // la directory dati di SandBot (fake)

vi.mock('../../store/db', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback,
  dataDir: () => DATA
}))

const pure = await import('../file-exchange')

// il puro e il runner si importano DOPO il mock dello store; le funzioni con
// effetti usano le deps iniettate (home = MAC)
beforeAll(() => {
  mkdirSync(join(MAC, 'Downloads'), { recursive: true })
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(MAC, 'foto.jpg'), 'byte-del-file')
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('policy PURA dei path sul Mac', () => {
  const ctx = { home: '/Users/test', dataDir: '/Users/test/.sandbot/data' }

  it('le cartelle sensibili sono RIFIUTATE (fisso)', () => {
    for (const p of ['~/.ssh/id_rsa', '.ssh/config', 'Library/Keychains/login.keychain', '.aws/credentials', '.config/gcloud/credentials.db', '.gnupg/secring.gpg']) {
      // ~ e relativi si risolvono sulla home
      const abs = p.startsWith('~') ? join(ctx.home, p.slice(1)) : join(ctx.home, p)
      expect(pure.macPathAllowed(abs, ctx), p).toBe(false)
    }
  })

  it('la directory dati di SandBot (token dei connettori) è rifiutata', () => {
    expect(pure.macPathAllowed(join(ctx.home, '.sandbot/data/sandbot.db'), ctx)).toBe(false)
    expect(pure.macPathAllowed('/Users/test/.sandbot/data/sub/token', ctx)).toBe(false)
  })

  it('Downloads, Desktop e le altre cartelle passano', () => {
    expect(pure.macPathAllowed(join(ctx.home, 'Downloads/ricerca.pdf'), ctx)).toBe(true)
    expect(pure.macPathAllowed('/tmp/qualcosa.txt', ctx)).toBe(true)
  })

  it('il limite è 200 MB e la cartella di default è ~/Downloads/Homun', () => {
    expect(pure.FILE_EXCHANGE_MAX_BYTES).toBe(200 * 1024 * 1024)
    expect(pure.MAC_DEFAULT_DIR).toBe(join('Downloads', 'Homun'))
  })
})

describe('nonConflictingName (puro): mai sovrascrivere sul Mac in silenzio', () => {
  it('nome libero → resta; occupato → "file (1).ext", poi "(2)"', () => {
    const esistenti = new Set(['/m/ricerca.pdf', '/m/ricerca (1).pdf'])
    const exists = (p: string) => esistenti.has(p)
    expect(pure.nonConflictingName('/m/nuovo.txt', exists)).toBe('/m/nuovo.txt')
    expect(pure.nonConflictingName('/m/ricerca.pdf', exists)).toBe('/m/ricerca (2).pdf')
    const single = new Set(['/m/ricerca.pdf'])
    expect(pure.nonConflictingName('/m/ricerca.pdf', (p) => single.has(p))).toBe('/m/ricerca (1).pdf')
    // senza estensione
    expect(pure.nonConflictingName('/m/CHANGELOG', (p) => p === '/m/CHANGELOG')).toBe('/m/CHANGELOG (1)')
  })
})

describe('F7: espansione di ~ e REALPATH del path del Mac (puro)', () => {
  const home = '/Users/test'

  it('expandTilde: ~ e ~/ diventano la home, il resto resta', () => {
    expect(pure.expandTilde('~', home)).toBe(home)
    expect(pure.expandTilde('~/Downloads/x.pdf', home)).toBe(join(home, 'Downloads/x.pdf'))
    expect(pure.expandTilde('/tmp/x', home)).toBe('/tmp/x')
    expect(pure.expandTilde('~altro/x', home)).toBe('~altro/x') // la home di ALTRI utenti non si espande
  })

  it('resolveMacPath: segue i symlink del tratto esistente e lascia la coda nuova', () => {
    // realpath FINTO: /h/link è un symlink a /h/.ssh; tutto il resto inesistente
    const fakeReal = (p: string) => (p === '/h/link' ? '/h/.ssh' : p === '/h' ? '/h' : (() => { throw new Error('ENOENT') })())
    // il file ancora inesistente: il tratto esistente (il symlink) si risolve, la coda resta
    expect(pure.resolveMacPath('/h/link/id_rsa', '/h', fakeReal)).toBe('/h/.ssh/id_rsa')
    // coda nuova di due livelli
    expect(pure.resolveMacPath('/h/nuova/cartina/file.txt', '/h', fakeReal)).toBe('/h/nuova/cartina/file.txt')
  })
})

describe('prepareFileExchange: piano e rifiuti PRIMA della card', () => {
  it('copy_to_box: file esistente e non sensibile → piano con dimensione', async () => {
    const r = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, 'foto.jpg'), box_path: '/workspace/foto.jpg' }, { home: MAC })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.direction).toBe('to_box')
      expect(r.plan.size).toBe(Buffer.byteLength('byte-del-file'))
      expect(r.plan.boxPath).toBe(join(DATA, 'box', 'workspace', 'foto.jpg'))
    }
  })

  it('copy_to_box: percorso sensibile, file assente e fuori dal box rifiutati', async () => {
    const sens = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, '.ssh', 'id_rsa'), box_path: 'x' }, { home: MAC })
    expect(sens.ok).toBe(false)
    if (!sens.ok) expect(sens.error).toContain('sensibili')
    const assente = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, 'manca.txt'), box_path: 'x' }, { home: MAC })
    expect(assente.ok).toBe(false)
    if (!assente.ok) expect(assente.error).toContain('non trovato')
    const fuori = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, 'foto.jpg'), box_path: '../../../etc/passwd' }, { home: MAC })
    expect(fuori.ok).toBe(false)
    if (!fuori.ok) expect(fuori.error).toContain('esce dal box condiviso')
  })

  it('tetto dei 200 MB rifiutato prima della card', async () => {
    const big = join(MAC, 'big.bin')
    const r = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: big, box_path: 'big.bin' }, {
      home: MAC,
      statSize: async () => 300 * 1024 * 1024
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('troppo grande')
  })

  it('copy_from_box: destinazione di default ~/Downloads/Homun/<nome>', async () => {
    // un file nel box (host) da portare sul Mac
    const boxFile = join(DATA, 'box', 'home', 'agent_c', 'report.md')
    mkdirSync(join(DATA, 'box', 'home', 'agent_c'), { recursive: true })
    writeFileSync(boxFile, '# report')
    const r = await pure.prepareFileExchange('agent_c', 'copy_from_box', { box_path: 'report.md' }, { home: MAC })
    expect(r.ok).toBe(true)
    // F7: il piano porta la forma CANONICA del tratto esistente (la temporanea
    // sta dietro il symlink /var → /private/var) con la coda nuova com'è
    if (r.ok) expect(r.plan.macPath).toBe(join(realpathSync(join(MAC, 'Downloads')), 'Homun', 'report.md'))
  })

  it('copy_from_box verso cartella sensibile del Mac rifiutato', async () => {
    const r = await pure.prepareFileExchange('agent_c', 'copy_from_box', { box_path: 'report.md', mac_path: '.ssh/x' }, { home: MAC })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('non permesso')
  })
})

describe('F7: symlink, maiuscole e ~ nei path del Mac (realpath PRIMA del controllo)', () => {
  it('un symlink di Downloads verso ~/.ssh NON passa: la card mostrebbe il path innocuo, il controllo vede quello REALE', async () => {
    mkdirSync(join(MAC, '.ssh'), { recursive: true })
    writeFileSync(join(MAC, '.ssh', 'id_ed25519'), 'CHIAVE')
    try {
      symlinkSync(join(MAC, '.ssh'), join(MAC, 'Downloads', 'chiave'))
      const r = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, 'Downloads', 'chiave', 'id_ed25519'), box_path: 'k' }, { home: MAC })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('sensibili')
        // il messaggio mostra il path REALE risolto, non quello del symlink
        expect(r.error).toContain(realpathSync(join(MAC, '.ssh', 'id_ed25519')))
      }
    } finally {
      rmSync(join(MAC, 'Downloads', 'chiave'))
      rmSync(join(MAC, '.ssh'), { recursive: true, force: true })
    }
  })

  it('.SSH a maiuscole NON aggira il controllo (confronto case-insensitive + maiusole canoniche)', async () => {
    mkdirSync(join(MAC, '.ssh'), { recursive: true })
    writeFileSync(join(MAC, '.ssh', 'id_ed25519'), 'CHIAVE')
    try {
      // su APFS (case-insensitive di default) .SSH È .ssh: realpathSync.native
      // torna le maiuscole canoniche e il confronto ignora il caso comunque
      const r = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, '.SSH', 'id_ed25519'), box_path: 'k' }, { home: MAC })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('sensibili')
      // il confronto case-insensitive vale anche per la policy pura (stessa
      // base canonica per il path e per la home del contesto)
      const realMac = realpathSync(MAC)
      expect(pure.macPathAllowed(join(realMac, '.SSH', 'x'), { home: realMac, dataDir: realpathSync(DATA) })).toBe(false)
      expect(pure.macPathAllowed(join(realMac, 'LIBRARY/KEYCHAINS/x'), { home: realMac, dataDir: realpathSync(DATA) })).toBe(false)
    } finally {
      rmSync(join(MAC, '.ssh'), { recursive: true, force: true })
    }
  })

  it('~/Downloads/x scritto dal modello si risolve nella home VERA (non <home>/~/Downloads/x)', async () => {
    writeFileSync(join(MAC, 'Downloads', 'nota.txt'), 'ciao')
    const r = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: '~/Downloads/nota.txt', box_path: 'nota.txt' }, { home: MAC })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // il piano (e la card) mostra il path reale risolto, col symlink della
      // temporanea ridotto alla forma canonica
      expect(r.plan.macPath).toBe(realpathSync(join(MAC, 'Downloads', 'nota.txt')))
      expect(r.plan.macPath).not.toContain('~')
    }
  })

  it('copy_from_box: la cartella di destinazione passa dal realpath (symlink → .ssh rifiutato)', async () => {
    const boxFile = join(DATA, 'box', 'home', 'agent_c', 'report.md')
    mkdirSync(join(DATA, 'box', 'home', 'agent_c'), { recursive: true })
    writeFileSync(boxFile, '# report')
    mkdirSync(join(MAC, '.ssh'), { recursive: true })
    try {
      symlinkSync(join(MAC, '.ssh'), join(MAC, 'portachiavi'))
      const r = await pure.prepareFileExchange('agent_c', 'copy_from_box', { box_path: 'report.md', mac_path: 'portachiavi/report.md' }, { home: MAC })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('non permesso')
    } finally {
      rmSync(join(MAC, 'portachiavi'))
      rmSync(join(MAC, '.ssh'), { recursive: true, force: true })
    }
  })
})

describe('runFileExchange: copia reale su directory temporanee', () => {
  it('copy_to_box copia nel box; copy_from_box scrive sul Mac SENZA sovrascrivere', async () => {
    // to_box
    const pre1 = await pure.prepareFileExchange('agent_c', 'copy_to_box', { mac_path: join(MAC, 'foto.jpg'), box_path: 'foto.jpg' }, { home: MAC })
    if (!pre1.ok) throw new Error('precheck fallito')
    const r1 = await pure.runFileExchange('agent_c', pre1.plan, { home: MAC })
    expect(readFileSync(join(DATA, 'box', 'home', 'agent_c', 'foto.jpg'), 'utf8')).toBe('byte-del-file')
    expect(r1.output).toContain('Copiato nel box')
    // from_box: sul Mac esiste GIÀ un file con lo stesso nome → nome alternativo
    mkdirSync(join(MAC, 'Downloads', 'Homun'), { recursive: true })
    writeFileSync(join(MAC, 'Downloads', 'Homun', 'report.md'), 'VECCHIO')
    const pre2 = await pure.prepareFileExchange('agent_c', 'copy_from_box', { box_path: 'report.md' }, { home: MAC })
    if (!pre2.ok) throw new Error('precheck fallito')
    const r2 = await pure.runFileExchange('agent_c', pre2.plan, { home: MAC })
    // il nome alternativo parte dal path CANONICO del piano (F7)
    expect(r2.finalMacPath).toBe(join(realpathSync(join(MAC, 'Downloads')), 'Homun', 'report (1).md'))
    expect(readFileSync(join(MAC, 'Downloads', 'Homun', 'report.md'), 'utf8')).toBe('VECCHIO') // intatto
    expect(readFileSync(r2.finalMacPath!, 'utf8')).toBe('# report')
    expect(r2.output).toContain('esisteva già')
  })
})
