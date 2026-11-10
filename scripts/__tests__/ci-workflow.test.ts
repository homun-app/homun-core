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
interface Workflow {
  jobs: { build: { steps: Step[] } }
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
