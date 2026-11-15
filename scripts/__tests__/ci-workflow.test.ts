// Fase rilascio di prova (RP1) · CORREZIONI (RQ1): il workflow di CI letto
// come YAML — la CI deve poter costruire Homun da zero (Engramma e llama-
// server dagli ASSET pubblici, prima di electron-builder) e la prova nasce
// BOZZA: diventa prerelease pubblica SOLO all'ultimo step, dopo verifica,
// note e checksum (una prova non verificata non sta MAI nel feed).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

interface Step {
  name?: string
  if?: string
  run?: string
  env?: Record<string, unknown>
}
interface Job {
  name?: string
  'runs-on'?: string
  if?: string
  permissions?: Record<string, string>
  'timeout-minutes'?: number
  steps: Step[]
}
interface Workflow {
  on?: { push?: { branches?: string[]; tags?: string[] }; pull_request?: { branches?: string[] }; workflow_dispatch?: unknown }
  jobs: Record<string, Job> & { build: Job }
}

const WF_PATH = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'build.yml')
const wf = load(readFileSync(WF_PATH, 'utf8')) as Workflow
const steps = wf.jobs.build.steps
const runOf = (s: Step): string => s.run ?? ''

describe('fase rilascio di prova (RP1): la CI prepara i vendor nativi dagli asset', () => {
  it('uno step esegue prepare-engramma E fetch-llama insieme', () => {
    const prepare = steps.find((s) => runOf(s).includes('node scripts/prepare-engramma.mjs') && runOf(s).includes('node scripts/fetch-llama.mjs'))
    expect(prepare, 'manca lo step che prepara Engramma e llama-server in CI').toBeDefined()
  })

  it('lo step viene PRIMA di ogni electron-builder', () => {
    const prepareIdx = steps.findIndex((s) => runOf(s).includes('node scripts/prepare-engramma.mjs') && runOf(s).includes('node scripts/fetch-llama.mjs'))
    expect(prepareIdx).toBeGreaterThanOrEqual(0)
    const builderIdxs = steps.map((s, i) => (runOf(s).includes('electron-builder') ? i : -1)).filter((i) => i >= 0)
    expect(builderIdxs.length).toBeGreaterThan(0)
    for (const i of builderIdxs) {
      expect(prepareIdx, `lo step di preparazione (${prepareIdx}) deve precedere electron-builder (${i})`).toBeLessThan(i)
    }
  })

  it('lo step di preparazione non usa segreti: gli asset sono pubblici', () => {
    const prepare = steps.find((s) => runOf(s).includes('node scripts/prepare-engramma.mjs') && runOf(s).includes('node scripts/fetch-llama.mjs'))
    expect(prepare, 'manca lo step che prepara Engramma e llama-server in CI').toBeDefined()
    expect(Object.keys(prepare?.env ?? {})).toEqual([])
  })
})

// Fase ci-beta5 (CB4): la CI della beta.5 era rossa PERCHÉ i test giravano
// solo sui tag v* — la prima volta che la suite ha corso sul runner (macos-15)
// ha trovato i sette test che dipendevano dalla macchina. Un job leggero
// «Typecheck and tests» parte a OGNI push su main e sulle PR: niente build,
// niente firma, niente segreti. Il job di build resta com'era (tag v*, PR,
// dispatch) e NON parte sui push di main.
describe('fase ci-beta5 (CB4): i test girano a ogni push su main', () => {
  const light = (): Job => {
    const j = Object.values(wf.jobs).find((job) => (job.name ?? '').includes('Typecheck and tests'))
    expect(j, 'manca il job leggero «Typecheck and tests»').toBeDefined()
    return j as Job
  }

  it('il workflow parte anche sui PUSH a main (i tag v* e le PR restano)', () => {
    expect(wf.on?.push?.branches ?? [], 'on.push deve includere main').toContain('main')
    expect(wf.on?.push?.tags ?? []).toContain('v*')
    expect(wf.on?.pull_request?.branches ?? []).toContain('main')
  })

  it('il job leggero fa SOLO typecheck e test: niente electron-builder, niente upload, niente release', () => {
    const runs = light().steps.map(runOf).join('\n')
    expect(runs).toContain('npm run typecheck')
    expect(runs).toContain('npm test')
    // i vendor nativi si preparano anche qui: i test li vogliono (pretest fa
    // il fast path, ma fetch-llama spetta a chi lancia)
    expect(runs).toContain('node scripts/prepare-engramma.mjs')
    expect(runs).toContain('node scripts/fetch-llama.mjs')
    for (const banned of ['electron-builder', 'gh release', 'upload-artifact', 'notarytool']) {
      expect(runs, `il job leggero non deve fare «${banned}»`).not.toContain(banned)
    }
  })

  it('il job leggero: permissions contents: read, NESSUN segreto, NESSUN github.event.* negli step run', () => {
    const j = light()
    expect(j.permissions).toEqual({ contents: 'read' })
    for (const s of j.steps) {
      const run = runOf(s)
      expect(run, `«${s.name}» interpola github.event.* in uno step run`).not.toContain('github.event')
      const env = Object.values(s.env ?? {}).map(String).join(' ')
      expect(env, `«${s.name}» usa un segreto`).not.toContain('${{ secrets.')
      expect(run, `«${s.name}» usa un segreto`).not.toContain('${{ secrets.')
    }
  })

  it('il job di build NON parte sui push di main: resta com\'era su tag v*, PR e dispatch', () => {
    const cond = wf.jobs.build.if ?? ''
    expect(cond, 'al job di build serve la guardia che esclude i push di main').toContain('refs/tags/v')
    expect(cond).toContain('pull_request')
    expect(cond).toContain('workflow_dispatch')
    // e i SUOI step non cambiano: la firma e la pubblicazione restano ai tag
    expect(steps.some((s) => runOf(s).includes('electron-builder'))).toBe(true)
  })
})

describe('fase rilascio di prova (RP3): il dmg graffato si ricarica sulla release', () => {
  it('il dmg graffato si ricarica per OGNI tag: lo step non distingue bozza da prerelease', () => {
    const staple = steps.find((s) => runOf(s).includes('gh release upload') && runOf(s).includes('--clobber') && runOf(s).includes('notarytool'))
    expect(staple, 'manca lo step notarize+staple+ricarica del dmg').toBeDefined()
    expect(staple?.if ?? '').toContain('refs/tags/v')
    expect(staple?.if ?? '').not.toMatch(/beta|draft|prerelease/)
  })
})

// RQ1 (correzioni): lo schema «bozza, controlli, poi pubblicazione». Lo step
// di electron-builder NON pubblica mai prerelease: la release nasce BOZZA e
// l'ULTIMO step (dopo verify, note e checksum) la trasforma in prerelease
// pubblica SOLO per i tag v*-beta.*. Prima EP_PRE_RELEASE la rendeva già
// pubblica dentro electron-builder: un fallimento dopo (notarizzazione,
// verify-release, note, checksum) lasciava nel feed una prova non verificata.
describe('fase rilascio di prova · correzioni (RQ1): la prova diventa pubblica solo alla fine', () => {
  /** Lo step che pubblica la prerelease (se c'è). */
  const publishPrerelease = (): { step: Step | undefined; idx: number } => {
    const idx = steps.findIndex(
      (s) => runOf(s).includes('gh release edit') && runOf(s).includes('--draft=false') && runOf(s).includes('--prerelease')
    )
    return { step: steps[idx], idx }
  }

  it('NESSUNO step imposta EP_PRE_RELEASE: la release nasce SEMPRE bozza (EP_DRAFT)', () => {
    const offenders = steps.filter((s) => Object.keys(s.env ?? {}).includes('EP_PRE_RELEASE')).map((s) => s.name)
    expect(offenders, `EP_PRE_RELEASE ancora impostato da: ${offenders.join(', ')}`).toEqual([])
    // e il publish step lo dichiara esplicito: EP_DRAFT 'true' (il default,
    // ma detto a parole) — mai più una prerelease da electron-builder
    const publish = steps.find((s) => runOf(s).includes('electron-builder') && runOf(s).includes('--publish always'))
    expect(publish, 'manca lo step di publish firmato').toBeDefined()
    expect(publish?.env?.EP_DRAFT).toBe('true')
  })

  it('l\'ULTIMO step pubblica la prova: gh release edit --draft=false --prerelease, SOLO per i tag -beta.', () => {
    const { step } = publishPrerelease()
    expect(step, 'manca lo step che pubblica la prerelease alla fine').toBeDefined()
    // la condizione del canale di prova: solo i v*-beta.*
    expect(step?.if ?? '').toContain('-beta.')
    expect(step?.if ?? '').toContain('refs/tags/v')
    // e solo col certificato (una build non firmata non finisce nel feed)
    expect(step?.if ?? '').toContain("steps.signing.outputs.has_cert == 'true'")
  })

  it('lo step di pubblicazione VERIFICA lo stato: isDraft=false e isPrerelease=true, o fallisce', () => {
    const { step } = publishPrerelease()
    expect(step, 'manca lo step che pubblica la prerelease alla fine').toBeDefined()
    const run = runOf(step)
    expect(run).toContain('gh release view')
    expect(run).toContain('isDraft')
    expect(run).toContain('isPrerelease')
  })

  it('viene DOPO «Verify packaged app», «Set release notes» e «Upload checksums»', () => {
    const { idx } = publishPrerelease()
    expect(idx, 'manca lo step che pubblica la prerelease alla fine').toBeGreaterThanOrEqual(0)
    const after = (namePart: string): number => {
      const i = steps.findIndex((s) => (s.name ?? '').includes(namePart))
      expect(i, `manca lo step «${namePart}»`).toBeGreaterThanOrEqual(0)
      return i
    }
    // la pubblicazione è l'ULTIMA cosa: prima TUTTI i controlli e i caricamenti
    expect(idx, 'deve venire dopo «Verify packaged app»').toBeGreaterThan(after('Verify packaged app'))
    expect(idx, 'deve venire dopo «Set release notes»').toBeGreaterThan(after('Set release notes'))
    expect(idx, 'deve venire dopo «Upload checksums»').toBeGreaterThan(after('Upload checksums'))
  })

  it('NESSUNO step successivo carica file sulla release', () => {
    const { idx } = publishPrerelease()
    expect(idx, 'manca lo step che pubblica la prerelease alla fine').toBeGreaterThanOrEqual(0)
    for (const s of steps.slice(idx + 1)) {
      expect(runOf(s), `«${s.name}» carica file sulla release DOPO la pubblicazione`).not.toContain('gh release upload')
      expect(runOf(s), `«${s.name}» tocca la release DOPO la pubblicazione`).not.toContain('gh release edit')
    }
  })
})
