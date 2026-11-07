// Fase use-app (U3): migrazione dei permessi vecchi di use-app. Le grant
// salvate dalle versioni di prima avevano come target l'AZIONE (type, click,
// open_app…): davano il permesso di digitare in QUALUNSI app, Homun compreso.
// La migrazione le rimuove (le nuove chiavi sono app:<Nome> e url:<host>) e
// aggiunge expires_at per i permessi a 10 minuti.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-useapp-grants-'))
const { setDataDir, db, listGrants, addGrant, migrateUseAppActionGrants } = await import('../db')
beforeAll(() => { setDataDir(TMP) })
afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

/** Inserisce una grant come la salvava il codice di prima (senza expires_at). */
const insertLegacy = (tool: string, target: string): void => {
  db().prepare('INSERT INTO grants(tool, target, created_at, scope) VALUES(?,?,?,NULL)').run(tool, target, Date.now())
}

describe('U3: migrazione dei grants di use-app per azione', () => {
  it('rimuove le sei grant azione di use-app e lascia tutto il resto', () => {
    for (const t of ['type', 'key', 'click', 'double_click', 'right_click', 'open_app']) {
      insertLegacy('use-app', t)
    }
    insertLegacy('use-app', 'screenshot')      // ridondante ma innocuo: resta
    insertLegacy('run-command', 'git status')  // altro tool: intoccabile
    insertLegacy('use-app', 'app:Safari')      // già nel formato nuovo: resta

    const { removed } = migrateUseAppActionGrants()
    expect(removed).toBe(6)

    const left = listGrants().map((g) => `${g.tool}|${g.target}`).sort()
    expect(left).toEqual(['run-command|git status', 'use-app|app:Safari', 'use-app|screenshot'])
  })

  it('idempotente: al secondo giro non c\'è niente da togliere', () => {
    expect(migrateUseAppActionGrants().removed).toBe(0)
    expect(listGrants().length).toBe(3)
  })

  it('expires_at: la colonna esiste e addGrant/listGrants la portano (i 10 minuti)', () => {
    const until = Date.now() + 600_000
    addGrant('use-app', 'app:Mail', undefined, until)
    const g = listGrants().find((x) => x.tool === 'use-app' && x.target === 'app:Mail')
    expect(g?.expiresAt).toBe(until)
    // senza scadenza resta null, come le grant di sempre
    addGrant('use-app', 'app:Notes')
    expect(listGrants().find((x) => x.target === 'app:Notes')?.expiresAt).toBeNull()
  })

  it('R5: i grant SCADUTI si cancellano (non solo si saltano); i validi restano', () => {
    addGrant('use-app', 'app:Scaduto', undefined, Date.now() - 1_000)
    addGrant('use-app', 'app:Valido', undefined, Date.now() + 600_000)
    addGrant('run-command', 'git status') // senza scadenza: intoccabile
    const after = listGrants()
    expect(after.some((x) => x.target === 'app:Scaduto')).toBe(false)
    expect(after.some((x) => x.target === 'app:Valido')).toBe(true)
    expect(after.some((x) => x.tool === 'run-command' && x.target === 'git status')).toBe(true)
    // CANCELLATI davvero dalla tabella, non solo filtrati in lettura
    const rows = db().prepare('SELECT target FROM grants').all() as Array<{ target: string }>
    expect(rows.some((x) => x.target === 'app:Scaduto')).toBe(false)
    expect(rows.some((x) => x.target === 'app:Valido')).toBe(true)
    // e la lettura successiva resta pulita
    expect(listGrants().some((x) => x.target === 'app:Scaduto')).toBe(false)
  })
})
