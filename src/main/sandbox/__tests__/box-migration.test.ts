// Migrazione una tantum dal layout vecchio (un box per agente in
// ~/SandBot/<agentId>/box) al box condiviso (fase 11, punto 1): COPIA senza
// cancellare, idempotente col marker. La modalità è iniettabile: niente
// home reale, niente docker reale.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-boxmig-test-'))
const DATA = join(TMP, 'data') // directory dati (radice del box condiviso)
const LEGACY = join(TMP, 'legacySandBot') // la vecchia ~/SandBot (fake)
let sandboxMode = 'host'
vi.mock('../../store/db', () => ({
  // la modalità sandbox si legge dal setting: il test la cambia a piacere
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? sandboxMode : fallback),
  dataDir: () => DATA
}))

const { migrateLegacyBoxes, boxRoot } = await import('../index')

beforeAll(() => {
  // due vecchi box (uno per agente) nella vecchia radice
  for (const id of ['agent_a', 'agent_b']) {
    mkdirSync(join(LEGACY, id, 'box', 'lavori'), { recursive: true })
    writeFileSync(join(LEGACY, id, 'box', 'report.md'), `report di ${id}`)
    writeFileSync(join(LEGACY, id, 'box', 'lavori', 'dati.txt'), `dati di ${id}`)
  }
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('migrazione host: copia senza cancellare, idempotente', () => {
  it('copia i vecchi box nelle home del box condiviso e NON tocca gli originali', async () => {
    const r = await migrateLegacyBoxes([{ id: 'agent_a' }, { id: 'agent_b' }, { id: 'agent_nuovo' }], { legacyRoot: LEGACY })
    expect(r.alreadyDone).toBe(false)
    expect(r.migrated.map((m) => m.agentId).sort()).toEqual(['agent_a', 'agent_b'])
    // i file sono nella nuova home, stessa struttura
    expect(readFileSync(join(boxRoot(), 'home', 'agent_a', 'report.md'), 'utf8')).toBe('report di agent_a')
    expect(readFileSync(join(boxRoot(), 'home', 'agent_b', 'lavori', 'dati.txt'), 'utf8')).toBe('dati di agent_b')
    // agent senza vecchio box: nessuna copia (la home nascerà al primo uso)
    expect(r.migrated.find((m) => m.agentId === 'agent_nuovo')).toBeUndefined()
    // gli ORIGINALI restano dove sono (la cancellazione la decide l'utente)
    expect(existsSync(join(LEGACY, 'agent_a', 'box', 'report.md'))).toBe(true)
    expect(existsSync(join(LEGACY, 'agent_b', 'box', 'lavori', 'dati.txt'))).toBe(true)
    // il marker dell'idempotenza è nel box
    expect(existsSync(join(boxRoot(), '.migrated-v1'))).toBe(true)
  })

  it('idempotente: col marker non copia più nulla (e le modifiche locali non vengono sovrascritte)', async () => {
    // un file nuovo scritto nel box condiviso dopo la migrazione
    writeFileSync(join(boxRoot(), 'home', 'agent_a', 'nuovo.md'), 'lavoro nuovo')
    const r = await migrateLegacyBoxes([{ id: 'agent_a' }], { legacyRoot: LEGACY })
    expect(r.alreadyDone).toBe(true)
    expect(r.migrated).toHaveLength(0)
    expect(readFileSync(join(boxRoot(), 'home', 'agent_a', 'nuovo.md'), 'utf8')).toBe('lavoro nuovo')
  })

  it('nessun file temporaneo o residuo nella radice del box', () => {
    // solo workspace, home e il marker: la migrazione non lascia altro
    expect(readdirSync(boxRoot()).sort()).toEqual(['.migrated-v1', 'home', 'workspace'])
  })
})

describe('migrazione docker: argv one-shot passati al runner iniettato', () => {
  it('marker presente → già fatto; volumi vecchi copiati uno-shot; marker scritto alla fine', async () => {
    sandboxMode = 'docker'
    try {
      const seen: string[][] = []
      // prima corsa: marker assente, due volumi vecchi
      const run1 = async (argv: string[]) => {
        seen.push(argv)
        if (argv.includes('test')) return { exitCode: 1, stdout: '' } // marker assente
        if (argv.includes('volume')) return { exitCode: 0, stdout: 'sandbot-agent_a-box' } // volume esiste
        return { exitCode: 0, stdout: '' } // copia riuscita
      }
      const r1 = await migrateLegacyBoxes([{ id: 'agent_a' }, { id: 'agent_senza' }], { runDocker: run1 })
      expect(r1.migrated).toEqual([{ agentId: 'agent_a', from: 'volume docker sandbot-agent_a-box', to: '/box/home/agent_a' }])
      expect(r1.failed).toEqual([])
      // la sequenza: check marker → ls volume (uno per agente) → cp → touch marker
      expect(seen[0]!.includes('test')).toBe(true)
      expect(seen.at(-1)!.includes('touch')).toBe(true)
      // la copia one-shot si riconosce dal mount in sola lettura del vecchio volume
      const copie = seen.filter((a) => a.some((el) => el.includes(':ro')))
      expect(copie).toHaveLength(1) // solo il volume esistente

      // seconda corsa: marker presente → già fatto, zero chiamate
      let calls = 0
      const r2 = await migrateLegacyBoxes([{ id: 'agent_a' }], {
        runDocker: async () => { calls++; return { exitCode: 0, stdout: '' } }
      })
      expect(r2.alreadyDone).toBe(true)
      expect(calls).toBe(1) // solo il check del marker
    } finally {
      sandboxMode = 'host'
    }
  })

  it('F9: una copia FALLITA → niente marker, il fallito in `failed`, e si RIPROVA al prossimo avvio', async () => {
    sandboxMode = 'docker'
    try {
      let markerTouched = false
      const run = async (argv: string[]) => {
        if (argv.includes('test')) return { exitCode: 1, stdout: '' } // marker assente
        if (argv.includes('volume')) return { exitCode: 0, stdout: 'sandbot-agent_a-box\nsandbot-agent_b-box' }
        if (argv.includes('touch')) { markerTouched = true; return { exitCode: 0, stdout: '' } }
        // la copia di agent_a riesce, quella di agent_b FALLISCE
        return argv.includes('agent_a') ? { exitCode: 0, stdout: '' } : { exitCode: 1, stdout: 'boom' }
      }
      const r1 = await migrateLegacyBoxes([{ id: 'agent_a' }, { id: 'agent_b' }], { runDocker: run })
      expect(r1.alreadyDone).toBe(false)
      expect(r1.migrated.map((m) => m.agentId)).toEqual(['agent_a'])
      expect(r1.failed).toEqual([{ agentId: 'agent_b', from: 'volume docker sandbot-agent_b-box' }])
      // il marker NON si scrive: la migrazione va ritentata al prossimo avvio
      expect(markerTouched).toBe(false)
      // seconda corsa: il marker è ancora assente → si riprova TUTTO (idempotente per copia)
      const r2 = await migrateLegacyBoxes([{ id: 'agent_a' }, { id: 'agent_b' }], {
        runDocker: async (argv) => {
          if (argv.includes('test')) return { exitCode: 1, stdout: '' }
          if (argv.includes('volume')) return { exitCode: 0, stdout: 'sandbot-agent_b-box' }
          return { exitCode: 0, stdout: '' } // stavolta la copia riesce
        }
      })
      expect(r2.failed).toEqual([])
      expect(r2.migrated.map((m) => m.agentId)).toEqual(['agent_b'])
    } finally {
      sandboxMode = 'host'
    }
  })
})
