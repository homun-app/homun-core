// Test degli RPC della libreria skill (fase skill ritocchi):
//   K2  skills:invocable(agentId) — la lista del compositore senza i corpi;
//   K3  la RINOMINA da skills:save conserva enabledFor/origin/createdBy e la
//       voce vecchia sparisce; il nome già usato è «Esiste già una skill…»;
//   K5  ogni RPC che costruisce un path col nome rifiuta '..','../x','a/b',''
//       con l'errore umano e SENZA toccare il filesystem (HOME finta).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-skillsrpc-test-'))
const { setDataDir, dataDir, setSetting } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
const { libraryItemsForUi } = await import('../../main/agent/skills')

const emit = (): void => undefined
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as never)

beforeAll(() => {
  setDataDir(TMP)
  dataDir()
  // la lingua dell'interfaccia: gli errori umani si assertscono in italiano
  setSetting('ui.activeLanguage', 'it')
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('K2: skills:invocable', () => {
  it('la lista del compositore SENZA i corpi (nome, descrizione, imported)', () => {
    api['skills:save']([{ name: 'una-skill-rpc', description: 'descrizione breve', body: 'CORPO CHE NON DEVE USCIRE' }])
    const r = api['skills:invocable']!(['agent_chiunque']) as Array<{ name: string; description: string; imported: boolean }>
    const hit = r.find((s) => s.name === 'una-skill-rpc')
    expect(hit).toMatchObject({ name: 'una-skill-rpc', description: 'descrizione breve', imported: false })
    expect(JSON.stringify(r)).not.toContain('CORPO CHE NON DEVE USCIRE')
    // una importata è marcata (il renderer la può etichettare)
    setSetting('skills.library', { 'una-skill-rpc': { enabledFor: ['*'], source: 'github', origin: { repo: 'r', commit: 'c', path: 'p' }, createdAt: 0, updatedAt: 0 } })
    expect((api['skills:invocable']!(['agent_chiunque']) as Array<{ imported: boolean }>).find((s) => (s as { name?: string }).name === 'una-skill-rpc')?.imported).toBe(true)
  })
})

describe('K3: la rinomina da skills:save', () => {
  it('conserva enabledFor, origin e createdBy; la voce vecchia sparisce', () => {
    // la skill su disco + la voce nel setting (enabledFor SOLO agent_a, con
    // origin e createdBy: quello che l'import e i bot scrivono davvero)
    mkdirSync(join(dataDir(), 'skills', 'solo-alfa'), { recursive: true })
    writeFileSync(join(dataDir(), 'skills', 'solo-alfa', 'SKILL.md'), '---\nname: solo-alfa\ndescription: d\n---\ncorpo')
    setSetting('skills.library', {
      'solo-alfa': {
        enabledFor: ['agent_a'], source: 'user', createdBy: 'agent_a',
        origin: { repo: 'file://repo-di-prova', commit: 'a'.repeat(40), path: 'skills/solo-alfa' },
        createdAt: 111, updatedAt: 111
      }
    })
    const lib0 = libraryItemsForUi().find((s) => s.name === 'solo-alfa')
    expect(lib0).toBeDefined()
    // la finestra NON manda enabledFor sulle modifiche (come il codice vero)
    const r = api['skills:save']!([{ folder: 'solo-alfa', name: 'solo-alfa-rinominata', description: 'd', body: 'b' }]) as { ok: boolean; name?: string }
    expect(r.ok).toBe(true)
    const items = libraryItemsForUi()
    const nuova = items.find((s) => s.name === 'solo-alfa-rinominata')
    expect(nuova?.enabledFor).toEqual(['agent_a'])
    expect(nuova?.origin).toMatchObject({ repo: 'file://repo-di-prova' })
    expect(nuova?.createdBy).toBe('agent_a')
    // la voce VECCHIA non esiste più (né nel setting né su disco)
    expect(items.some((s) => s.name === 'solo-alfa' || s.folder === 'solo-alfa')).toBe(false)
    expect(existsSync(join(dataDir(), 'skills', 'solo-alfa'))).toBe(false)
  })

  it('il nome già usato da UN\'ALTRA skill → «Esiste già una skill con questo nome»', () => {
    api['skills:save']([{ name: 'occupata-k3', description: 'd', body: 'b' }])
    expect(() =>
      api['skills:save']!([{ folder: 'solo-alfa-rinominata', name: 'occupata-k3', description: 'd', body: 'b' }])
    ).toThrowError(/Esiste già una skill con questo nome/)
  })
})

describe('K5: i RPC col nome rifiutano path traversal', () => {
  // HOME finta: se l'RPC tocca il filesystem comunque (exportSkillFolder crea
  // ~/Downloads/Homun), il test lo vede
  let fakeHome = ''
  beforeAll(() => {
    fakeHome = mkdtempSync(join(TMP, 'home-finto-'))
    process.env.HOME = fakeHome
  })
  afterAll(() => {
    process.env.HOME = undefined
    rmSync(fakeHome, { recursive: true, force: true })
  })

  // [canale, argomenti da passare col nome avvelenato]
  const CASES: Array<[string, (bad: string) => unknown[]]> = [
    ['skills:get', (n) => [n]],
    ['skills:versions', (n) => [n]],
    ['skills:restore-version', (n) => [n, '2020-01-01T00-00-00-000Z.md']],
    ['skills:export', (n) => [n]],
    ['skills:set-enabled-for', (n) => [n, ['*']]],
    ['skills:read-file', (n) => [n, 'references/x.md']],
    ['skills:github-update-preview', (n) => [n]],
    ['skills:github-update-apply', (n) => ['skill-update-inesistente', n]]
  ]
  const BAD_NAMES = ['..', '../x', 'a/b', '']

  for (const [channel, mkArgs] of CASES) {
    for (const bad of BAD_NAMES) {
      it(`${channel}(${JSON.stringify(bad)}) → errore umano di nome non valido`, async () => {
        await expect(
          (async () => api[channel]!(mkArgs(bad)))()
        ).rejects.toThrowError(/Nome non valido/)
        // niente tocche al filesystem: ~/Downloads/Homun NON viene creato
        expect(existsSync(join(fakeHome, 'Downloads', 'Homun'))).toBe(false)
        expect(existsSync(join(fakeHome, 'Downloads'))).toBe(false)
      })
    }
  }
})
