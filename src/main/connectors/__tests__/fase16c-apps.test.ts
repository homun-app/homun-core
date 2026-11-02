// Fase 16c (C4): il catalogo ha categoria e tagline IT/EN per ogni voce; la
// ricerca del registro (registrySearchRows) deduplica come search_connectors
// e torna SOLO righe «dal registro». Nessuna rete: fetchRegistry iniettato.
import { describe, expect, it } from 'vitest'
import catalogJson from '../catalog.json'
import { loadCatalog, validateCatalog } from '../index'
import { registrySearchRows, type RegistrySearchDeps } from '../apps-search'
import type { RegistryEntry } from '../registry'

const CATEGORIES = ['mail-calendar', 'documents', 'development', 'communication']

describe('il catalogo dei connettori (C4)', () => {
  it('OGNI voce ha category valida e tagline {it, en} non vuote', () => {
    expect(catalogJson.length).toBeGreaterThan(0)
    for (const entry of catalogJson as Array<Record<string, unknown>>) {
      expect(CATEGORIES).toContain(entry.category)
      const tagline = entry.tagline as { it?: string; en?: string }
      expect(tagline?.it?.trim().length).toBeGreaterThan(0)
      expect(tagline?.en?.trim().length).toBeGreaterThan(0)
    }
    // e il validatore ufficiale è d'accordo
    expect(validateCatalog(catalogJson)).toEqual([])
    expect(loadCatalog()).toHaveLength(catalogJson.length)
  })

  it('le categorie della mappa della spec: gmail/gcalendar posta, gdrive/notion documenti, il resto sviluppo', () => {
    const byId = Object.fromEntries((catalogJson as Array<{ id: string; category: string }>).map((e) => [e.id, e.category]))
    expect(byId.gmail).toBe('mail-calendar')
    expect(byId.gcalendar).toBe('mail-calendar')
    expect(byId.gdrive).toBe('documents')
    expect(byId.notion).toBe('documents')
    expect(byId.linear).toBe('development')
    expect(byId.cloudflare).toBe('development')
  })

  it('nessuna voce inventata: Slack e 1Password della tavola NON ci sono', () => {
    const ids = (catalogJson as Array<{ id: string }>).map((e) => e.id)
    expect(ids).not.toContain('slack')
    expect(ids).not.toContain('1password')
  })
})

describe('registrySearchRows (C4): le righe «dal registro»', () => {
  const regEntry = (name: string, url: string): RegistryEntry => ({
    server: { name, description: `descrizione di ${name}`, remotes: [{ type: 'http', url }] }
  }) as unknown as RegistryEntry

  it('sotto 2 caratteri nessuna chiamata; le righe tornano col nome corto e la fiducia', async () => {
    let calls = 0
    const rows = await registrySearchRows('a', {
      fetchRegistry: async () => { calls++; return [] }
    })
    expect(rows).toEqual([])
    expect(calls).toBe(0)

    const rows2 = await registrySearchRows('finto server', {
      fetchRegistry: async () => [regEntry('mcp/finto-server', 'https://finto.example.com/mcp')]
    })
    expect(rows2).toHaveLength(1)
    expect(rows2[0]).toMatchObject({ name: 'finto-server', trustKind: 'unverified' })
  })

  it('la deduplica con il catalogo resta: una voce del registro il cui URL è nel catalogo NON compare', async () => {
    // l'mcpUrl di gmail nel catalogo: https://gmailmcp.googleapis.com/mcp/v1
    const rows = await registrySearchRows('gmail', {
      fetchRegistry: async () => [regEntry('google/gmail', 'https://gmailmcp.googleapis.com/mcp/v1')]
    })
    expect(rows).toEqual([])
  })
})
