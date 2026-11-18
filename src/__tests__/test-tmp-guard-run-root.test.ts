// C1 (fase ci-temporanei): la radice della corsa copre chi non pulisce. Il
// globalSetup crea sandbot-vitest-run- e il suo teardown la cancella PRIMA
// del controllo (wipeRunRoot): una cartella dati nata e mai pulita DENTRO la
// radice — il caso dei file saltati per intero, dove né afterAll né exit
// girano — sparisce con lei. E il controllo non può vederla comunque: la
// scan di fine corsa guarda i nomi DIRETTI della base, non dentro le
// cartelle. Il teardown completo (foto di tutta la base + confronto) non si
// prova qui: con la corsa in parallelo le cartelle degli altri worker
// nascono e spariscono di continuo e il confronto sarebbe flaky — la sua
// prova vera è la corsa intera col guard attivo.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { newLeftovers, RUN_ROOT_PREFIX, wipeRunRoot } from '../test-tmp-guard'
import { TEST_TMP_BASE } from '../test-tmp'

describe('C1 — la radice della corsa copre le cartelle dati mai pulite', () => {
  it('una sandbot-vitest-data- mai pulita DENTRO la radice sparisce col teardown', () => {
    const root = mkdtempSync(join(TEST_TMP_BASE, RUN_ROOT_PREFIX))
    const data = mkdtempSync(join(root, 'sandbot-vitest-data-')) // nessuno la pulisce
    wipeRunRoot(root) // il PRIMO gesto del teardown del globalSetup
    expect(existsSync(root)).toBe(false)
    expect(existsSync(data)).toBe(false)
  })

  it('la radice sparisce prima del controllo; la scan non vede DENTRO di essa', () => {
    const root = mkdtempSync(join(TEST_TMP_BASE, RUN_ROOT_PREFIX))
    const data = mkdtempSync(join(root, 'sandbot-vitest-data-'))
    try {
      // la scan di fine corsa elenca i nomi DIRETTI della base: la radice sì,
      // la cartella dati no — sta dentro, il controllo non può segnalarla
      const names = readdirSync(TEST_TMP_BASE)
      expect(names).toContain(basename(root))
      expect(names).not.toContain(basename(data))
      // e la radice non ha esenzioni: se il wipe mancasse e lei arrivasse
      // all'end (nata DOPO la foto d'avvio), il controllo la conterebbe
      expect(newLeftovers([], [root])).toEqual([root])
    } finally {
      wipeRunRoot(root)
    }
  })
})
