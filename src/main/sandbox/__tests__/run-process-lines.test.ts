// OBD3 (fase onboarding-b-dettagli): le righe dello spawn — SpawnOptions
// riceve onStderrLine/onStdoutLine, righe separate da \n O \r, l'ultima
// riga PARZIALE consegnata alla chiusura. Il buffer da 2 MB resta com'è:
// le callback sono in più, non al posto. Si prova con uno spawn VERO del
// node di prova (la CLI del motore Apple punta lì con gli override di
// test), MAI la CLI `container` installata sul Mac.
import { describe, expect, it, afterEach } from 'vitest'

const { runDockerRaw, setDockerRunnerForTests, allowRealDockerForTests } = await import('../index')
const { setActiveEngineForTests } = await import('../engine')

// R7 (b20-ritocchi): questo file SPAWNA DAVVERO un processo (il node di
// prova, come CLI del motore: mai docker, mai la CLI container installata).
// La guardia dei test lo lascia fare SOLO a chi lo chiede in modo esplicito
allowRealDockerForTests()

// la CLI del motore Apple diventa il node di prova: runDockerRaw spawna il
// comando del motore attivo con l'argv che gli passo. Il valore di prova
// passa da TEST_TMP_BASE (CB1, fase ci-beta5: il percorso letterale del Mac
// di sviluppo è vietato nel codice dei test — qui è solo il valore che apre
// l'override della CLI, nessuna cartella viene creata)
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ENV = {
  SANDBOT_TEST_USER_DATA: join(TEST_TMP_BASE, 'sandbot-lines-test'),
  SANDBOT_TEST_CONTAINER_CLI: process.execPath
}

afterEach(() => {
  setDockerRunnerForTests(null)
  setActiveEngineForTests(null)
  for (const k of Object.keys(ENV)) delete process.env[k]
})

describe('OBD3: onStderrLine/onStdoutLine — le righe mentre il processo corre', () => {
  it('le righe separate da \\n O \\r arrivano una per volta, la PARZIALE finale alla chiusura', async () => {
    Object.assign(process.env, ENV)
    setActiveEngineForTests('apple-container')
    const stderrLines: string[] = []
    const stdoutLines: string[] = []
    // uno script vero: stderr con \r, \n e \r\n; stdout a pezzi sconnessi;
    // l'ultima riga SENZA fine riga (la parziale)
    const script = [
      'process.stderr.write("uno\\rdue\\ntre\\r\\nquattro")',
      'process.stdout.write("A\\n")',
      'process.stdout.write("B")',
      'process.stdout.write("C\\nD")'
    ].join(';')
    const r = await runDockerRaw(['-e', script], { timeoutMs: 30_000, onStderrLine: (l) => stderrLines.push(l), onStdoutLine: (l) => stdoutLines.push(l) })
    expect(r.exitCode).toBe(0)
    // \r e \n separano; \r\n è UN solo fine riga
    expect(stderrLines).toEqual(['uno', 'due', 'tre', 'quattro'])
    // stdout "A\nBC\nD": le righe seguono il CONTENUTO (i chunk possono
    // coalirsi), l'ultima parziale (D) arriva alla chiusura
    expect(stdoutLines).toEqual(['A', 'BC', 'D'])
    // i buffer restano: le callback sono IN PIÙ, non al posto
    expect(r.stdout).toBe('A\nBC\nD')
    expect(r.stderr).toBe('uno\rdue\ntre\r\nquattro')
  })

  it('senza le callback nulla cambia (il buffer come sempre)', async () => {
    Object.assign(process.env, ENV)
    setActiveEngineForTests('apple-container')
    const r = await runDockerRaw(['-e', 'process.stdout.write("x")'], { timeoutMs: 30_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('x')
  })
})
