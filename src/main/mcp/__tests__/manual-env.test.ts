// E1 (fase mcp-env): le VARIABILI D'AMBIENTE dei server stdio MANUALI. Il
// form le raccoglie (nome = valore, interruttore «segreto»); i SEGRETI si
// salvano CIFRATI nello stesso store di bearer e header (mai nei settings,
// mai nel DB in chiaro), i non segreti possono stare nella config; il
// processo riceve l'env di base + le variabili dell'utente. Qui la parte
// PURA dello split/merge e il resolver.
import { describe, expect, it } from 'vitest'
import { envNameLooksSecret, splitManualServerEnv, mergeManualEnvSecrets } from '../manual-env'

describe('E1: envNameLooksSecret — l\'interruttore di default del form', () => {
  it('TOKEN, KEY, SECRET, PASSWORD, AUTH (maiuscole e minuscole) → segreto', () => {
    for (const name of ['MATTERMOST_TOKEN', 'api_key', 'CLIENT_SECRET', 'DB_PASSWORD', 'OAUTH_CLIENT_ID', 'mytoken']) {
      expect(envNameLooksSecret(name), name).toBe(true)
    }
  })

  it('URL, HOST, TEAM_ID e simili → NON segreto', () => {
    for (const name of ['MATTERMOST_URL', 'HOST', 'TEAM_ID', 'PORT', 'NODE_ENV']) {
      expect(envNameLooksSecret(name), name).toBe(false)
    }
  })
})

describe('E1: splitManualServerEnv — segreti solo nello store, non segreti nella config', () => {
  it('una riga segreta e una no: i valori giusti nei due posti', () => {
    const r = splitManualServerEnv(
      { envSpec: [{ name: 'MATTERMOST_TOKEN', secret: true }, { name: 'MATTERMOST_URL', secret: false }] },
      { MATTERMOST_URL: 'https://mm.example' },
      { MATTERMOST_TOKEN: 'tok-dallo-store' }
    )
    expect(r.configEnvValues).toEqual({ MATTERMOST_URL: 'https://mm.example' })
    expect(r.sealedEnv).toEqual({ MATTERMOST_TOKEN: 'tok-dallo-store' })
  })

  it('un valore segreto digitato (form) finisce cifrato, uno non segreto in config — dalla STESSA borsa', () => {
    const r = splitManualServerEnv(
      { envSpec: [{ name: 'A_TOKEN', secret: true }, { name: 'A_URL', secret: false }] },
      { A_TOKEN: 'nuovo-segreto', A_URL: 'https://a.example' }
    )
    expect(r.configEnvValues).toEqual({ A_URL: 'https://a.example' })
    expect(r.sealedEnv).toEqual({ A_TOKEN: 'nuovo-segreto' })
  })

  it('un valore segreto rimasto nella config NON ci resta: finisce nello store', () => {
    const r = splitManualServerEnv({ envSpec: [{ name: 'X_TOKEN', secret: true }] }, { X_TOKEN: 'abc' })
    expect(r.configEnvValues).toEqual({})
    expect(r.sealedEnv).toEqual({ X_TOKEN: 'abc' })
  })

  it('righe non dichiarate in envSpec non portano valori da nessuna parte', () => {
    const r = splitManualServerEnv({ envSpec: [{ name: 'A_URL', secret: false }], envValues: { A_URL: 'https://a', FANTASMA: 'x' } }, {})
    expect(r.configEnvValues).toEqual({ A_URL: 'https://a' })
    expect(r.sealedEnv).toEqual({})
  })

  it('envValues esistenti si conservano quando il segreto nuovo non arriva (modifica: si sostituisce, non si legge)', () => {
    const r = splitManualServerEnv(
      { envSpec: [{ name: 'T', secret: true }], envValues: {} },
      {},
      { T: 'gia-salvato' }
    )
    expect(r.sealedEnv).toEqual({ T: 'gia-salvato' })
  })
})

describe('E1: mergeManualEnvSecrets — in modifica il segreto si sostituisce, le righe tolte spariscono', () => {
  it('i valori NUOVI sovrascrivono, i vecchi di righe ancora dichiarate restano', () => {
    const merged = mergeManualEnvSecrets(
      [{ name: 'A_TOKEN', secret: true }, { name: 'B_TOKEN', secret: true }],
      { A_TOKEN: 'vecchio-a', B_TOKEN: 'vecchio-b', TOCCA: 'fuori-spec' },
      { A_TOKEN: 'nuovo-a' }
    )
    expect(merged).toEqual({ A_TOKEN: 'nuovo-a', B_TOKEN: 'vecchio-b' })
  })

  it('una riga tolta dal form cancella anche il valore dallo store', () => {
    const merged = mergeManualEnvSecrets([{ name: 'A_URL', secret: false }], { A_TOKEN: 'via', A_URL: 'keep' }, {})
    expect(merged).toEqual({})
  })

  it('un nome diventato NON segreto esce dallo store (il valore sta nella config)', () => {
    const merged = mergeManualEnvSecrets([{ name: 'A_URL', secret: false }], { A_URL: 'https://a' }, {})
    expect(merged).toEqual({})
  })
})
