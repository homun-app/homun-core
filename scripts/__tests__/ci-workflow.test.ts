// Fase rilascio di prova (RP1/RP3): il workflow di CI letto come YAML — la
// CI deve poter costruire Homun da zero (Engramma e llama-server dagli ASSET
// pubblici, prima di electron-builder) e i tag v*-beta.* devono uscire come
// PRERELEASE NON BOZZA (il canale di prova li vede; le bozze no).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

interface Step {
  name?: string
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
