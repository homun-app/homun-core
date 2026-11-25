// C0.7 (fase linguaggio): il controllo dei temporanei del passo 7 di
// fatto.mjs guarda LE COSE SU DEL REPO, non tutta la T/ comune. La verifica
// di fondamenta-galleria l'aveva visto ROSSO per colpa di altre app (i file
// zcode-bash-* e le socket znr*.sock, prima le atuin-hook-exec-*): un
// controllo che fallisce per colpa altrui insegna a ignorarlo. Lo stato
// dell'arte: la corsa ha una RADICE SUA (una fatto-* con mkdtemp nella base
// dei vincoli, passata come TMPDIR a tutti i passi) e nella T/ comune contano
// solo i prefissi del repo. Le prove che il controllo prende ciò che deve:
// una sandbot-prova-* lasciata nella T/ comune e un file lasciato nella
// radice della corsa sono TUTTE E DUE prese (ROSSA); una zcode-finta-*
// creata durante la corsa NON la fa fallire (VERDE).
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../src/test-tmp'
import { PREFISSI_REPO, nuoveDelRepo, residuiRadice, filtraRepo } from '../lib/temporanei-fatto.mjs'

// le cartelle di prova: mkdtemp nell'aiutante, cancellate a fine corsa
const fatte: string[] = []
const mk = (prefix: string): string => {
  const d = mkdtempSync(join(TEST_TMP_BASE, prefix))
  fatte.push(d)
  return d
}
afterAll(() => { for (const d of fatte) rmSync(d, { recursive: true, force: true }) })

describe('C0.7: i prefissi del repo, letti dal codice (non a memoria)', () => {
  it('tutto ciò che il repo scrive nella T/ comune comincia per sandbot- o fatto-', () => {
    // i test (src/test-tmp.ts e le mkdtemp dei .test.ts), la radice vitest
    // (sandbot-vitest-run-), i dati (sandbot-vitest-data-), le sonde
    // (sandbot-fase-*), la galleria (sandbot-galleria-), il censimento
    // (sandbot-esporta-inutilizzati-) e la radice della corsa (fatto-)
    expect(PREFISSI_REPO).toEqual(['sandbot-', 'fatto-'])
  })

  it('filtraRepo lascia passare i prefissi del repo e ignora tutto il resto', () => {
    expect(filtraRepo(['sandbot-vitest-run-abc', 'fatto-xyz', 'zcode-bash-123', 'znruno.sock', 'atuin-hook-exec-9'])).toEqual(['sandbot-vitest-run-abc', 'fatto-xyz'])
  })
})

describe('C0.7: prova ROSSA — una sandbot-prova-* lasciata nella T/ comune è PRESA', () => {
  it('nuoveDelRepo la vede fra le nuove della corsa', () => {
    const prima = readdirSync(TEST_TMP_BASE).filter((n) => !n.startsWith('.'))
    const prova = mk('sandbot-prova-') // il test la LASCIA lì (la cancella l'afterAll, a prova fatta)
    const dopo = readdirSync(TEST_TMP_BASE).filter((n) => !n.startsWith('.'))
    const nuove = nuoveDelRepo(prima, dopo)
    expect(nuove).toContain(prova.split('/').pop()!)
  })
})

describe('C0.7: prova ROSSA — un file lasciato nella radice della corsa è PRESO', () => {
  it('residuiRadice vede un file (e una cartella) rimasti nella radice', () => {
    const radice = mk('fatto-')
    // a fine corsa la radice deve essere VUOTA: questo è ciò che non deve restare
    writeFileSync(join(radice, 'dump.sqlite-shm'), 'avanzo')
    mkdirSync(join(radice, 'cache'))
    expect(residuiRadice(readdirSync(radice))).toEqual(['cache', 'dump.sqlite-shm'])
    rmSync(join(radice, 'dump.sqlite-shm'))
    rmSync(join(radice, 'cache'), { recursive: true, force: true })
    expect(residuiRadice(readdirSync(radice))).toEqual([])
  })
})

describe('C0.7: prova VERDE — una zcode-finta-* creata durante la corsa NON fa fallire', () => {
  it('una cartella di un\'altra app, nuova nella T/ comune, resta fuori dal conto', () => {
    const prima = ['sandbot-vitest-run-aaa', 'zcode-gia-presente-1']
    const dopo = [...prima, 'zcode-finta-123', 'znrnuova.sock']
    expect(nuoveDelRepo(prima, dopo)).toEqual([])
  })
})
