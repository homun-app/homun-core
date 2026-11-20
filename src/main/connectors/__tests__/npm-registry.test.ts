// E4 (fase mcp-env): il registro npm, SOLA LETTURA via daemon — parse PURI
// sulle risposte vere (packument + download), la versione SEMPRE fissata
// (mai latest a ogni avvio: se il bot non la dà, si risolve l'ultima stabile
// UNA volta e la si fissa), fetch iniettabile (nessuna rete nei test).
import { describe, expect, it } from 'vitest'
import {
  parseNpmServerId, npmPackumentUrl, npmDownloadsUrl, parseNpmPackument, parseNpmDownloads, fetchNpmPackageInfo
} from '../npm-registry'

const PACKUMENT = {
  'dist-tags': { latest: '2.3.4' },
  time: { '2.3.4': '2026-11-02T10:00:00.000Z', '2.3.3': '2026-10-01T10:00:00.000Z' },
  versions: { '2.3.4': {}, '2.3.3': {} },
  author: { name: 'Donach' },
  maintainers: [{ name: 'donach' }, { name: 'homun-bot' }]
}
const DOWNLOADS = { downloads: 42017 }

describe('E4: parseNpmServerId — npm:<pacchetto>[@<versione>], mai latest', () => {
  it('nome semplice (scoped compreso) e nome@versione', () => {
    expect(parseNpmServerId('npm:@donach/mattermost-mcp')).toEqual({ kind: 'npm', name: '@donach/mattermost-mcp' })
    expect(parseNpmServerId('npm:@donach/mattermost-mcp@1.2.3')).toEqual({ kind: 'npm', name: '@donach/mattermost-mcp', version: '1.2.3' })
    expect(parseNpmServerId('npm:mattermost-mcp@0.1.0')).toEqual({ kind: 'npm', name: 'mattermost-mcp', version: '0.1.0' })
  })

  it('«latest» e le tag VIETATE: la versione si FISSA, non si insegna', () => {
    expect('error' in parseNpmServerId('npm:x@latest')).toBe(true)
    expect('error' in parseNpmServerId('npm:x@*')).toBe(true)
  })

  it('npm: senza nome, o prefisso diverso → errore', () => {
    expect('error' in parseNpmServerId('npm:')).toBe(true)
    expect('error' in parseNpmServerId('pypi:x')).toBe(true)
  })
})

describe('E4: gli URL del registro (sola lettura, host fissi)', () => {
  it('packument e download settimanale', () => {
    expect(npmPackumentUrl('@donach/mattermost-mcp')).toBe('https://registry.npmjs.org/@donach%2Fmattermost-mcp')
    expect(npmDownloadsUrl('mattermost-mcp')).toBe('https://api.npmjs.org/downloads/point/last-week/mattermost-mcp')
  })
})

describe('E4: parseNpmPackument — la versione si FISSA a quella stabile', () => {
  it('senza versione richiesta → l\'ultima stabile (dist-tags.latest), con la sua data', () => {
    const r = parseNpmPackument(PACKUMENT)
    expect(r).toMatchObject({ version: '2.3.4', publishedAt: '2026-11-02T10:00:00.000Z', author: 'Donach', maintainers: ['donach', 'homun-bot'] })
  })

  it('versione richiesta → QUELLA (con la sua data); inesistente → errore chiaro', () => {
    expect(parseNpmPackument(PACKUMENT, '2.3.3')).toMatchObject({ version: '2.3.3', publishedAt: '2026-10-01T10:00:00.000Z' })
    const bad = parseNpmPackument(PACKUMENT, '9.9.9')
    expect('error' in bad && bad.error).toMatch(/9\.9\.9/)
  })

  it('packument rotto (senza dist-tags o versions) → errore, mai un crash', () => {
    expect('error' in parseNpmPackument({ versions: {} })).toBe(true)
    expect('error' in parseNpmPackument(null)).toBe(true)
  })
})

describe('E4: fetchNpmPackageInfo — packument + download, fetch iniettabile', () => {
  it('versione assente dall\'id → FISSATA a latest UNA volta (nel risultato, per la card)', async () => {
    const r = await fetchNpmPackageInfo('@donach/mattermost-mcp', undefined, {
      fetchOutcome: async (url) => ({
        ok: true as const,
        text: url.includes('downloads') ? JSON.stringify(DOWNLOADS) : JSON.stringify(PACKUMENT),
        contentType: 'application/json', finalUrl: url, downloadedBytes: 10, status: 200, elapsedMs: 1
      })
    })
    expect(r).toMatchObject({ name: '@donach/mattermost-mcp', version: '2.3.4', weeklyDownloads: 42017, author: 'Donach', publishedAt: '2026-11-02T10:00:00.000Z' })
  })

  it('versione data → rispettata e verificata', async () => {
    const r = await fetchNpmPackageInfo('@donach/mattermost-mcp', '2.3.3', {
      fetchOutcome: async (url) => ({ ok: true as const, text: JSON.stringify(PACKUMENT), contentType: 'application/json', finalUrl: url, downloadedBytes: 10, status: 200, elapsedMs: 1 })
    })
    expect(r.version).toBe('2.3.3')
  })

  it('packument introvabile (404) → errore leggibile', async () => {
    const r = await fetchNpmPackageInfo('pacchetto-che-non-esiste', undefined, {
      fetchOutcome: async () => ({ ok: false as const, reason: 'HTTP 404', status: 404 })
    }).catch((e: Error) => e)
    expect(String(r)).toMatch(/npm registry/)
  })
})

describe('E4: parseNpmDownloads', () => {
  it('numero o 0 (mai crash)', () => {
    expect(parseNpmDownloads({ downloads: 7 })).toBe(7)
    expect(parseNpmDownloads({})).toBe(0)
    expect(parseNpmDownloads(null)).toBe(0)
  })
})
