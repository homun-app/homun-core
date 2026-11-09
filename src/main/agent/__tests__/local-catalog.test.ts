// Fase locale (L3.2/L3.3): il catalogo in codice del modello integrato e
// l'idoneità della macchina (pure, nessuna dipendenza). L'URL del download
// usa la REVISIONE fissata, mai main; una sola voce oggi (Qwen3.5-4B).
import { describe, expect, it } from 'vitest'
import {
  LOCAL_MODEL_CATALOG, downloadUrlOf, localModelInstalledPath, localEligibility, LOCAL_MODEL_ID
} from '../local-catalog'

describe('fase locale (L3.2): il catalogo in codice', () => {
  it('UNA sola voce: qwen3.5-4b coi dati fissati dalla misura', () => {
    expect(LOCAL_MODEL_CATALOG).toHaveLength(1)
    const e = LOCAL_MODEL_CATALOG[0]!
    expect(e.id).toBe('qwen3.5-4b')
    expect(e.repo).toBe('lmstudio-community/Qwen3.5-4B-GGUF')
    expect(e.revision).toBe('f9f88ac3e234be915e23811a6d28ea287bdb927e')
    expect(e.file).toBe('Qwen3.5-4B-Q4_K_M.gguf')
    expect(e.sizeBytes).toBe(2_707_513_696)
    expect(e.sha256).toBe('25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c')
    expect(e.license).toBe('apache-2.0')
    expect(e.minRamGb).toBe(16)
    expect(e.ramUseGb).toBe(4.5)
    expect(LOCAL_MODEL_ID).toBe('qwen3.5-4b')
  })

  it('l\'URL usa la REVISIONE, MAI main', () => {
    for (const e of LOCAL_MODEL_CATALOG) {
      const url = downloadUrlOf(e)
      expect(url).toBe(`https://huggingface.co/${e.repo}/resolve/${e.revision}/${e.file}`)
      expect(url).not.toContain('/main/')
      expect(url).not.toMatch(/\/resolve\/main\//)
    }
  })

  it('il percorso installato è <modelsDir>/<file>', () => {
    const e = LOCAL_MODEL_CATALOG[0]!
    expect(localModelInstalledPath(e, '/data/models')).toBe('/data/models/' + e.file)
  })
})

describe('fase locale (L3.3): localEligibility — tutte le combinazioni', () => {
  const G = 1024 ** 3
  const size = LOCAL_MODEL_CATALOG[0]!.sizeBytes
  const free = size + 2 * G // quanto basta

  it('arm64 con RAM ≥ 16 → ok', () => {
    expect(localEligibility({ arch: 'arm64', ramGb: 16, freeDiskBytes: free })).toEqual({ status: 'ok' })
    expect(localEligibility({ arch: 'arm64', ramGb: 64, freeDiskBytes: free })).toEqual({ status: 'ok' })
  })

  it('arm64 con RAM < 16 → discouraged (si può, con l\'avviso forte)', () => {
    expect(localEligibility({ arch: 'arm64', ramGb: 8, freeDiskBytes: free })).toEqual({ status: 'discouraged' })
    expect(localEligibility({ arch: 'arm64', ramGb: 15, freeDiskBytes: free })).toEqual({ status: 'discouraged' })
  })

  it('Intel → unsupported (qualsiasi RAM)', () => {
    const v = localEligibility({ arch: 'x64', ramGb: 64, freeDiskBytes: free })
    expect(v.status).toBe('unsupported')
    const v2 = localEligibility({ arch: 'ia32', ramGb: 8, freeDiskBytes: free })
    expect(v2.status).toBe('unsupported')
  })

  it('disco < dimensione + 2 GB → no-space con quanti GB servono', () => {
    const v = localEligibility({ arch: 'arm64', ramGb: 32, freeDiskBytes: size })
    expect(v.status).toBe('no-space')
    if (v.status === 'no-space') {
      expect(v.neededGb).toBeCloseTo((size + 2 * G) / G, 1)
      expect(v.freeGb).toBeCloseTo(size / G, 1)
    }
  })

  it('disco sconosciuto (null): non è no-space, decide la RAM', () => {
    expect(localEligibility({ arch: 'arm64', ramGb: 16, freeDiskBytes: null })).toEqual({ status: 'ok' })
    expect(localEligibility({ arch: 'arm64', ramGb: 8, freeDiskBytes: null }).status).toBe('discouraged')
  })

  it('Intel senza spazio resta unsupported (l\'architettura viene prima)', () => {
    expect(localEligibility({ arch: 'x64', ramGb: 64, freeDiskBytes: 0 }).status).toBe('unsupported')
  })
})
