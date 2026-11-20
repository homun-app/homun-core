// E1 (fase mcp-env): il PATH dei comandi dei server stdio MANUALI. Un'app
// aperta dal Finder ha un PATH ridotto e npx/node installati con fnm, nvm o
// Homebrew spesso non si trovano: se il comando non è un percorso assoluto si
// cerca anche nei posti noti — e se NON c'è, l'errore lo dice IN CHIARO.
// Nessuna shell di login, mai. Qui la parte PURA (fs finti).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { resolveServerCommand, knownCommandDirs } from '../command-path'
import { setSetting } from '../../store/db'

beforeAll(() => { setSetting('ui.activeLanguage', 'it') })
afterAll(() => { setSetting('ui.activeLanguage', 'en') })

/** Un fs FINTO: esistono solo i percorsi del set. */
const fakeFs = (existing: Set<string>) => ({
  existsSync: (p: string) => existing.has(p),
  readdirSync: (p: string) => { throw new Error('non usato: ' + p) }
})

const HOME = '/Users/prova'

describe('E1: resolveServerCommand — il PATH ridotto del Finder non ferma il server', () => {
  it('«npx» risolto dal PATH finto quando c\'è', () => {
    const r = resolveServerCommand('npx', {
      ...fakeFs(new Set(['/usr/bin/npx'])),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r).toEqual({ command: '/usr/bin/npx' })
  })

  it('«npx» risolto da fnm (~/.local/share/fnm/aliases/default/bin) col PATH VUOTO', () => {
    const fnm = `${HOME}/.local/share/fnm/aliases/default/bin`
    const r = resolveServerCommand('npx', {
      ...fakeFs(new Set([`${fnm}/npx`])),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r).toEqual({ command: `${fnm}/npx` })
  })

  it('«node» risolto da nvm (~/.nvm/versions/node/*/bin): la versione PIÙ ALTA vince', () => {
    const nvm = `${HOME}/.nvm/versions/node`
    const r = resolveServerCommand('node', {
      existsSync: (p) => p === `${nvm}/v22.11.0/bin/node`,
      readdirSync: (p: string) => (p === nvm ? ['v20.1.0', 'v22.11.0', 'v22.9.0'] : []),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r).toEqual({ command: `${nvm}/v22.11.0/bin/node` })
  })

  it('«npx» risolto da Homebrew (/opt/homebrew/bin) e poi /usr/local/bin', () => {
    const r1 = resolveServerCommand('npx', {
      ...fakeFs(new Set(['/opt/homebrew/bin/npx'])),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r1).toEqual({ command: '/opt/homebrew/bin/npx' })
    const r2 = resolveServerCommand('npx', {
      ...fakeFs(new Set(['/usr/local/bin/npx'])),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r2).toEqual({ command: '/usr/local/bin/npx' })
  })

  it('il PATH viene PRIMA dei posti noti', () => {
    const r = resolveServerCommand('node', {
      ...fakeFs(new Set(['/usr/bin/node', '/opt/homebrew/bin/node'])),
      home: HOME,
      envPath: '/usr/bin:/bin'
    })
    expect(r).toEqual({ command: '/usr/bin/node' })
  })

  it('comando assente dappertutto → l\'errore CHIARO col nome del comando', () => {
    const r = resolveServerCommand('npx', { ...fakeFs(new Set()), home: HOME, envPath: '/usr/bin:/bin' })
    expect('error' in r && r.error).toBe('comando "npx" non trovato: usa il percorso completo')
  })

  it('un percorso ASSOLUTO resta così com\'è (nessuna risoluzione)', () => {
    const r = resolveServerCommand(`${HOME}/.local/share/fnm/aliases/default/bin/npx`, {
      ...fakeFs(new Set()),
      home: HOME,
      envPath: ''
    })
    expect(r).toEqual({ command: `${HOME}/.local/share/fnm/aliases/default/bin/npx` })
  })

  it('un percorso RELATIVO (./x, ../x) resta così com\'è', () => {
    for (const rel of ['./server.js', '../bin/server']) {
      expect(resolveServerCommand(rel, { ...fakeFs(new Set()), home: HOME, envPath: '' }))
        .toEqual({ command: rel })
    }
  })

  it('knownCommandDirs: i quattro posti noti nell\'ordine (fnm, nvm, homebrew, local)', () => {
    expect(knownCommandDirs(HOME, (p: string) => (p === `${HOME}/.nvm/versions/node` ? ['v22.0.0'] : [])))
      .toEqual([
        `${HOME}/.local/share/fnm/aliases/default/bin`,
        `${HOME}/.nvm/versions/node/v22.0.0/bin`,
        '/opt/homebrew/bin',
        '/usr/local/bin'
      ])
  })
})
