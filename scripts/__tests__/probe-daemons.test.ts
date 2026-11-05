// K8 (fase skill ritocchi): l'helper condiviso delle sonde che trova i
// daemon dall'AMBIENTE dei processi (ps eww -ax), non dagli argomenti. Il
// filtro di prima (pgrep -fl + prefisso della cartella NELLA riga di
// comando) non trovava mai niente: la cartella dati sta nell'env
// SANDBOT_TEST_USER_DATA, non negli argv — così la sonda diceva «nessun
// daemon vivo» mentre ne restava uno (S10.2 non risolto).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../src/test-tmp'

// l'helper è un .mjs delle sonde: si importa com'è
const { findProbeDaemons, stopProbeDaemons } = await import('../lib/probe-daemons.mjs')

// temporanei SOLO con mkdtemp nella base indicata dal progetto
const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-fase-skill-helper-test-'))
const userData = join(dir, 'data')

let child: ReturnType<typeof spawn> | null = null
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

beforeAll(() => {
  // il processo FINTO: come il daemon vero, --homun-daemon negli argomenti e
  // la cartella dati nell'AMBIENTE (è questo che il filtro vecchio non vedeva).
  // Il «--» serve: senza, node legge --homun-daemon come OPZIONE SUA ed esce
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', '--', '--homun-daemon'], {
    env: { ...process.env, SANDBOT_TEST_USER_DATA: userData },
    stdio: 'ignore'
  })
})

afterAll(() => {
  try { child?.kill('SIGKILL') } catch { /* già via */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('K8: il filtro di PRIMA (pgrep -fl) non vede il daemon — la prova del difetto', () => {
  it('pgrep -fl sandbot + prefisso della cartella nella riga di comando NON trova il processo', () => {
    expect(child?.pid).toBeTruthy()
    const out = spawnSync('/usr/bin/pgrep', ['-fl', 'sandbot'], { encoding: 'utf8' })
    const alive = (out.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('sandbot-fase-skill-helper-test') && line.includes('--homun-daemon'))
    expect(alive.length).toBe(0)
  })
})

describe('K8: probe-daemons trova e chiude i daemon dall\'ambiente', () => {
  it('findProbeDaemons lo trova (SANDBOT_TEST_USER_DATA col prefisso della sonda, --homun-daemon negli argv)', () => {
    expect(child?.pid).toBeTruthy()
    const found = findProbeDaemons('sandbot-fase-skill-helper-test')
    expect(found.map((d) => d.pid)).toContain(child!.pid)
  })

  it('stopProbeDaemons lo chiude e riporta i conteggi (0 trovati quando ce n’è uno è da indagare)', async () => {
    const pid = child!.pid
    expect(pidAlive(pid)).toBe(true)
    const r = await stopProbeDaemons('sandbot-fase-skill-helper-test')
    expect(r.found).toBeGreaterThanOrEqual(1)
    expect(r.closed).toBe(r.found)
    expect(r.left).toBe(0)
    expect(pidAlive(pid)).toBe(false)
    // dopo la chiusura non ne resta NESSUNO
    expect(findProbeDaemons('sandbot-fase-skill-helper-test')).toHaveLength(0)
    // una seconda corsa: 0 trovati, 0 chiusi
    const again = await stopProbeDaemons('sandbot-fase-skill-helper-test')
    expect(again).toMatchObject({ found: 0, closed: 0, left: 0 })
  })
})
