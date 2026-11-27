// P2 (fase ci-percorso-temporanei): GUARDIA — il percorso fisso della
// temporanea del Mac di sviluppo sta SOLO dove c'è l'alternativa. La CI della
// beta.21 era rossa: scripts/esporta-inutilizzati.mjs aveva la T/ del Mac
// scritta fissa e la usava senza alternativa — sul runner di GitHub quella
// cartella non c'è (ENOENT su mkdtemp), sul Mac sì, e per questo la suite era
// verde solo qui. CB1 (ci-beta5) vieta quel percorso nel CODICE dei test;
// qui vale per tutto ciò che la suite CARICA o LANCIA:
//   src/** (il prodotto e i suoi test), scripts/__tests__/** (i test degli
//   script), scripts/lib/** (le aiutanti degli script) e gli script che un
//   test NOMINA con una stringa — lo importi, lo lanci, lo copi da qualche
//   parte come strumento finto o ne legga il sorgente: se un test lo nomina,
//   è affare della suite.
// Il pezzo cercato è la cartella per-utente sotto /var/folders: la base la
// scelgono src/test-tmp.ts (la suite) e scripts/lib/base-temporanea.mjs (gli
// script), che dove non c'è cadono sulla temporanea di sistema; la guardia
// controlla che tutti e due abbiano ancora l'alternativa. I commenti di riga
// non contano (la regola è sul codice, come in CB1); un percorso in un
// commento in coda a una riga di codice viene segnalato — mai il contrario.
// Chi porta il percorso e la suite non lo carica né lo lancia sta in
// FUORI_DALLA_GUARDIA, col perché; l'elenco dev'essere esatto (ogni voce
// corrisponde a un portatore, ogni portatore fuori dalla suite è elencato).
// Da sistemare nella 0.3.2.
// Vista ROSSA sulla base 3fa9142e — l'albero di un commit si legge da git,
// senza checkout (SANDBOT_TEST_PERCORSO_FISSO_REF=3fa9142e):
// scripts/esporta-inutilizzati.mjs:28, e mancava scripts/lib/base-temporanea.mjs.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { RADICE } from './sorgenti'

const FILE_DELLA_GUARDIA = 'src/__tests__/guardie/percorso-fisso.test.ts'
/** Il pezzo che rende quel percorso QUELLO del Mac di sviluppo: la cartella per-utente sotto /var/folders. */
const PEZZO = 'r6fbsdsn3z58bkbb9w55nn780000gn'
/** Gli unici due posti ammessi: quelli che hanno l'alternativa. */
const AMMESSI = ['src/test-tmp.ts', 'scripts/lib/base-temporanea.mjs']
/** I file di codice, con i JSON (le fixture che la suite importa). */
const CODICE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.swift']
/** Il commit da guardare invece dell'albero di lavoro (solo per rivedere la guardia su una base passata: lì è rossa per costruzione). */
const RIF = process.env.SANDBOT_TEST_PERCORSO_FISSO_REF

type Dichiarazione = { file: string; perché: string }
type Portatore = { file: string; righe: number[] }

/**
 * Chi porta il percorso e la guardia NON guarda, col perché. La suite non li
 * lancia: girano solo sul Mac, dove quella cartella c'è. Da sistemare nella
 * 0.3.2 (l'elenco sta nel REPORT della fase). `*` vale per un nome solo.
 */
const FUORI_DALLA_GUARDIA: ReadonlyArray<Dichiarazione> = [
  {
    file: 'scripts/*-probe.mjs',
    perché: "le sonde delle fasi: le lancia fatto.mjs (--sonde) o a mano, sul Mac. La suite non le lancia né le importa: i test *-probe-guard ne leggono il sorgente"
  },
  {
    file: 'scripts/fatto.mjs',
    perché: 'la corsa di fine fase (docs/FATTO.md): si lancia a mano, mai dalla suite. La suite importa solo la sua aiutante, scripts/lib/temporanei-fatto.mjs'
  },
  {
    file: 'scripts/genera-icone.mjs',
    perché: "genera le icone dell'app con l'Electron del repo: si lancia a mano quando cambia build/icon.svg. La suite controlla i file generati, non lo script"
  },
  {
    file: 'scripts/misura-memoria-engramma.ts',
    perché: 'la misura della memoria di Engramma su un utente simulato: si lancia a mano. Nessun test lo nomina'
  },
  // dentro la guardia per regola (scripts/lib/**); fuori perché la suite li carica per le funzioni PURE e non usa la loro T/ del Mac
  {
    file: 'scripts/lib/sonda.mjs',
    perché: 'il motore delle sonde. Lo importa llama-server-della-corsa.test.ts, per classificaLlamaServer e le altre funzioni pure; TMP_BASE lo usano le sonde e la galleria, sul Mac'
  },
  {
    file: 'scripts/lib/primo-avvio.mjs',
    perché: "l'aiutante della riproduzione e della sonda di primo-avvio. Lo importa primo-avvio-probe-guard.test.ts, per resolveTestApp e le altre funzioni pure; TMP_BASE lo usano la riproduzione e la sonda, sul Mac"
  },
  // dentro la guardia perché la suite li carica (sono test); fuori perché il pezzo di percorso è il VALORE ATTESO di un'asserzione, mai una base in cui scrivere
  {
    file: 'scripts/__tests__/primo-avvio-probe-guard.test.ts',
    perché: "la guardia della sonda di primo-avvio controlla CHE la sonda usi la T/ del Mac: il pezzo di percorso è il valore atteso di quell'asserzione (scritto a pezzi per CB1). Cambia con la sonda"
  },
  {
    file: 'scripts/__tests__/schermo-vivo-probe-guard.test.ts',
    perché: 'idem per la sonda fase-schermo-vivo: il valore atteso è la T/ del Mac'
  }
]

// ---- l'albero da guardare ----

/** I file del repo (percorsi relativi, con /): come sono nell'albero di lavoro o in un commit. */
type Albero = {
  file(radice: string, suffissi: readonly string[], escludi?: readonly string[]): string[]
  leggi(rel: string): string
  esiste(rel: string): boolean
}

const alberoDiLavoro = (radice: string): Albero => {
  const scava = (dir: string, suffissi: readonly string[], escludi: readonly string[], out: string[]): string[] => {
    for (const nome of readdirSync(join(radice, dir)).sort()) {
      const rel = dir === '' ? nome : `${dir}/${nome}`
      if (escludi.some((e) => rel.includes(e) || nome === e)) continue
      if (statSync(join(radice, rel)).isDirectory()) scava(rel, suffissi, escludi, out)
      else if (suffissi.some((s) => nome.endsWith(s))) out.push(rel)
    }
    return out
  }
  return {
    file: (dir, suffissi, escludi = []) => scava(dir, suffissi, escludi, []),
    leggi: (rel) => readFileSync(join(radice, rel), 'utf8'),
    esiste: (rel) => {
      try {
        return statSync(join(radice, rel)).isFile()
      } catch {
        return false
      }
    }
  }
}

/** L'albero di un commit com'era, letto da git (ls-tree e cat-file): niente checkout, il ramo non cambia. */
const alberoDiGit = (rif: string): Albero => {
  const git = (args: readonly string[], input?: string): Buffer => {
    const r = spawnSync('git', args, { cwd: RADICE, input, maxBuffer: 1 << 28 })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr)}`)
    return r.stdout
  }
  const sha = new Map<string, string>()
  for (const riga of git(['ls-tree', '-r', rif, '--', 'src', 'scripts']).toString('utf8').split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(riga)
    if (m) sha.set(m[2]!, m[1]!)
  }
  // i file di codice si prendono TUTTI IN UNA volta: cat-file --batch risponde nello stesso ordine, «sha tipo dimensione», il contenuto e un a-capo
  const contenuti = new Map<string, string>()
  const daLeggere = [...sha.keys()].filter((f) => CODICE.some((s) => f.endsWith(s)))
  const out = git(['cat-file', '--batch'], `${daLeggere.map((f) => sha.get(f)).join('\n')}\n`)
  let i = 0
  for (const f of daLeggere) {
    const fine = out.indexOf(10, i)
    const dimensione = Number(out.subarray(i, fine).toString('utf8').split(' ')[2])
    contenuti.set(f, out.subarray(fine + 1, fine + 1 + dimensione).toString('utf8'))
    i = fine + 1 + dimensione + 1
  }
  return {
    file: (dir, suffissi, escludi = []) =>
      [...sha.keys()].filter((f) => f.startsWith(`${dir}/`) && suffissi.some((s) => f.endsWith(s)) && !escludi.some((e) => f.includes(e))).sort(),
    leggi: (rel) => contenuti.get(rel) ?? String(git(['show', `${rif}:${rel}`])),
    esiste: (rel) => sha.has(rel)
  }
}

/** L'albero finto delle prove della guardia: un dizionario percorso → testo. */
const alberoFinto = (file: Record<string, string>): Albero => ({
  file: (dir, suffissi, escludi = []) =>
    Object.keys(file).filter((f) => f.startsWith(`${dir}/`) && suffissi.some((s) => f.endsWith(s)) && !escludi.some((e) => f.includes(e))).sort(),
  leggi: (rel) => {
    const testo = file[rel]
    if (testo === undefined) throw new Error(`nell'albero finto non c'è ${rel}`)
    return testo
  },
  esiste: (rel) => Object.hasOwn(file, rel)
})

// ---- la regola ----

/** Una riga di commento (per intero): non è codice. */
const èCommento = (riga: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(riga)

/** Le righe di CODICE con il pezzo di percorso, numerate da 1. */
const righeColPercorso = (testo: string): number[] =>
  testo.split('\n').flatMap((riga, i) => (!èCommento(riga) && riga.includes(PEZZO) ? [i + 1] : []))

/** Le stringhe letterali di un testo: fra apici singoli, doppi, o backtick SENZA interpolazione. */
const stringhe = (testo: string): string[] =>
  [...testo.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')

/**
 * Gli script di scripts/ che i test NOMINANO con una stringa: `scripts/x.mjs`,
 * l'ultimo pezzo di una join, un percorso relativo al test (anche dentro un
 * import). Solo i file che esistono.
 */
function scriptNominatiDaiTest(albero: Albero, test: readonly string[]): Set<string> {
  const trovati = new Set<string>()
  const prova = (candidato: string): void => {
    if (candidato.startsWith('scripts/') && albero.esiste(candidato)) trovati.add(candidato)
  }
  for (const t of test) {
    const codice = albero.leggi(t).split('\n').filter((riga) => !èCommento(riga)).join('\n')
    for (const s of stringhe(codice)) {
      if (s === '') continue
      prova(normalize(join('scripts', s)))
      if (s.startsWith('scripts/')) prova(normalize(s))
      prova(normalize(join(dirname(t), s)))
    }
  }
  return trovati
}

/** Una voce con `*` (che vale per un nome solo) diventa un'espressione. */
const combina = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)

type Esito = {
  /** file che la suite carica o lancia, non ammessi e non dichiarati, col percorso nel codice */
  violazioni: Portatore[]
  /** i due posti ammessi che mancano, che non portano il percorso o che non hanno l'alternativa */
  senzaAlternativa: string[]
  /** voci dichiarate a cui non corrisponde più nessun portatore: da togliere */
  vociScadute: string[]
  /** portatori che la suite non carica né lancia e nessuno ha dichiarato */
  nonDichiarati: Portatore[]
  /** gli script che i test nominano: se la lettura si rompe, la guardia non resta verde a vuoto */
  nominati: string[]
}

/** PURA rispetto all'albero: applica la regola e le dichiarazioni. */
function guarda(albero: Albero, fuori: readonly Dichiarazione[]): Esito {
  // scripts/vetrina non è del repo (non tracciata) e per vincolo resta intatta: come nelle altre guardie
  const tutti = [...albero.file('src', CODICE), ...albero.file('scripts', CODICE, ['vetrina/'])].filter((f) => f !== FILE_DELLA_GUARDIA)
  const portatori = tutti.map((file) => ({ file, righe: righeColPercorso(albero.leggi(file)) })).filter((p) => p.righe.length > 0)
  const èTest = (f: string): boolean => /\.test\.tsx?$/.test(f) && (f.startsWith('scripts/__tests__/') || (f.startsWith('src/') && f.includes('/__tests__/')))
  const nominati = [...scriptNominatiDaiTest(albero, tutti.filter(èTest))].sort()
  const caricaOLancia = (file: string): boolean =>
    file.startsWith('src/') || file.startsWith('scripts/__tests__/') || file.startsWith('scripts/lib/') || nominati.includes(file)
  const dichiarato = (file: string): boolean => fuori.some((d) => combina(d.file).test(file))
  const ammesso = (file: string): boolean => AMMESSI.includes(file)
  return {
    violazioni: portatori.filter((p) => caricaOLancia(p.file) && !ammesso(p.file) && !dichiarato(p.file)),
    senzaAlternativa: AMMESSI.filter((a) => {
      if (!albero.esiste(a)) return true
      const testo = albero.leggi(a)
      return righeColPercorso(testo).length === 0 || !/tmpdir\(\)/.test(testo)
    }),
    vociScadute: fuori.filter((d) => !portatori.some((p) => combina(d.file).test(p.file))).map((d) => d.file),
    nonDichiarati: portatori.filter((p) => !ammesso(p.file) && !dichiarato(p.file) && !caricaOLancia(p.file)),
    nominati
  }
}

const dove = (p: Portatore): string => `  ${p.file}:${p.righe.join(', ')}`

describe(`P2 (fase ci-percorso-temporanei): il percorso fisso del Mac sta solo dove c'è l'alternativa${RIF === undefined ? '' : ` — albero del commit ${RIF}`}`, () => {
  let calcolato: Esito | undefined
  const esito = (): Esito => (calcolato ??= guarda(RIF === undefined ? alberoDiLavoro(RADICE) : alberoDiGit(RIF), FUORI_DALLA_GUARDIA))

  it('nei file che la suite carica o lancia compare solo in src/test-tmp.ts e in scripts/lib/base-temporanea.mjs', { timeout: 60_000 }, () => {
    const { violazioni } = esito()
    const dichiarati = FUORI_DALLA_GUARDIA.filter((d) => !esito().vociScadute.includes(d.file)).map((d) => `${d.file} (${d.perché})`)
    expect(
      violazioni,
      `il percorso fisso del Mac (cartella ${PEZZO}) nel codice di ${violazioni.length} file che la suite carica o lancia:\n${violazioni.map(dove).join('\n')}\n` +
        `la base delle mkdtemp la scelgono src/test-tmp.ts (la suite) e scripts/lib/base-temporanea.mjs (gli script), che dove quella cartella non c'è cadono sulla temporanea di sistema: ` +
        `chi la scrive fissa cade con ENOENT sul runner di GitHub (la CI della beta.21).\n` +
        `fuori dalla guardia, dichiarati col perché in FUORI_DALLA_GUARDIA: ${dichiarati.join(' · ')}`
    ).toEqual([])
  })

  it('i due posti ammessi esistono, portano il percorso e hanno l\'alternativa (la temporanea di sistema)', () => {
    expect(esito().senzaAlternativa, `posti ammessi senza il percorso o senza l'alternativa: ${esito().senzaAlternativa.join(', ')}`).toEqual([])
  })

  it('chi porta il percorso e la suite non lo carica né lo lancia è dichiarato fuori col perché, e le dichiarazioni sono esatte', () => {
    const { vociScadute, nonDichiarati } = esito()
    const ricevuto = { vociScadute, nonDichiarati: nonDichiarati.map(dove) }
    expect(
      ricevuto,
      `portatori che la suite non carica né lancia e nessuno ha dichiarato (vanno in FUORI_DALLA_GUARDIA col perché):\n${nonDichiarati.map(dove).join('\n')}\n` +
        `voci dichiarate senza più nessun portatore (da togliere): ${vociScadute.join(', ')}`
    ).toEqual({ vociScadute: [], nonDichiarati: [] })
  })

  it('vede gli script che i test nominano — almeno quello della CI della beta.21', () => {
    expect(esito().nominati).toContain('scripts/esporta-inutilizzati.mjs')
  })
})

describe('la guardia si prova su un albero finto', () => {
  // il percorso del Mac lo si costruisce a pezzi: nel codice dei TEST non può esserci il letterale (guardia CB1)
  const T_DEL_MAC = ['var', 'folders', 'nb', PEZZO, 'T'].join('/')
  const FINTO: Record<string, string> = {
    'src/test-tmp.ts': `export const DEV_TMP = '/${T_DEL_MAC}'\nexport const TEST_TMP_BASE = existsSync(DEV_TMP) ? DEV_TMP : realpathSync(tmpdir())\n`,
    'scripts/lib/base-temporanea.mjs': `export const DEV_TMP = '/${T_DEL_MAC}'\nexport const base = () => (existsSync(DEV_TMP) ? DEV_TMP : realpathSync(tmpdir()))\n`
  }

  it('uno script che un test NOMINA e porta il percorso è rosso, con file e riga; un percorso solo in un commento no', () => {
    const esito = guarda(
      alberoFinto({
        ...FINTO,
        'src/x/__tests__/t.test.ts': "const r = spawnSync('node', [join(RADICE, 'scripts', 'esporta.mjs')], {})\n",
        'scripts/esporta.mjs': `// la T/ del Mac: /${T_DEL_MAC}\nconst DEV_TMP = '/${T_DEL_MAC}'\nconst ALTRO = 1\n`,
        'scripts/solo-commento.mjs': `// /${T_DEL_MAC}\nexport const x = 1\n`
      }),
      []
    )
    expect(esito.violazioni).toEqual([{ file: 'scripts/esporta.mjs', righe: [2] }])
    expect(esito.nonDichiarati.map((p) => p.file)).toEqual([])
  })

  it('un test nomina uno script in ognuno dei modi del repo: percorso intero, ultimo pezzo di una join, relativo al test, dentro un import', () => {
    const albero = alberoFinto({
      ...FINTO,
      'scripts/__tests__/t.test.ts': [
        "const a = resolve('scripts/a.mjs')",
        "const b = join(ROOT, 'scripts', 'b.mjs')",
        "const c = new URL('../c.mjs', import.meta.url)",
        "const { d } = await import('../lib/d.mjs')",
        "const ignora = resolve('scripts/non-esiste.mjs')"
      ].join('\n'),
      'scripts/a.mjs': '',
      'scripts/b.mjs': '',
      'scripts/c.mjs': '',
      'scripts/lib/d.mjs': ''
    })
    expect(guarda(albero, []).nominati).toEqual(['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/lib/d.mjs'])
  })

  it('chi porta il percorso e nessun test lo nomina va DICHIARATO fuori, col perché; una voce senza portatori è scaduta', () => {
    const albero = alberoFinto({ ...FINTO, 'scripts/fatto.mjs': `const TMP_BASE = '/${T_DEL_MAC}'\n` })
    // senza dichiarazione: non è una violazione (la suite non lo carica), ma resta fuori dall'elenco
    expect(guarda(albero, []).violazioni).toEqual([])
    expect(guarda(albero, []).nonDichiarati.map((p) => p.file)).toEqual(['scripts/fatto.mjs'])
    const dichiarato = guarda(albero, [{ file: 'scripts/fatto.mjs', perché: 'la corsa di fine fase' }])
    expect(dichiarato.violazioni).toEqual([])
    expect(dichiarato.nonDichiarati).toEqual([])
    expect(guarda(albero, [...FUORI_DALLA_GUARDIA]).vociScadute).toEqual(FUORI_DALLA_GUARDIA.filter((d) => d.file !== 'scripts/fatto.mjs').map((d) => d.file))
  })

  it('scripts/lib e i test degli script sono DENTRO anche se nessun test li nomina: chi porta il percorso va dichiarato; una voce con * copre tutte le sonde', () => {
    const albero = alberoFinto({
      ...FINTO,
      'scripts/fase-x-probe.mjs': `const TMP_BASE = '/${T_DEL_MAC}'\n`,
      'scripts/__tests__/x-probe-guard.test.ts': "const s = readFileSync(new URL('../fase-x-probe.mjs', import.meta.url))\n",
      'scripts/__tests__/y.test.ts': `const T = '/${T_DEL_MAC}'\n`,
      'scripts/lib/aiuto.mjs': `export const TMP_BASE = '/${T_DEL_MAC}'\n`,
      'scripts/vetrina/lib.mjs': `export const TMP_BASE = '/${T_DEL_MAC}'\n`
    })
    const sonde: Dichiarazione = { file: 'scripts/*-probe.mjs', perché: 'le sonde girano solo sul Mac' }
    expect(guarda(albero, [sonde]).violazioni.map((p) => p.file)).toEqual(['scripts/__tests__/y.test.ts', 'scripts/lib/aiuto.mjs'])
    const tutto = guarda(albero, [sonde, { file: 'scripts/lib/aiuto.mjs', perché: 'un\'aiutante delle sonde' }, { file: 'scripts/__tests__/y.test.ts', perché: 'il valore atteso di un\'asserzione' }])
    expect(tutto.violazioni).toEqual([])
    expect(tutto.nonDichiarati).toEqual([]) // la vetrina non è del repo: non si guarda
  })

  it('i due posti ammessi devono avere l\'alternativa: senza la temporanea di sistema sono rossi', () => {
    const senza = guarda(alberoFinto({ ...FINTO, 'scripts/lib/base-temporanea.mjs': `export const DEV_TMP = '/${T_DEL_MAC}'\n` }), [])
    expect(senza.senzaAlternativa).toEqual(['scripts/lib/base-temporanea.mjs'])
    expect(guarda(alberoFinto(FINTO), []).senzaAlternativa).toEqual([])
  })
})
