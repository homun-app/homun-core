// Test della validazione del catalogo connettori (fase 5): schema, URL https,
// docsUrl presente per ogni voce; il catalogo reale passa la validazione e
// ogni voce con registrazione statica dichiara i suoi scope.
import { describe, expect, it } from 'vitest'
import { validateCatalog, loadCatalog, searchCatalog, connectorStatusLine, connectorsInstructionsSection, connectorInstructionsFromSettings } from '../index'

const base = {
  id: 'test',
  name: 'Test',
  logo: '🔧',
  mcpUrl: 'https://mcp.test.com/mcp',
  clientRegistration: 'dynamic',
  docsUrl: 'https://test.com/docs',
  notes: 'fonte: https://test.com/docs'
}

describe('validateCatalog', () => {
  it('voce valida → nessun errore', () => {
    expect(validateCatalog([base])).toEqual([])
  })

  it('id non valido o duplicato', () => {
    expect(validateCatalog([{ ...base, id: 'Non Valid0' }])[0]).toContain('id')
    expect(validateCatalog([base, { ...base, name: 'Altro' }]).join(' ')).toContain('duplicato')
  })

  it('mcpUrl deve essere https', () => {
    expect(validateCatalog([{ ...base, mcpUrl: 'http://mcp.test.com' }])[0]).toContain('https')
    expect(validateCatalog([{ ...base, mcpUrl: 'notaurl' }]).length).toBeGreaterThan(0)
  })

  it('docsUrl obbligatoria e https (la fonte ufficiale è citata)', () => {
    expect(validateCatalog([{ ...base, docsUrl: '' }])[0]).toContain('docsUrl')
    expect(validateCatalog([{ ...base, docsUrl: 'http://x' }])[0]).toContain('docsUrl')
  })

  it('clientRegistration solo dynamic|static; scopes array di stringhe', () => {
    expect(validateCatalog([{ ...base, clientRegistration: 'magic' }])[0]).toContain('clientRegistration')
    expect(validateCatalog([{ ...base, scopes: ['a', 3] }])[0]).toContain('scopes')
  })
})

describe('catalogo reale', () => {
  it('loadCatalog passa la validazione', () => {
    const c = loadCatalog()
    expect(c.length).toBeGreaterThanOrEqual(6)
    expect(validateCatalog(c)).toEqual([])
  })

  it('ogni voce porta la fonte ufficiale nelle notes (URL http(s))', () => {
    for (const e of loadCatalog()) {
      expect(e.notes, e.id).toMatch(/https:\/\/\S+/)
    }
  })
})

describe('search_connectors (puro)', () => {
  const cat = loadCatalog()
  it('query vuota → tutto; query a parole → match su nome/id/note', () => {
    expect(searchCatalog(cat, '').length).toBe(cat.length)
    const mail = searchCatalog(cat, 'gmail')
    expect(mail.some((e) => e.id === 'gmail')).toBe(true)
    expect(searchCatalog(cat, 'issue linear').some((e) => e.id === 'linear')).toBe(true)
    expect(searchCatalog(cat, 'zzz-inesistente')).toEqual([])
  })

  it('connectorStatusLine riporta nome, id e stato', () => {
    const line = connectorStatusLine(cat[0]!, { status: 'connected', disabledTools: [], instructions: '' })
    expect(line).toContain(cat[0]!.id)
    expect(line).toContain('connected')
  })
})

describe('istruzioni per connettore (mcpCustomInstructionsByServerId)', () => {
  it('solo i server connessi con istruzioni non vuote entrano nella sezione', () => {
    const states: Record<string, import('../index').ConnectorState> = {
      gmail: { status: 'connected', disabledTools: [], instructions: 'Usa solo l\'account lavoro.' },
      linear: { status: 'connected', disabledTools: [], instructions: '' },
      notion: { status: 'needs_auth', disabledTools: [], instructions: 'istruzioni ignorate' }
    }
    const out = connectorInstructionsFromSettings(
      [
        { name: 'Gmail', catalogId: 'gmail' },
        { name: 'Linear', catalogId: 'linear' },
        { name: 'Notion', catalogId: 'notion' },
        { name: 'Manuale', catalogId: undefined }
      ],
      states
    )
    expect(out).toContain('# Connector instructions')
    expect(out).toContain('## Gmail')
    expect(out).toContain('Usa solo l\'account lavoro.')
    expect(out).not.toContain('## Linear')       // connesso ma senza istruzioni
    expect(out).not.toContain('## Notion')       // non connesso
    expect(connectorsInstructionsSection([])).toBe('')
  })
})
