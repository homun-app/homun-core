// Test dell'aspetto predefinito dei bot (fase 16, U2): stabilità dell'hash,
// principale = Creatura c1, distribuzione delle famiglie su 1000 id e
// validazione dell'avatar di agents:update.
import { describe, expect, it } from 'vitest'
import { defaultAvatar, avatarValidationError, avatarOf, fnv1a, BOT_FAMILIES, BOT_COLORS } from '../avatar'
import type { Agent } from '../types'

const agent = (over: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent => ({
  description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null,
  ...over
})

describe('fase 16 (U2): defaultAvatar', () => {
  it('il bot principale è Creatura c1', () => {
    expect(defaultAvatar('agent_x', true)).toEqual({ family: 'h-creature', color: 'c1' })
  })
  it('stabile: lo stesso id dà sempre lo stesso aspetto', () => {
    for (const id of ['agent_ab12cd34', 'sub_00112233', 'agent_0']) {
      expect(defaultAvatar(id, false)).toEqual(defaultAvatar(id, false))
    }
  })
  it('id diversi distribuiscono le 5 famiglie (≥100 su 1000 id)', () => {
    const count = new Map<string, number>()
    for (let i = 0; i < 1000; i++) {
      const a = defaultAvatar(`agent_${i.toString().padStart(4, '0')}`, false)
      count.set(a.family, (count.get(a.family) ?? 0) + 1)
      // il colore è sempre uno dei 7 token
      expect(BOT_COLORS).toContain(a.color)
    }
    for (const f of BOT_FAMILIES) {
      expect(count.get(f) ?? 0, `famiglia ${f}`).toBeGreaterThanOrEqual(100)
    }
  })
  it('fnv1a è l’hash FNV-1a a 32 bit (vettori noti)', () => {
    // vettori di riferimento dell'algoritmo
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
  })
})

describe('fase 16 (U2): validazione avatar di agents:update', () => {
  it('null e undefined tornano al predefinito senza errore', () => {
    expect(avatarValidationError(null)).toBeNull()
    expect(avatarValidationError(undefined)).toBeNull()
  })
  it('famiglia e colore validi passano', () => {
    expect(avatarValidationError({ family: 'h-robo', color: 'c3' })).toBeNull()
  })
  it('famiglia fuori dalle 5 → errore (anche le 4 d’archivio)', () => {
    for (const bad of ['orb', 'cloud', 'capsule', 'doodle', 'creature']) {
      expect(avatarValidationError({ family: bad, color: 'c1' })).toMatch(/avatar non valido: famiglia/)
    }
  })
  it('colore fuori c1–c7 → errore (anche il nome della variabile CSS)', () => {
    expect(avatarValidationError({ family: 'pixel', color: 'c8' })).toMatch(/avatar non valido: colore/)
    expect(avatarValidationError({ family: 'pixel', color: '--bot-c3' })).toMatch(/avatar non valido: colore/)
  })
  it('non oggetto → errore', () => {
    expect(avatarValidationError('c3')).toMatch(/avatar non valido/)
    expect(avatarValidationError(3)).toMatch(/avatar non valido/)
  })
})

describe('fase 16 (U2): avatarOf — l’aspetto con cui si disegna', () => {
  const main = agent({ id: 'agent_a', name: 'A' })
  const bots = [main]
  it('senza avatar scelto: il principale è Creatura c1, gli altri l’hash del loro id', () => {
    expect(avatarOf(main, bots, 'agent_a')).toEqual({ family: 'h-creature', color: 'c1' })
    const other = agent({ id: 'agent_b', name: 'B' })
    expect(avatarOf(other, [...bots, other], 'agent_a')).toEqual(defaultAvatar('agent_b', false))
  })
  it('l’avatar scelto vince sul predefinito', () => {
    const custom = agent({ id: 'agent_a', name: 'A', avatar: { family: 'pixel', color: 'c6' } })
    expect(avatarOf(custom, [custom], 'agent_a')).toEqual({ family: 'pixel', color: 'c6' })
  })
  it('un sottoagente (parentId) usa l’aspetto del padre', () => {
    const father = agent({ id: 'agent_a', name: 'A', avatar: { family: 'h-robo', color: 'c4' } })
    const child = agent({ id: 'sub_1234', name: 'figlio', parentId: 'agent_a' })
    expect(avatarOf(child, [father, child], 'agent_a')).toEqual({ family: 'h-robo', color: 'c4' })
  })
})
