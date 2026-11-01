// Fase 19b correzioni (U1): la validazione del MAIN per il macPath di
// files:import-dropped — controllo in difesa in profondità oltre al confine
// vero (il preload, che accetta solo un File del drop). La cartella di prova
// è una mkdtemp nel percorso ESPLICITO /var/folders/nb/…/T/ (mai $TMPDIR né
// os.tmpdir()), con symlink VERI, rimossa a fine suite.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertDroppedMacPath, NOT_A_DROPPED_FILE } from '../dropped-file'

const TMP = mkdtempSync(join('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/', 'sandbot-u1-drop-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('fase 19b correzioni (U1): il main valida il macPath del trascinamento', () => {
  it('path relativo → rifiuto (il renderer non può scegliere un path)', async () => {
    await expect(assertDroppedMacPath('Users/x/.ssh/id_rsa')).rejects.toThrow(NOT_A_DROPPED_FILE)
    await expect(assertDroppedMacPath('')).rejects.toThrow(NOT_A_DROPPED_FILE)
  })

  it('non stringa → rifiuto', async () => {
    await expect(assertDroppedMacPath(undefined)).rejects.toThrow(NOT_A_DROPPED_FILE)
    await expect(assertDroppedMacPath({ path: '/etc/hosts' } as unknown)).rejects.toThrow(NOT_A_DROPPED_FILE)
  })

  it('path con byte nullo → rifiuto', async () => {
    await expect(assertDroppedMacPath(join(TMP, 'a\0b'))).rejects.toThrow(NOT_A_DROPPED_FILE)
  })

  it('symlink VERO → rifiuto: un link nel Desktop non deve portare a ~/.ssh', async () => {
    const target = join(TMP, 'target.txt')
    writeFileSync(target, 'contenuto')
    const link = join(TMP, 'verso-target')
    symlinkSync(target, link) // lstat lo vede COM'E', senza seguire
    await expect(assertDroppedMacPath(link)).rejects.toThrow(NOT_A_DROPPED_FILE)
  })

  it('cartella → rifiuto (solo file regolari)', async () => {
    const sub = join(TMP, 'sub')
    mkdirSync(sub)
    await expect(assertDroppedMacPath(sub)).rejects.toThrow(NOT_A_DROPPED_FILE)
  })

  it('file regolare → passa e torna il path', async () => {
    const f = join(TMP, 'regolare.txt')
    writeFileSync(f, 'contenuto')
    await expect(assertDroppedMacPath(f)).resolves.toBe(f)
  })
})
