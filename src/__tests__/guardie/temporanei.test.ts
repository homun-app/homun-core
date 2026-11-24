// F3 (fase fondamenta): GUARDIA — nessun test crea le sue cartelle temporanee
// con os.tmpdir(), '/tmp' o $TMPDIR direttamente: passa dall'aiutante
// src/test-tmp.ts (TEST_TMP_BASE: la base dei vincoli, o — dove non esiste —
// la temporanea di sistema RISOLTA, come fa la corsa ci-sim). Un test che
// decide la base da sé sfugge a SANDBOT_TEST_TMP_BASE e alla fotografia di
// fatto.mjs. Vista ROSSA prima: 89 file usavano join(tmpdir(), …).
import { describe, it, expect } from 'vitest'
import { leggiSorgenti } from './sorgenti'

const test = [
  ...leggiSorgenti('src', ['.test.ts']),
  ...leggiSorgenti('scripts/__tests__', ['.test.ts'])
]

const CRUDO = /os\.tmpdir\(\)|env\.TMPDIR|(?:mkdtempSync|mkdirSync|writeFileSync|cpSync|createWriteStream)\(\s*(?:['\"]\/tmp\b|join\(\s*['\"]\/tmp\b)/

/** Le eccezioni, ognuna col motivo: l'aiutante stesso e i test che lo verificano. */
const ECCEZIONI: ReadonlyArray<{ file: string; perché: string }> = [
  { file: 'src/test-setup.ts', perché: 'È l\'aiutante di corsa (rete di sicurezza della suite): la base la decide lui, per tutti gli altri' },
  { file: 'src/test-tmp-guard.ts', perché: 'il controllo di fine corsa: legge LA BASE (TEST_TMP_BASE e realpath(tmpdir())) per trovare le cartelle residue' },
  { file: 'src/test-tmp.ts', perché: 'è l\'aiutante stesso (TEST_TMP_BASE)' },
  { file: 'src/__tests__/test-tmp.test.ts', perché: 'verifica l\'aiutante: la scelta della base è proprio ciò che il test controlla' },
  { file: 'src/__tests__/test-tmp-guard.test.ts', perché: 'verifica la guardia di fine corsa: genera cartelle residue DI PROPOSITO (in una base sua)' },
  { file: 'src/__tests__/test-tmp-guard-run-root.test.ts', perché: 'idem, per il caso della radice della corsa' },
  { file: 'src/daemon/__tests__/models-list.test.ts', perché: 'menziona la regola nei COMMENTI (mai os.tmpdir()): nessun uso attivo' },
  { file: 'src/daemon/__tests__/local-model-server.test.ts', perché: 'verifica che il figlio RICEVA env.TMPDIR (la propagazione dell\'ambiente): nessuna cartella creata fuori dall\'aiutante' }
]

describe('i test passano dall\'aiutante dei temporanei (src/test-tmp.ts)', () => {
  it('nessun os.tmpdir(), \'/tmp\' o $TMPDIR usato direttamente nei test', () => {
    const violazioni: string[] = []
    for (const { rel, testo } of test) {
      if (rel === 'src/__tests__/guardie/temporanei.test.ts') continue // la guardia porta il pattern vietato nel suo testo
      if (ECCEZIONI.some((e) => e.file === rel)) continue
      // i COMMENTI non contano: il codice che crea o punta cartelle sì. Tolgo le righe di commento
      const codice = testo.split('\n').filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*') && !r.trim().startsWith('/*')).join('\n')
      if (CRUDO.test(codice)) violazioni.push(rel)
    }
    expect(violazioni).toEqual([])
  })
})
