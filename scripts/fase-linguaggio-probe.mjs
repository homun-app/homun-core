#!/usr/bin/env node
// C5 (fase linguaggio): la sonda che CONFRONTA LE PAGINE FRA LORO. Il
// linguaggio grafico è UNO: due pagine dello stesso modello non possono
// differire di un pixel. In 1280×800 e 900×640, chiaro e scuro, su Plugin
// (ogni scheda), la scheda di un plugin, Attività, Libreria (griglia e
// lista), Da approvare, Registro e le Impostazioni (le sezioni con elenco),
// misura:
//   · il bordo sinistro e la larghezza del CONTENUTO;
//   · la y e l'altezza della BARRA degli strumenti;
//   · la x e l'altezza della RICERCA;
//   · l'altezza delle PILLOLE di filtro;
//   · l'altezza minima delle RIGHE di elenco;
//   · la posizione (dal fondo riga) e la misura dell'AZIONE IN RIGA.
// Fallisce se due pagine dello stesso modello differiscono anche di 1 px, o
// se una pagina cambia larghezza cambiando scheda. Uscita 1 col conteggio.
import { avviaSonda, ROOT } from './lib/sonda.mjs'
import { PAGES, preparaDeterministica, closeOverlays, openPage, openOverlay, ISTANTE_FERMO } from './lib/scene.mjs'
import { modelloFinto } from './lib/modello-finto.mjs'

const log = (...a) => console.log('[fase-linguaggio]', ...a)

/** Le pagine misurate, col loro MODELLO: due pagine dello stesso modello sono lo stesso disegno. */
const MISURATE = [
  { id: 'plugin-lista', modello: 'elenco' },
  { id: 'plugin-connettori', modello: 'elenco' },
  { id: 'plugin-skill', modello: 'elenco' },
  { id: 'plugin-collegati', modello: 'elenco' },
  { id: 'attivita', modello: 'elenco' },
  { id: 'libreria-griglia', modello: 'elenco' },
  { id: 'libreria-lista', modello: 'elenco' },
  { id: 'da-approvare', modello: 'elenco' },
  { id: 'registro', modello: 'elenco' },
  { id: 'plugin-scheda', modello: 'scheda' },
  { id: 'impostazioni-generali', modello: 'dialogo' },
  { id: 'impostazioni-approvazioni', modello: 'dialogo' },
  { id: 'impostazioni-uso', modello: 'dialogo' }
]

/** LE MISURE di una pagina aperta, prese nel DOM (interi: l'1 px conta). */
const MISURA_JS = `return (() => {
  const tondo = (x) => Math.round(x)
  const pagina = document.querySelector('[data-page-shell="root"]')
  // il dialogo delle Impostazioni non è un PageShell: il suo corpo che scorre
  const scorre = pagina?.querySelector('[data-page-shell="scroll"]')
    ?? [...document.querySelectorAll('[role="dialog"] [data-page-content]')].find((e) => e.getClientRects().length > 0)?.parentElement
    ?? null
  const contenuto = scorre?.querySelector('[data-page-content]')
    ?? [...document.querySelectorAll('[role="dialog"] [data-page-content]')].find((e) => e.getClientRects().length > 0)
    ?? null
  const out = { contenuto: null, barra: null, ricerca: null, pillole: null, righe: null, azione: null }
  if (!contenuto) return out
  const rc = contenuto.getBoundingClientRect()
  out.contenuto = { sx: tondo(rc.left), larghezza: tondo(rc.width) }
  const barra = [...document.querySelectorAll('[data-page-shell="toolbar"]')].find((e) => e.getClientRects().length > 0)
    ?? [...document.querySelectorAll('[role="dialog"] nav')].find((e) => e.getClientRects().length > 0)?.closest('div[class*="min-h-10"]') ?? null
  if (barra) {
    const rb = barra.getBoundingClientRect()
    out.barra = { y: tondo(rb.top), altezza: tondo(rb.height) }
    const campo = [...barra.querySelectorAll('input')].find((i) => i.type === 'search' || /-search$/.test(i.dataset.testid ?? ''))
    if (campo) {
      const casa = campo.closest('label') ?? campo
      const rr = casa.getBoundingClientRect()
      out.ricerca = { x: tondo(rr.left), altezza: tondo(rr.height) }
    }
    const pillole = [...barra.querySelectorAll('button')].filter((b) => (b.className ?? '').includes('rounded-full') && b.closest('[role="group"]'))
    if (pillole.length > 0) out.pillole = { altezza: Math.round(Math.min(...pillole.map((p) => p.getBoundingClientRect().height))) }
  }
  // le RIGHE: la min-height DICHIARATA (la computed), non l'altezza del
  // contenuto — una riga con due righe di sottotitolo è più alta per il
  // contenuto, non per un'altra lingua grafica
  const righe = [...(scorre ?? contenuto).querySelectorAll('.min-h-row, .min-h-row-text')].filter((r) => r.getClientRects().length > 0 && r.getBoundingClientRect().height > 0)
  if (righe.length > 0) {
    out.righe = { altezzaMinima: Math.round(Math.min(...righe.map((r) => Number.parseFloat(getComputedStyle(r).minHeight)))) }
    for (const riga of righe) {
      const azione = [...riga.querySelectorAll('[data-slot="button"]')].find((b) => b.getClientRects().length > 0)
      if (azione) {
        const ra = azione.getBoundingClientRect()
        const rr2 = riga.getBoundingClientRect()
        out.azione = { altezza: tondo(ra.height), dalFondo: tondo(rr2.bottom - ra.bottom) }
        break
      }
    }
  }
  return out
})()`

const run = async () => {
  const modello = modelloFinto()
  const porta = await modello.avvia()
  const s = await avviaSonda({
    prefix: 'sandbot-fase-linguaggio',
    envExtra: {},
    orologioFermo: new Date(ISTANTE_FERMO).toISOString(),
    interruttoriChromium: ['--disable-gpu', '--disable-gpu-rasterization', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb', '--disable-partial-raster'],
    log
  })
  await s.avvia()
  await s.viewport(1280, 800)
  await s.attendi(`!!document.querySelector('[data-testid="guide-view"]')`, { entro: 25_000, motivo: 'la guida iniziale compaia' })
  const { ctx } = await preparaDeterministica(s, { providerPort: porta })
  log('setup deterministico fatto')

  /** le misure: chiave `${modello}|${misura}|${tema}|${larghezza}` → { pagina: valore } */
  const raccolte = new Map()
  const metti = (pagina, chiave, valore) => {
    if (valore === null || valore === undefined) return
    const m = raccolte.get(chiave) ?? new Map()
    m.set(pagina, JSON.stringify(valore))
    raccolte.set(chiave, m)
  }

  for (const { id, modello: modelloPagina } of MISURATE) {
    const page = PAGES.find((p) => p.id === id)
    if (!page) throw new Error(`pagina sconosciuta: ${id}`)
    for (const [w, h] of [[1280, 800], [900, 640]]) {
      for (const tema of ['chiaro', 'scuro']) {
        await s.viewport(w, h)
        await s.tema(tema)
        await closeOverlays(s)
        await openPage(s, page, ctx)
        if (page.overlay) await openOverlay(s, page)
        await s.attendiRete({ quieta: 250, entro: 8_000 }).catch(() => undefined)
        // l'apertura del dialogo ANIMA (scale/fade di Radix): si misura da
        // trasformazione finita, o l'1 px della scala a metà corsa sembra
        // una differenza di lingua grafica
        await s.attendi(`(() => {
          const animati = [...document.querySelectorAll('[role="dialog"], [data-state="open"]')]
            .filter((e) => e.getClientRects().length > 0)
            .filter((e) => { const c = getComputedStyle(e); return c.transform !== 'none' || c.opacity !== '1' })
          return animati.length === 0
        })()`, { entro: 3_000, motivo: 'le animazioni del dialogo finiscano', passo: 100 }).catch(() => undefined)
        await s.eval(`await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`).catch(() => undefined)
        const misure = await s.eval(MISURA_JS)
        // la composizione della barra (che pezzi ha): due pagine con pezzi
        // diversi non possono coincidere nella x della ricerca — il confronto
        // è fra pagine dello stesso modello E della stessa composizione
        const composizione = [
          misure.barra && await s.eval(`return !!document.querySelector('[data-page-shell="toolbar"] [role="tablist"], [role="dialog"] nav + * [role="tablist"]')`) ? 'schede' : '',
          misure.ricerca ? 'ricerca' : '',
          misure.pillole ? 'pillole' : ''
        ].filter(Boolean).join('+') || 'nuda'
        for (const [nome, valore] of Object.entries(misure)) {
          metti(`${id}`, `${modelloPagina}|${composizione}|${nome}|${tema}|${w}`, valore)
        }
      }
    }
    log(`misurata ${id}`)
  }

  // il confronto: dentro una chiave (modello · metrica · tema · larghezza) tutte le pagine uguali
  const differenze = []
  for (const [chiave, perPagina] of raccolte) {
    const [modelloChiave, , metrica] = chiave.split('|')
    const valori = [...perPagina.entries()]
    const distinct = new Set(valori.map(([, v]) => v))
    if (distinct.size > 1) {
      differenze.push(`${modelloChiave} · ${metrica} · ${chiave.split('|').slice(3).join(' ')}: ${valori.map(([p, v]) => `${p}=${v}`).join(', ')}`)
    }
  }
  await s.fine({ porta }).catch(() => undefined)
  await modello.chiudi?.()
  console.log('')
  if (differenze.length > 0) {
    console.log(`DIFFERENZE: ${differenze.length}`)
    for (const d of differenze) console.log('  ✗ ' + d)
    process.exitCode = 1
    return
  }
  console.log('DIFFERENZE: 0 — le pagine dello stesso modello coincidono')
}

run().catch((e) => {
  console.error('[fase-linguaggio] FATAL:', e?.stack ?? e)
  process.exitCode = 1
})
