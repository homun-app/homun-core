// B2 (fase beta.4): update_self — il bot aggiorna il PROPRIO profilo:
// description (una riga), role (le istruzioni) e name (solo se è ancora
// quello scritto nel dialogo e l'utente ne ha chiesto un altro). Mai
// l'aspetto, il modello o i permessi; un agentId altrui si rifiuta. Ogni
// modifica lascia in chat la riga di sistema «Ha aggiornato il suo profilo»
// (il loop la scrive dal meta.selfUpdate, come le automation). Store reale
// su directory temporanea, nessun LLM.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, createAgent, getAgent, getEntries } = await import('../../store/db')
const { executeTool } = await import('../tools')

let root: string
const SELF = 'agent_self'
const OTHER = 'agent_other'
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-updself-test-'))
  setDataDir(root)
  dataDir()
  const { openMemoryEngine } = await import('../../memory/engine')
  const st = await openMemoryEngine({ dataDir: root })
  if (!st.available) throw new Error('motore Engramma non disponibile nei test: ' + st.error)
  createAgent('Prova', '', { id: SELF, birthName: 'Prova' })
  createAgent('Altro', '', { id: OTHER })
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../memory/engine')
  await closeMemoryEngine()
  rmSync(root, { recursive: true, force: true })
})

const eventsOf = (agentId: string) =>
  getEntries(agentId).filter((e) => e.kind === 'event' && (e.meta as { selfUpdate?: unknown } | null)?.selfUpdate !== undefined)

describe('B2: update_self — il tool del proprio profilo', () => {
  it('description e role aggiornano il PROPRIO profilo; mai aspetto, modello o permessi', async () => {
    const { output } = await executeTool(SELF, 'update_self', {
      description: 'Riassunto del mattino',
      role: 'Ogni mattina alle 8 prepara il riassunto delle notizie di tecnologia.'
    })
    expect(output).toMatch(/updated/i)
    const a = getAgent(SELF)!
    expect(a.description).toContain('Riassunto del mattino')
    expect(a.description).toContain('riassunto delle notizie')
    expect(a.model).toBeNull()
    expect(a.avatar).toBeNull()
  })

  it('un agentId ALTRUI si rifiuta: il profilo che cambia è solo il proprio', async () => {
    const { output } = await executeTool(SELF, 'update_self', { agentId: OTHER, description: 'hack' })
    expect(output).toMatch(/only your own profile|your own/i)
    expect(getAgent(OTHER)!.description).toBe('')
  })

  it('il nome cambia SOLO se è ancora quello scritto nel dialogo', async () => {
    // name === birthName ('Prova') → il cambio passa
    await executeTool(SELF, 'update_self', { name: 'Notizie Tech' })
    expect(getAgent(SELF)!.name).toBe('Notizie Tech')
    // ora name ≠ birthName → niente secondo cambio
    const { output } = await executeTool(SELF, 'update_self', { name: 'Altro Nome' })
    expect(output).toMatch(/keep your name|name/i)
    expect(getAgent(SELF)!.name).toBe('Notizie Tech')
    // un bot NON nato dal dialogo (birthName assente) non si rinomina da solo
    const { output: noBirth } = await executeTool(OTHER, 'update_self', { name: 'Ribattezzato' })
    expect(noBirth).toMatch(/keep your name|name/i)
    expect(getAgent(OTHER)!.name).toBe('Altro')
  })

  it('niente da aggiornare → errore leggibile, nessuna riga', async () => {
    const { output } = await executeTool(SELF, 'update_self', {})
    expect(output).toMatch(/nothing to update|description, role or name/i)
    expect(eventsOf(SELF)).toHaveLength(0)
  })

  it('il meta.selfUpdate del result porta i campi cambiati (il loop ne fa la riga di sistema)', async () => {
    const { meta } = await executeTool(SELF, 'update_self', { description: 'una riga', role: 'le istruzioni' })
    expect((meta as { selfUpdate?: { fields: string[] } }).selfUpdate?.fields.sort()).toEqual(['description', 'role'])
    // la riga di sistema la scrive il LOOP (come le automation): qui il tool
    // deve solo riportarla nel meta — e non aggiunge entry da solo
    expect(eventsOf(SELF)).toHaveLength(0)
  })
})
