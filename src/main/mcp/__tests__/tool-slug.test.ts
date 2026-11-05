// Fase mcp-setup ritocchi (R1): il prefisso degli strumenti è STABILE e UNICO,
// separato dal nome mostrato. Tutto PURO: lo slug di un server nuovo (taglio a
// 24, -2/-3 sulle collisioni — contano i server del catalogo e «composio»), il
// fallback per i server di prima e il ROUTING di callTool per toolSlug (la
// collisione catalogo Notion + registro «Notion» non instrada più sul primo).
import { describe, expect, it } from 'vitest'
import { assignToolSlug, serverOfToolName, slug, toolSlugKeeping, toolSlugOf, TOOL_SLUG_MAX } from '../slug'
import type { McpServerConfig } from '../index'

const server = (over: Partial<McpServerConfig>): McpServerConfig => ({
  id: 'x', name: 'X', transport: 'http', enabled: true, ...over
})

describe('toolSlugOf: il prefisso stabile (R1)', () => {
  it('cfg.toolSlug vince; senza campo vale slug(cfg.name) (i server del catalogo)', () => {
    expect(toolSlugOf({ name: 'Notion', toolSlug: 'notion-2' })).toBe('notion-2')
    expect(toolSlugOf({ name: 'Notion' })).toBe('notion')
  })
})

describe('assignToolSlug: slug del titolo, taglio a 24, -2 sulle collisioni (R1)', () => {
  it('nessun altro server: slug del titolo', () => {
    expect(assignToolSlug('Mattermost', [])).toBe('mattermost')
  })
  it('il nome completo mcp__<slug>__<tool> deve stare nei 64 dei provider: taglio a 24', () => {
    const long = 'un titolo di server molto lungo che supera di gran lunga i ventiquattro caratteri'
    const s = assignToolSlug(long, [])
    expect(s.length).toBeLessThanOrEqual(TOOL_SLUG_MAX)
    expect(s).toBe(slug(long).slice(0, TOOL_SLUG_MAX))
    // 5 (mcp__) + 24 + 2 (__) lasciano 33 per il nome dello strumento
    expect(`mcp__${s}__un-nome-di-strumento-lungo-33-ca`.length).toBeLessThanOrEqual(64)
  })
  it('slug già usato da un altro server → -2, -3… (contano i server del catalogo per NOME)', () => {
    const catalogNotion = [server({ id: 'notion', name: 'Notion', catalogId: 'notion' })]
    expect(assignToolSlug('Notion', catalogNotion)).toBe('notion-2')
    const ancheIlSecondo = [...catalogNotion, server({ id: 'r1', name: 'Notion', toolSlug: 'notion-2' })]
    expect(assignToolSlug('Notion', ancheIlSecondo)).toBe('notion-3')
  })
  it('«composio» è RISERVATO (il prefisso storico del server Composio senza catalogo)', () => {
    expect(assignToolSlug('Composio', [])).toBe('composio-2')
  })
  it('toolSlugKeeping: una reinstallazione mantiene lo slug CHE HA GIÀ (mai cambiato)', () => {
    const existing = [server({ id: 'a', name: 'Mattermost', toolSlug: 'mattermost' })]
    expect(toolSlugKeeping(existing, 'a', 'Mattermost rinominato')).toBe('mattermost')
    // un server NUOVO non ruba lo slug di chi c'è già (se stesso non conta)
    expect(toolSlugKeeping(existing, 'altro', 'Mattermost')).toBe('mattermost-2')
  })
})

describe('serverOfToolName: il routing per toolSlug (R1)', () => {
  // la collisione VERA della verifica: il server del catalogo Notion
  // (name «Notion») e la voce del registro com.notion/mcp (titolo «Notion»)
  const catalogNotion = server({ id: 'notion', name: 'Notion', catalogId: 'notion' })
  const registryNotion = server({ id: 'registry-com-notion-mcp-1a2b3c4d', name: 'Notion', toolSlug: 'notion-2', source: { kind: 'registry', name: 'com.notion/mcp' } })
  const servers = [catalogNotion, registryNotion]

  it('i due prefissi sono DIVERSI: il registro riceve -2 quando il catalogo c\'è già', () => {
    expect(assignToolSlug('Notion', [catalogNotion])).toBe('notion-2')
    expect(toolSlugOf(catalogNotion)).not.toBe(toolSlugOf(registryNotion))
  })
  it('callTool instrada ciascuno sul SUO server (non più «il primo con quello slug»)', () => {
    expect(serverOfToolName(servers, 'mcp__notion__notion_search')?.id).toBe('notion')
    expect(serverOfToolName(servers, 'mcp__notion-2__notion_search')?.id).toBe(registryNotion.id)
    // il nome del server NON c'entra più: raddoppiare i «Notion» non confonde
    expect(serverOfToolName([...servers, server({ id: 'terzo', name: 'Notion', toolSlug: 'notion-3' })], 'mcp__notion-2__x')?.id).toBe(registryNotion.id)
  })
  it('un server DISABILITATO non risponde al routing (come il callTool di oggi)', () => {
    expect(serverOfToolName([server({ ...catalogNotion, enabled: false }), registryNotion], 'mcp__notion__notion_search')).toBeUndefined()
  })
  it('nomi non MCP o malformati: nessun server', () => {
    expect(serverOfToolName(servers, 'composio__gmail__GMAIL_SEND_EMAIL')).toBeUndefined()
    expect(serverOfToolName(servers, 'mcp__notion')).toBeUndefined()
  })
})
