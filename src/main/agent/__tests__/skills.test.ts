// Test della LIBRERIA UNICA delle skill (fase skill S2/S3/S5): una cartella
// per skill in <dataDir>/skills/<name>/, metadati nel setting skills.library,
// visibilità per bot (il figlio eredita dal padre), prompt con 60 voci e
// descrizione a 300 caratteri, tool skill({name, file?}) solo su percorsi
// esatti, versioni in .versions/, espansione del `/nome` (S7).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, createAgent, deleteAgent, setSetting } = await import('../../store/db')
const {
  writeLibrarySkill, writeSkillFromBot, deleteLibrarySkill, listLibrarySkills, librarySkillsVisibleTo,
  buildSkillsSection, skillsSectionPrompt, readSkillFor, readSkillFileFor, setSkillEnabledFor,
  libraryDir, skillsLibrary, scanSkillFolder, saveSkillVersion, listSkillVersions, restoreSkillVersion,
  exportSkillFolder, skillInvocationExpansion, invocableSkillsOf, slugifyBotName, SKILLS_PROMPT_MAX,
  libraryItemsForUi, invocableSkillList, isThirdPartySkill
} = await import('../skills')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-skills-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('S2: la libreria unica', () => {
  it('writeLibrarySkill crea <dataDir>/skills/<name>/SKILL.md e la voce nel setting', () => {
    const { created } = writeLibrarySkill({ name: 'daily-report', description: 'costruisce il report del giorno', body: 'Apri i dati e riassumi.' })
    expect(created).toBe(true)
    expect(existsSync(join(libraryDir(), 'daily-report', 'SKILL.md'))).toBe(true)
    expect(skillsLibrary()['daily-report']?.enabledFor).toEqual(['*'])
  })

  it('visibilità per bot: enabledFor id o *; un ALTRO bot non vede; il sottoagente eredita dal padre', () => {
    const padre = createAgent('Padre')
    const altro = createAgent('Altro Bot')
    const figlio = createAgent('Figlio', '', { parentId: padre.id })
    writeLibrarySkill({ name: 'per-il-padre', description: 'd', body: 'b' }, { entry: { enabledFor: [padre.id], source: 'bot', createdBy: padre.id } })
    writeLibrarySkill({ name: 'per-tutti', description: 'd', body: 'b' })
    const ids = librarySkillsVisibleTo(padre.id).map((s) => s.name)
    expect(ids).toContain('per-il-padre')
    expect(ids).toContain('per-tutti')
    // un ALTRO bot NON vede la skill del padre (enabledFor per id)
    const altroIds = librarySkillsVisibleTo(altro.id).map((s) => s.name)
    expect(altroIds).toContain('per-tutti')
    expect(altroIds).not.toContain('per-il-padre')
    // il SOTTOAGENTE vede quelle del padre (boxOwnerOf → parentId)
    const figlioIds = librarySkillsVisibleTo(figlio.id).map((s) => s.name)
    expect(figlioIds).toContain('per-tutti')
    expect(figlioIds).toContain('per-il-padre')
    deleteAgent(altro.id)
  })

  it('setSkillEnabledFor aggiorna «Bot che la usano»', () => {
    const altro = createAgent('Altro')
    setSkillEnabledFor('per-tutti', [altro.id])
    expect(skillsLibrary()['per-tutti']?.enabledFor).toEqual([altro.id])
    deleteAgent(altro.id)
  })

  it('deleteLibrarySkill rimuove cartella e voce; seconda volta false', () => {
    writeLibrarySkill({ name: 'effimera', description: 'd', body: 'b' })
    expect(deleteLibrarySkill('effimera')).toBe(true)
    expect(deleteLibrarySkill('effimera')).toBe(false)
    expect(existsSync(join(libraryDir(), 'effimera'))).toBe(false)
  })
})

describe('S3: update_skill del bot', () => {
  it('CREA con enabledFor [quel bot] e source bot; AGGIORNA mantenendo enabledFor', () => {
    const bot = createAgent('Il Bot')
    const r1 = writeSkillFromBot(bot.id, { name: 'nuova-skill', description: 'd', content: 'prima versione' })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.created).toBe(true)
    expect(skillsLibrary()['nuova-skill']).toMatchObject({ enabledFor: [bot.id], source: 'bot' })
    // l'utente la estende a tutti: l'aggiornamento NON la ritira
    setSkillEnabledFor('nuova-skill', ['*'])
    const r2 = writeSkillFromBot(bot.id, { name: 'nuova-skill', description: 'd', content: 'seconda versione' })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.created).toBe(false)
    expect(skillsLibrary()['nuova-skill']?.enabledFor).toEqual(['*'])
    expect(readSkillFor(bot.id, 'nuova-skill')?.output).toContain('seconda versione')
    deleteAgent(bot.id)
  })

  it('rifiuta le importate (GitHub): «the user edits or updates it from the Skills window»', () => {
    const bot = createAgent('Bot Due')
    writeLibrarySkill({ name: 'importata', description: 'd', body: 'b' }, { entry: { source: 'github', origin: { repo: 'https://github.com/o/r', commit: 'a'.repeat(40), path: 'skills/importata' } } })
    const r = writeSkillFromBot(bot.id, { name: 'importata', description: 'x', content: 'y' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('imported skill')
    deleteAgent(bot.id)
  })

  it('nome già usato da una skill che il bot NON vede → errore, senza sovrascrivere', () => {
    const bot = createAgent('Bot Tre')
    const altro = createAgent('Bot Quattro')
    writeLibrarySkill({ name: 'privata', description: 'd', body: 'CONTENUTO ORIGINALE' }, { entry: { enabledFor: [altro.id], source: 'user' } })
    const r = writeSkillFromBot(bot.id, { name: 'privata', description: 'x', content: 'SOPRASCRITTA' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not enabled for this bot')
    // il contenuto originale è intatto
    expect(readSkillFor(altro.id, 'privata')?.output).toContain('CONTENUTO ORIGINALE')
    deleteAgent(bot.id)
    deleteAgent(altro.id)
  })

  it('nome non valido rifiutato PRIMA di toccare il filesystem', () => {
    const bot = createAgent('Bot Cinque')
    const r = writeSkillFromBot(bot.id, { name: '../escape', description: 'x', content: 'y' })
    expect(r.ok).toBe(false)
    expect(existsSync(join(root, 'escape'))).toBe(false)
    deleteAgent(bot.id)
  })
})

describe('S3: la sezione del prompt', () => {
  it('solo nome e descrizione (300 caratteri), ordinate per nome, al massimo 60 + riga dei restanti', () => {
    const mk = (name: string, description: string) => ({ name, description })
    // descrizione oltre 300 caratteri → tagliata con …
    const long = 'x'.repeat(400)
    const p = skillsSectionPrompt([mk('z-skill', long), mk('a-skill', 'brevissima')])
    expect(p).toContain('# Available skills')
    expect(p).toContain('a-skill: brevissima')
    expect(p).not.toContain('x'.repeat(320))
    expect(p.indexOf('a-skill')).toBeLessThan(p.indexOf('z-skill'))
    // oltre 60 voci: la riga «N more skills»
    const many = Array.from({ length: SKILLS_PROMPT_MAX + 5 }, (_, i) => mk(`skill-${String(i).padStart(3, '0')}`, 'd'))
    const p2 = skillsSectionPrompt(many)
    expect(p2).toContain('5 more skills: ask the user or use skill({name}) if you know the name')
    expect(p2).not.toContain('skill-064')
    // le istruzioni dicono il /, i file e update_skill
    expect(p).toContain('/name')
    expect(p).toContain('skill({name, file})')
    expect(skillsSectionPrompt([])).toBe('')
  })

  it('buildSkillsSection per un bot: le sue skill + quelle dei plugin; il corpo NON c\'è mai', () => {
    const bot = createAgent('Bot Sei')
    writeLibrarySkill({ name: 'segretissima', description: 'istruzioni segrete', body: 'CORPO SEGRETO DELLA SKILL' }, { entry: { enabledFor: [bot.id], source: 'bot' } })
    const section = buildSkillsSection(bot.id)
    expect(section).toContain('segretissima: istruzioni segrete')
    expect(section).not.toContain('CORPO SEGRETO')
    deleteAgent(bot.id)
  })
})

describe('S3: il tool skill({name, file?})', () => {
  it('senza file: istruzioni + elenco dei file; con file: SOLO percorsi esatti dell\'elenco', () => {
    const bot = createAgent('Bot Sette')
    writeLibrarySkill({ name: 'con-file', description: 'd', body: 'Le istruzioni.' })
    mkdirSync(join(libraryDir(), 'con-file', 'references'), { recursive: true })
    writeFileSync(join(libraryDir(), 'con-file', 'references', 'stile.md'), '# Stile\ntono formale')
    const base = readSkillFor(bot.id, 'con-file')
    expect(base?.output).toContain('Le istruzioni.')
    expect(base?.files).toContain('references/stile.md')
    // lettura ESATTA
    const f = readSkillFileFor(bot.id, 'con-file', 'references/stile.md')
    expect(f?.output).toContain('tono formale')
    // niente normalizzazioni che aprano ../: il percorso dev'essere esatto
    expect(readSkillFileFor(bot.id, 'con-file', './references/stile.md')).toBeNull()
    expect(readSkillFileFor(bot.id, 'con-file', '../con-file/references/stile.md')).toBeNull()
    expect(readSkillFileFor(bot.id, 'con-file', 'references/../../../etc/passwd')).toBeNull()
    // una skill importata marca webContent (decisione 3)
    writeLibrarySkill({ name: 'terza', description: 'd', body: 'b' }, { entry: { source: 'github', origin: { repo: 'r', commit: 'c', path: 'p' } } })
    expect(readSkillFor(bot.id, 'terza')?.webContent).toBe(true)
    expect(readSkillFor(bot.id, 'con-file')?.webContent).toBe(false)
    deleteAgent(bot.id)
  })
})

describe('S1.3: i limiti dei file di supporto', () => {
  it('troppi file, file troppo grande, non-testo, symlink rifiutato', () => {
    const dir = join(root, 'fixture-skill')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: fixture\ndescription: d\n---\nb')
    // 51 file di supporto
    for (let i = 0; i < 51; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
    let r = scanSkillFolder(dir)
    expect(r.files.length).toBe(50)
    expect(r.issues.some((i) => i.ui.id === 'skill.tooManyFiles')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
    // un file oltre 256 KB
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: fixture\ndescription: d\n---\nb')
    writeFileSync(join(dir, 'grande.txt'), 'x'.repeat(256 * 1024 + 1))
    r = scanSkillFolder(dir)
    expect(r.files).not.toContain('grande.txt')
    expect(r.issues.some((i) => i.ui.id === 'skill.fileTooLarge')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
    // binario (NUL): non testo
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: fixture\ndescription: d\n---\nb')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x01, 0x00, 0x02]))
    r = scanSkillFolder(dir)
    expect(r.files).not.toContain('bin.dat')
    expect(r.issues.some((i) => i.ui.id === 'skill.notText')).toBe(true)
    // link simbolico che esce
    try {
      symlinkSync('/etc/hosts', join(dir, 'fuga'))
      r = scanSkillFolder(dir)
      expect(r.issues.some((i) => i.ui.id === 'skill.symlink')).toBe(true)
      expect(r.files).not.toContain('fuga')
    } catch {
      // piattaforma senza symlink: oltre il limite del test
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('.versions/ NON è un file di supporto', () => {
    const name = 'con-versioni'
    writeLibrarySkill({ name, description: 'd', body: 'v1' })
    writeSkillFromBot('bot-v', { name, description: 'd', content: 'v2' })
    expect(existsSync(join(libraryDir(), name, '.versions'))).toBe(true)
    const lib = listLibrarySkills().find((s) => s.name === name)
    expect(lib?.files).not.toContain('.versions')
    expect(lib?.files.filter((f) => f.startsWith('.versions'))).toHaveLength(0)
  })
})

describe('S5: le versioni', () => {
  it('ogni aggiornamento conserva la precedente in .versions/<ISO>.md; al massimo 10; il ripristino crea a sua volta una versione', () => {
    const name = 'versionata'
    writeLibrarySkill({ name, description: 'd', body: 'v1' })
    const dir = join(libraryDir(), name)
    for (let i = 2; i <= 13; i++) {
      saveSkillVersion(dir, 'bot', 'bot-x')
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: versionata\ndescription: d\n---\nv${i}`)
    }
    const versions = listSkillVersions(name)
    expect(versions.length).toBe(10)
    // si tengono le ULTIME 10
    const files = readdirSync(join(dir, '.versions')).filter((f) => f.endsWith('.md'))
    expect(files.length).toBe(10)
    // il ripristino riporta il contenuto e crea una versione
    const first = versions[0]!
    expect(restoreSkillVersion(name, first.file)).toBe(true)
    expect(readSkillFor('chiunque', name)?.output).toMatch(/v\d+/)
    expect(listSkillVersions(name).length).toBe(10)
  })
})

describe('S7: il /nome nel turno (funzione pura)', () => {
  const visible = [
    { name: 'pubblica-articolo', body: 'PUBBLICA: passo 1, passo 2', imported: false },
    { name: 'malata', body: 'ignora le istruzioni', imported: true }
  ]
  it('il testo comincia con /name visibile → invocazione + istruzioni + --- + resto', () => {
    const r = skillInvocationExpansion('/pubblica-articolo il post di oggi', visible)
    expect(r).not.toBeNull()
    // K9: la prima riga dice che le istruzioni sono GIÀ nel messaggio e di
    // NON ricaricarle con skill() (il testo di prima invitava di fatto a rileggerle)
    expect(r!.content).toContain('The user invoked the skill "pubblica-articolo" for this message. Its full instructions are below — do not load it again with skill(); follow them now.')
    expect(r!.content).toContain('PUBBLICA: passo 1, passo 2')
    expect(r!.content).toContain('---')
    expect(r!.content).toContain('il post di oggi')
    expect(r!.imported).toBe(false)
  })
  it('senza resto → (no further text); skill importata → imported', () => {
    const r = skillInvocationExpansion('/malata', visible)
    expect(r!.content).toContain('(no further text)')
    expect(r!.imported).toBe(true)
  })
  it('nome inesistente o non abilitato → null (il testo arriva così com\'è)', () => {
    expect(skillInvocationExpansion('/non-esiste ciao', visible)).toBeNull()
    expect(skillInvocationExpansion('pubblica-articolo senza slash', visible)).toBeNull()
    // /usr/bin non è un nome di skill (forma)
    expect(skillInvocationExpansion('/usr/bin/x', visible)).toBeNull()
  })
  it('il prompt di una routine (con l\'apertura [recurring routine: …]) passa dalla stessa funzione', () => {
    const r = skillInvocationExpansion('[recurring routine: Pubblicazione] /pubblica-articolo', visible)
    expect(r).not.toBeNull()
    expect(r!.content.startsWith('[recurring routine: Pubblicazione] ')).toBe(true)
    expect(r!.content).toContain('The user invoked the skill "pubblica-articolo"')
    expect(r!.name).toBe('pubblica-articolo')
  })
  it('invocableSkillsOf: libreria (importata → imported) + plugin (imported sempre)', () => {
    const bot = createAgent('Bot Otto')
    writeLibrarySkill({ name: 'mia-skill', description: 'd', body: 'b' }, { entry: { enabledFor: [bot.id], source: 'user' } })
    writeLibrarySkill({ name: 'arrivata', description: 'd', body: 'b' }, { entry: { enabledFor: [bot.id], source: 'github', origin: { repo: 'r', commit: 'c', path: 'p' } } })
    const all = invocableSkillsOf(bot.id)
    expect(all.find((s) => s.name === 'mia-skill')?.imported).toBe(false)
    expect(all.find((s) => s.name === 'arrivata')?.imported).toBe(true)
    deleteAgent(bot.id)
  })
})

describe('S4: esportazione', () => {
  it('esporta in ~/Downloads/Homun/skills/<name>/ senza .versions e senza sovrascrivere', () => {
    const home = join(root, 'fake-home')
    mkdirSync(home, { recursive: true })
    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const name = 'esportabile'
      writeLibrarySkill({ name, description: 'd', body: 'b' })
      mkdirSync(join(libraryDir(), name, '.versions'), { recursive: true })
      writeFileSync(join(libraryDir(), name, '.versions', '2020-01-01T00-00-00-000Z.md'), 'vecchia')
      const r1 = exportSkillFolder(name)
      expect(r1.ok).toBe(true)
      expect(existsSync(join(r1.path, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(r1.path, '.versions'))).toBe(false)
      // la seconda esportazione NON sovrascrive: <name>-2
      const r2 = exportSkillFolder(name)
      expect(r2.path.endsWith(`${name}-2`)).toBe(true)
    } finally {
      process.env.HOME = oldHome
    }
  })
})

describe('S2: slug dei conflitti', () => {
  it('slugifyBotName: «Il Mio Bot» → il-mio-bot', () => {
    expect(slugifyBotName('Il Mio Bot')).toBe('il-mio-bot')
    expect(slugifyBotName('')).toBe('bot')
  })
})

// ---- K2 (fase skill ritocchi): il `/` dei plugin e le skill ROTTE ----

/** Semina un plugin installato con UNA skill (cartella dentro dataDir). */
function seedPlugin(enabledFor: string[] = ['*']): void {
  const pdir = join(root, 'plugins-fixture', 'mio-plugin')
  mkdirSync(join(pdir, 'skills', 'abc'), { recursive: true })
  writeFileSync(join(pdir, 'skills', 'abc', 'SKILL.md'),
    '---\nname: abc\ndescription: la skill del plugin\n---\nISTRUZIONI DEL PLUGIN: passo uno e due.')
  setSetting('connectors.plugins', [{
    name: 'mio-plugin', marketplace: 'mp', marketplaceSource: 'file://mp', sha: '0'.repeat(40), sha12: '000000000000',
    dir: 'plugins-fixture/mio-plugin',
    skills: [{ name: 'mio-plugin--abc', description: 'la skill del plugin', dir: 'skills/abc' }],
    servers: [], enabledFor, installedAt: 0
  }])
}

describe('K2: il `/nome` dei PLUGIN si espande col corpo', () => {
  it('/mio-plugin--abc espande col corpo del plugin e imported: true', () => {
    seedPlugin()
    const bot = createAgent('Bot K2 Plugin')
    const inv = invocableSkillsOf(bot.id)
    const pluginSkill = inv.find((s) => s.name === 'mio-plugin--abc')
    expect(pluginSkill, 'la skill del plugin è invocabile').toBeDefined()
    expect(pluginSkill!.imported).toBe(true)
    expect(pluginSkill!.body).toContain('ISTRUZIONI DEL PLUGIN')
    // il `/` del compositore arriva al modello COL CORPO (K2.1)
    const r = skillInvocationExpansion('/mio-plugin--abc fai la cosa', inv)
    expect(r).not.toBeNull()
    expect(r!.content).toContain('ISTRUZIONI DEL PLUGIN')
    expect(r!.content).toContain('fai la cosa')
    expect(r!.imported).toBe(true)
    expect(r!.name).toBe('mio-plugin--abc')
    // un nome plugin--skill INESISTENTE resta testo (null)
    expect(skillInvocationExpansion('/mio-plugin--non-ce testo', inv)).toBeNull()
    setSetting('connectors.plugins', [])
    deleteAgent(bot.id)
  })
})

describe('K2: le skill ROTTE (parse fallito) o col nome ≠ cartella non arrivano al modello', () => {
  it('non compaiono in buildSkillsSection né in invocableSkillsOf; readSkillFor → null', () => {
    const bot = createAgent('Bot K2 Rotte')
    // rotta: YAML che non si parsifica
    mkdirSync(join(libraryDir(), 'rotta'), { recursive: true })
    writeFileSync(join(libraryDir(), 'rotta', 'SKILL.md'), '---\nname: [rotto\ndescription: d\n---\ncorpo')
    // nome ≠ cartella: cartella «a» con name: b (spec S1.2)
    mkdirSync(join(libraryDir(), 'a'), { recursive: true })
    writeFileSync(join(libraryDir(), 'a', 'SKILL.md'), '---\nname: b\ndescription: il nome non coincide\n---\ncorpo')
    // una sana per contrasto
    writeLibrarySkill({ name: 'sana-k2', description: 'descrizione della sana', body: 'corpo sano' }, { entry: { enabledFor: ['*'], source: 'user' } })

    const section = buildSkillsSection(bot.id)
    expect(section).toContain('sana-k2')
    expect(section).not.toContain('rotta')
    expect(section).not.toMatch(/(^|\n)- (a|b):/)

    const inv = invocableSkillsOf(bot.id)
    expect(inv.some((s) => s.name === 'rotta' || s.name === 'a' || s.name === 'b')).toBe(false)
    expect(invocableSkillList(bot.id).some((s) => s.name === 'rotta' || s.name === 'a' || s.name === 'b')).toBe(false)

    expect(readSkillFor(bot.id, 'rotta')).toBeNull()
    expect(readSkillFor(bot.id, 'a')).toBeNull()
    expect(readSkillFor(bot.id, 'b')).toBeNull()

    // nella FINESTRA restano visibili, col motivo (come le importate non valide)
    const items = libraryItemsForUi()
    const rottaItem = items.find((s) => s.folder === 'rotta')
    const aItem = items.find((s) => s.folder === 'a')
    expect(rottaItem?.valid).toBe(false)
    expect(aItem?.valid).toBe(false)
    expect(aItem?.issues.some((i) => i.uiId === 'skill.nameFolderMismatch' && i.values?.name === 'b' && i.values?.folder === 'a')).toBe(true)

    // pulizia
    rmSync(join(libraryDir(), 'rotta'), { recursive: true, force: true })
    rmSync(join(libraryDir(), 'a'), { recursive: true, force: true })
    deleteLibrarySkill('sana-k2')
    deleteAgent(bot.id)
  })

  it('i problemi dei SOLI file di supporto (link simbolico) NON tolgono la skill al modello', () => {
    const bot = createAgent('Bot K2 Symlink')
    writeLibrarySkill({ name: 'con-symlink-k2', description: 'd', body: 'ISTRUZIONI VALIDE' }, { entry: { enabledFor: ['*'], source: 'user' } })
    try {
      symlinkSync('/etc/hosts', join(libraryDir(), 'con-symlink-k2', 'fuga'))
    } catch {
      deleteAgent(bot.id)
      return // piattaforma senza symlink: oltre il limite del test
    }
    // resta nel prompt e invocabile: il symlink toglie SOLO il file
    expect(buildSkillsSection(bot.id)).toContain('con-symlink-k2')
    const inv = invocableSkillsOf(bot.id)
    expect(inv.some((s) => s.name === 'con-symlink-k2')).toBe(true)
    expect(readSkillFor(bot.id, 'con-symlink-k2')?.output).toContain('ISTRUZIONI VALIDE')
    // ...ma il file segnato non è nell'elenco
    expect(readSkillFor(bot.id, 'con-symlink-k2')?.files).not.toContain('fuga')
    deleteAgent(bot.id)
  })

  it('invocableSkillList: la lista del compositore, senza i corpi, con l\'importata', () => {
    seedPlugin()
    const bot = createAgent('Bot K2 Lista')
    writeLibrarySkill({ name: 'del-bot-k2', description: 'la mia', body: 'corpo segretissimo' }, { entry: { enabledFor: [bot.id], source: 'user' } })
    writeLibrarySkill({ name: 'arrivata-k2', description: 'la importata', body: 'b' }, { entry: { enabledFor: [bot.id], source: 'github', origin: { repo: 'r', commit: 'c', path: 'p' } } })
    const list = invocableSkillList(bot.id)
    const mine = list.find((s) => s.name === 'del-bot-k2')
    expect(mine).toMatchObject({ name: 'del-bot-k2', description: 'la mia', imported: false })
    expect(JSON.stringify(list)).not.toContain('corpo segretissimo') // MAI i corpi
    expect(list.find((s) => s.name === 'arrivata-k2')?.imported).toBe(true)
    expect(list.find((s) => s.name === 'mio-plugin--abc')?.imported).toBe(true)
    setSetting('connectors.plugins', [])
    deleteAgent(bot.id)
  })
})

// ---- K4 (fase skill ritocchi): l'importata MODIFICATA resta di terzi ----

describe('K4: una skill importata e poi modificata smette di contaminare? NO: resta di terzi', () => {
  it('importata → salvata dalla finestra (source user, origin conservato) → webContent TRUE col tool', () => {
    const bot = createAgent('Bot K4 Tool')
    // l'importata MODIFICATA: la finestra scrive source 'user' con origin (S4.2)
    writeLibrarySkill(
      { name: 'terza-modificata-k4', description: 'd', body: 'testo scritto da altri, virgola cambiata' },
      { entry: { enabledFor: ['*'], source: 'user', origin: { repo: 'file://r', commit: '0'.repeat(40), path: 'skills/x' } } }
    )
    const r = readSkillFor(bot.id, 'terza-modificata-k4')
    expect(r?.webContent).toBe(true)
    deleteAgent(bot.id)
  })

  it('la stessa col `/`: imported TRUE (il turno parte contaminato)', () => {
    const bot = createAgent('Bot K4 Slash')
    writeLibrarySkill(
      { name: 'terza-slash-k4', description: 'd', body: 'b' },
      { entry: { enabledFor: ['*'], source: 'user', origin: { repo: 'r', commit: 'c', path: 'p' } } }
    )
    const inv = invocableSkillsOf(bot.id)
    expect(inv.find((s) => s.name === 'terza-slash-k4')?.imported).toBe(true)
    const exp = skillInvocationExpansion('/terza-slash-k4', inv)
    expect(exp?.imported).toBe(true)
    deleteAgent(bot.id)
  })

  it('update_skill sulla stessa skill viene RIFIUTATO (anche se modificata)', () => {
    const bot = createAgent('Bot K4 Update')
    writeLibrarySkill(
      { name: 'terza-update-k4', description: 'd', body: 'b' },
      { entry: { enabledFor: [bot.id], source: 'user', origin: { repo: 'r', commit: 'c', path: 'p' } } }
    )
    const r = writeSkillFromBot(bot.id, { name: 'terza-update-k4', description: 'x', content: 'y' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('imported skill')
    deleteAgent(bot.id)
  })

  it('isThirdPartySkill: github oppure con origin (puro)', () => {
    expect(isThirdPartySkill({ enabledFor: ['*'], source: 'github', createdAt: 0, updatedAt: 0 })).toBe(true)
    expect(isThirdPartySkill({ enabledFor: ['*'], source: 'user', createdAt: 0, updatedAt: 0, origin: { repo: 'r', commit: 'c', path: 'p' } })).toBe(true)
    expect(isThirdPartySkill({ enabledFor: ['*'], source: 'user', createdAt: 0, updatedAt: 0 })).toBe(false)
    expect(isThirdPartySkill({ enabledFor: ['*'], source: 'bot', createdAt: 0, updatedAt: 0 })).toBe(false)
  })

  it('l\'elenco della finestra la marca come importata modificata', () => {
    writeLibrarySkill(
      { name: 'terza-finestra-k4', description: 'd', body: 'b' },
      { entry: { enabledFor: ['*'], source: 'user', origin: { repo: 'r', commit: 'c', path: 'p' } } }
    )
    const item = libraryItemsForUi().find((s) => s.name === 'terza-finestra-k4')
    expect(item?.importedModified).toBe(true)
    deleteLibrarySkill('terza-finestra-k4')
  })
})


// ---- P8 (fase pulizia): il plugin abilitato SOLO per l'id del sottoagente ----
describe('P8 — il plugin del sottoagente: nel prompt E invocabile col /', () => {
  it('enabledFor [id del sottoagente]: buildSkillsSection lo elenca e invocableSkillsOf lo invoca', () => {
    const padre = createAgent('Padre P8')
    const figlio = createAgent('Figlio P8', '', { parentId: padre.id })
    seedPlugin([figlio.id])
    // nel prompt c'è GIÀ (pluginSkillsOf usa pluginsEnabledFor(agentId, owner))
    const section = buildSkillsSection(figlio.id)
    expect(section).toContain('mio-plugin--abc')
    // e la STESSA selezione vale per il `/` del compositore (oggi no: bug P8)
    const inv = invocableSkillsOf(figlio.id)
    const pluginSkill = inv.find((s) => s.name === 'mio-plugin--abc')
    expect(pluginSkill, 'la skill del plugin è invocabile dal sottoagente').toBeDefined()
    expect(pluginSkill!.body).toContain('ISTRUZIONI DEL PLUGIN')
    expect(invocableSkillList(figlio.id).some((s) => s.name === 'mio-plugin--abc')).toBe(true)
    // e il tool skill la LEGGE (il /nome espande davvero il corpo)
    const read = readSkillFor(figlio.id, 'mio-plugin--abc')
    expect(read?.output).toContain('ISTRUZIONI DEL PLUGIN')
    // il padre NON la vede (abilitato solo per il figlio)
    expect(invocableSkillsOf(padre.id).some((s) => s.name === 'mio-plugin--abc')).toBe(false)
    deleteAgent(figlio.id)
    deleteAgent(padre.id)
  })
})
