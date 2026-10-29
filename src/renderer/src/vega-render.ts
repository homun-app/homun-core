// La resa Vega-Lite LATO RENDERER per l'anteprima dei blocchi ```vega-lite
// incorporati nei documenti (fase 14, punto 3): stessa grammatica dichiarativa
// e stesse difese del daemon — dati SOLO inline, nessuna chiave url, nessun
// loader, e il LOADER di vega che rifiuta ogni richiesta (nessuna rete). Il
// SVG risultante NON entra mai nel DOM: il chiamante lo mette in un <img>.
/** Il loader che rifiuta TUTTO (come nel daemon: nessuna richiesta di rete). */
const REJECTING_LOADER = {
  load(): Promise<never> {
    return Promise.reject(new Error('caricamento dati vietato'))
  },
  http(): Promise<never> {
    return Promise.reject(new Error('richiesta di rete vietata'))
  }
}

/** Cerca una chiave vietata a qualunque profondità (come charts.ts). */
function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key))
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key || hasKey(v, key)) return true
    }
  }
  return false
}

/**
 * Vega-Lite → SVG nel renderer (anteprima): valida la spec (JSON, dati solo
 * inline, niente url/loader), compila e rende col loader che rifiuta. Torna
 * null se la spec non è valida o la resa fallisce (il chiamante mostra il
 * sorgente come codice).
 */
export async function renderVegaLiteInRenderer(specText: string): Promise<string | null> {
  try {
    const spec = JSON.parse(specText) as unknown
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return null
    if (hasKey(spec, 'url') || hasKey(spec, 'loader')) return null
    const vegaLite = await import('vega-lite')
    const vega = await import('vega')
    const compiled = vegaLite.compile(spec as Parameters<typeof vegaLite.compile>[0])
    const view = new vega.View(vega.parse(compiled.spec), {
      renderer: 'none',
      loader: REJECTING_LOADER as unknown as import('vega').Loader
    })
    try {
      return await view.toSVG()
    } finally {
      view.finalize()
    }
  } catch {
    return null
  }
}
