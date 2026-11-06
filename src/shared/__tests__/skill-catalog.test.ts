// Fase skill · catalogo (K1): il catalogo curato che vive NEL REPO
// (src/shared/skill-catalog/skill-catalog.json) — validazione di ogni voce
// e consistenza con la bozza di analisi/ (che si legge SOLO se esiste: la
// suite non deve dipendere dalla cartella SandBot).
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { loadSkillCatalog, skillCatalogIssues, SKILL_CATEGORIES, SKILL_CATEGORY_LABELS, searchSkillCatalog } = await import('../skill-catalog')
const { isValidSkillName } = await import('../skill-md')

const entries = loadSkillCatalog()

/** La bozza curata nella cartella SandBot (fuori dal repo). */
const DRAFT = '/Users/fabio/SandBot/analisi/skill-catalog-bozza.json'
/** Il file del catalogo copiato nel repo, così com'è. */
const REPO_FILE = fileURLToPath(new URL('../skill-catalog/skill-catalog.json', import.meta.url))

describe('K1: il catalogo nel repo è valido', () => {
  it('ci sono voci e NESSUN problema di validazione', () => {
    expect(entries.length).toBeGreaterThan(0)
    expect(skillCatalogIssues(entries)).toEqual([])
  })

  it('gli id sono UNICI e dello standard Agent Skills', () => {
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of entries) {
      expect(isValidSkillName(e.id), `id non standard: ${e.id}`).toBe(true)
    }
  })

  it('il commit è 40 caratteri esadecimali', () => {
    for (const e of entries) {
      expect(e.source.commit, `${e.id}: ${e.source.commit}`).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('il repo è nella forma owner/name', () => {
    for (const e of entries) {
      expect(e.source.repo, `${e.id}: ${e.source.repo}`).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
    }
  })

  it('il path non ha .. e non inizia con /', () => {
    for (const e of entries) {
      expect(e.source.path.startsWith('/'), `${e.id}: ${e.source.path}`).toBe(false)
      expect(e.source.path.split('/').includes('..'), `${e.id}: ${e.source.path}`).toBe(false)
    }
  })

  it('la categoria è fra quelle dichiarate', () => {
    for (const e of entries) {
      expect((SKILL_CATEGORIES as readonly string[]).includes(e.category), `${e.id}: ${e.category}`).toBe(true)
    }
    // le etichette delle cinque categorie ci sono in entrambe le lingue
    for (const c of SKILL_CATEGORIES) {
      expect(SKILL_CATEGORY_LABELS[c].it.length).toBeGreaterThan(0)
      expect(SKILL_CATEGORY_LABELS[c].en.length).toBeGreaterThan(0)
    }
  })

  it('le descrizioni it/en ci sono e sono ≤ 140 caratteri', () => {
    for (const e of entries) {
      expect(e.description.it.length, `${e.id}.it`).toBeGreaterThan(0)
      expect(e.description.en.length, `${e.id}.en`).toBeGreaterThan(0)
      expect(e.description.it.length, `${e.id}.it`).toBeLessThanOrEqual(140)
      expect(e.description.en.length, `${e.id}.en`).toBeLessThanOrEqual(140)
    }
  })

  it('homunNotes ≤ 1200 caratteri', () => {
    for (const e of entries) {
      expect(e.homunNotes.length, `${e.id}`).toBeLessThanOrEqual(1200)
    }
  })

  it('invocation è assente oppure "user"', () => {
    for (const e of entries) {
      if (e.invocation !== undefined) expect(e.invocation, e.id).toBe('user')
    }
  })
})

describe('K1: il file del repo è UGUALE alla bozza di analisi/', () => {
  it('byte per byte (il test si SALTA se la bozza non c\'è)', () => {
    if (!existsSync(DRAFT)) return // la suite non dipende dalla cartella SandBot
    expect(readFileSync(REPO_FILE, 'utf8')).toBe(readFileSync(DRAFT, 'utf8'))
  })
})

describe('K2 (anteprima): la ricerca condivisa del catalogo (pura)', () => {
  it('la query batte nome, descrizione nella lingua attiva, repo e categoria; senza accenti', () => {
    expect(searchSkillCatalog(entries, 'copywriting', 'it').map((e) => e.id)).toContain('copywriting')
    expect(searchSkillCatalog(entries, 'peraltro', 'it').length).toBe(0)
    // la descrizione nella lingua attiva (non l'altra)
    const itWord = searchSkillCatalog(entries, 'riscrive', 'it')
    expect(itWord.length).toBeGreaterThan(0)
    // il repo (owner/name) e la categoria
    expect(searchSkillCatalog(entries, 'blader/humanizer', 'it').map((e) => e.id)).toContain('humanizer')
    expect(searchSkillCatalog(entries, 'scrittura', 'it').length).toBeGreaterThan(0)
    expect(searchSkillCatalog(entries, 'writing', 'en').length).toBeGreaterThan(0)
    // query vuota: tutte
    expect(searchSkillCatalog(entries, '', 'it')).toHaveLength(entries.length)
  })
})
