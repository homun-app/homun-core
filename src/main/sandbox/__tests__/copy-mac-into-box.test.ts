// Fase 19b (T0, BUG della fase 11): in docker la copia Mac → box NON usa più
// `docker cp` (il file arrivava 501:0 e permessi 644: il bot uid 1000 non lo
// poteva più modificare né cancellare). Il daemon legge i byte sul Mac e li
// scrive con dockerWriteFileArgv (temporaneo + rename atomico) passandoli sullo
// STDIN BINARIO: l'exec gira come utente di default (1000), quindi il file è
// SUO. Tetto di 100 MB: oltre, errore inglese chiaro e NESSUNA scrittura. La
// modalità host non cambia. Runner docker FINTO (setDockerRunnerForTests).
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, truncateSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

// come bot-home.test.ts: directory dati iniettata (MAI la home reale) e
// sandbox.mode pilotabile dal test — le cartelle temporanee sono mkdtemp
// dentro /var/folders/nb/…, mai $TMPDIR né os.tmpdir()
const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-copyin-test-'))
const mode = vi.hoisted(() => ({ value: 'host' as string }))
vi.mock('../../store/db', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'sandbox.mode' ? mode.value : fallback),
  dataDir: () => TMP,
  getAgent: (id: string) => ({ id, parentId: null })
}))

const { copyMacIntoBox, setDockerRunnerForTests, COPY_INTO_BOX_MAX_BYTES } = await import('../index')
const { dockerWriteFileArgv, DOCKER_WRITE_SH, BOX_CONTAINER } = await import('../docker-argv')

describe('fase 19b (T0): la copia Mac → box diventa del bot', () => {
  let macDir: string
  beforeAll(() => {
    macDir = mkdtempSync(join(TMP, 'mac-'))
  })
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe('in docker: stdin BINARIO con dockerWriteFileArgv, come utente 1000', () => {
    const calls: Array<{ argv: string[]; input?: string | Buffer }> = []
    beforeAll(() => {
      mode.value = 'docker'
      setDockerRunnerForTests(async (argv, opts) => {
        calls.push({ argv, input: opts?.input })
        return { stdout: '', stderr: '', exitCode: 0, signal: null }
      })
    })
    afterAll(() => {
      setDockerRunnerForTests(null)
      mode.value = 'host'
    })

    it('l\'argv è quello di dockerWriteFileArgv col path GIUSTO, l\'input è un BUFFER identico byte per byte', async () => {
      // byte NON UTF-8 (0xff 0xfe 0x00): se passassero da una stringa si
      // corromperebbero (efbfbd), come Buffer restano IDENTICI
      const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('testo\n', 'utf8')])
      const macPath = join(macDir, 'binario.dat')
      writeFileSync(macPath, bytes)
      await copyMacIntoBox('agent_x', macPath, '/box/home/agent_x/binario.dat')
      const last = calls[calls.length - 1]!
      expect(last.argv).toEqual(dockerWriteFileArgv(BOX_CONTAINER, '/box/home/agent_x/binario.dat'))
      // la stringa sh -c è quella COSTANTE (temporaneo + rename atomico)
      expect(last.argv).toContain(DOCKER_WRITE_SH)
      // l'exec è dell'utente di DEFAULT del container (1000): NESSUN -u
      expect(last.argv.includes('-u')).toBe(false)
      // NESSUN docker cp
      expect(calls.some((c) => c.argv[0] === 'cp')).toBe(false)
      // l'input è un BUFFER (non una stringa) identico byte per byte
      expect(Buffer.isBuffer(last.input)).toBe(true)
      expect(Buffer.compare(last.input as Buffer, bytes)).toBe(0)
    })

    it('oltre 100 MB si RIFIUTA: errore inglese chiaro e NESSUNA scrittura', async () => {
      const big = join(macDir, 'grande.bin')
      writeFileSync(big, 'x')
      truncateSync(big, COPY_INTO_BOX_MAX_BYTES + 1) // file sparse: pesa 1 byte sul disco
      const before = calls.length
      await expect(copyMacIntoBox('agent_x', big, '/box/home/agent_x/grande.bin')).rejects.toThrow(/too large/i)
      expect(calls.length).toBe(before) // nessun argv di scrittura partito
      rmSync(big, { force: true })
    })

    it('un file del Mac che non c\'è: errore chiaro', async () => {
      await expect(copyMacIntoBox('agent_x', join(macDir, 'manca.bin'), '/box/home/agent_x/manca.bin')).rejects.toThrow(/not found on the mac/i)
    })

    it('esattamente 100 MB va bene (il tetto è «oltre»)', async () => {
      const edge = join(macDir, 'al-limite.bin')
      writeFileSync(edge, 'x')
      truncateSync(edge, COPY_INTO_BOX_MAX_BYTES)
      await copyMacIntoBox('agent_x', edge, '/box/home/agent_x/al-limite.bin')
      const last = calls[calls.length - 1]!
      expect(last.argv).toContain('/box/home/agent_x/al-limite.bin')
      rmSync(edge, { force: true })
    })
  })

  describe('in host: NON cambia (fs copyFile nella home del box)', () => {
    afterEach(() => {
      mode.value = 'host'
    })

    it('il file arriva byte per byte nella destinazione del box', async () => {
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
      const macPath = join(macDir, 'host.dat')
      writeFileSync(macPath, bytes)
      const dest = join(TMP, 'box', 'home', 'agent_x', 'host.dat')
      await copyMacIntoBox('agent_x', macPath, dest)
      expect(existsSync(dest)).toBe(true)
      expect(Buffer.compare(readFileSync(dest), bytes)).toBe(0)
    })
  })
})
