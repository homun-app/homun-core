// B3 (fase b20-bug): la RIGA del catalogo (AppRow) in ogni esito del clic su
// «Connetti» — mai una riga muta né senza via d'uscita. In avvio lo dice;
// quando il collegamento parte dice cosa fare nel browser (quello di sistema:
// non c'è nessuna finestra interna) e offre «Annulla»; quando fallisce
// mostra il motivo per esteso con «Riprova»; con il tempo massimo scaduto
// pure. Il componente VERO reso senza DOM (react-dom/server), come
// plugin-page-flat; il cablaggio è una guardia sul sorgente, come boot-splash.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll, hasAncestor, type HtmlNode } from './render-helper'

// C0 (fase linguaggio): AppsWindow è smontato — i pezzi si leggono uniti
const APPS_SRC = ['connect-flows', 'app-row']
  .map((n) => readFileSync(fileURLToPath(new URL(`../components/plugin/${n}.tsx`, import.meta.url)), 'utf8'))
  .concat(readFileSync(fileURLToPath(new URL('../components/ui/app-logo.tsx', import.meta.url)), 'utf8'))
  .join('\n\n')
const PANEL_SRC = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
const CARD_SRC = readFileSync(fileURLToPath(new URL('../components/ConnectorCard.tsx', import.meta.url)), 'utf8')

const { AppRow } = await import('../components/plugin/app-row')

type Row = Parameters<typeof AppRow>[0]['row']
type Flow = Parameters<typeof AppRow>[0]['flow']
type Failure = { reason: 'not-connectable' | 'timeout' | 'connect-failed'; text: string; detail?: string }

/** Spotify: via Composio, non collegata (la riga del sintomo). */
const spotify = {
  app: {
    id: 'spotify', name: 'Spotify', description: null, tagline: null, category: 'other', logo: null,
    via: 'composio', composioSlug: 'spotify', featured: false, rank: 0
  },
  tagline: 'Musica e podcast', connected: null
} as unknown as Row

const byId = (root: HtmlNode, id: string) => findAll(root, (n) => n.attrs['data-testid'] === id)[0] ?? null
const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)

const render = (flow: Flow, failure?: Failure) => {
  const onConnect = vi.fn()
  const root = parseHtml(renderHtml(createElement(AppRow, {
    row: spotify, flow, ...(failure !== undefined ? { failure } : {}), onConnect,
    onCancel: vi.fn(), onConflictResolve: vi.fn(), onOpen: vi.fn()
  } as never)))
  return { root, onConnect, row: byId(root, 'app-row-spotify')! }
}

describe('B3: la riga in ogni esito del clic — mai muta, mai senza via d\'uscita', () => {
  it('in avvio (starting) la riga dice «Avvio del collegamento…» e non offre più «Connetti» (un secondo clic non raddoppia la richiesta)', () => {
    const { root, row } = render('starting')
    expect(textOf(row)).toContain('Avvio del collegamento…')
    expect(byId(root, 'app-connect-spotify')).toBeNull()
  })

  it('ogni stato d\'attesa ha il suo testo in riga e dice cosa succede nel browser di sistema', () => {
    const expected: Array<[Flow, string]> = [
      ['starting', 'Avvio del collegamento…'],
      ['direct', 'autorizza nel browser…'],
      ['login', 'Accedi a Composio nel browser…'],
      ['app', 'Completa il login di Spotify nel browser…']
    ]
    for (const [flow, text] of expected) {
      expect(textOf(render(flow).row), `stato ${String(flow)}`).toContain(text)
    }
    // il collegamento partito offre l'uscita: «Annulla» (il testid di prima)
    const started = render('app')
    expect(textOf(byId(started.root, 'app-cancel-spotify')!)).toBe('Annulla')
  })

  it('ERRORE: la riga si sblocca subito — niente più attesa, il motivo per esteso, «Non riuscito» in rosso e «Riprova»', () => {
    const { root } = render('failed', { reason: 'connect-failed', text: 'Composio non ha aperto il login di Spotify.' })
    expect(byId(root, 'app-cancel-spotify')).toBeNull()
    expect(textOf(byId(root, 'app-error-spotify')!)).toBe('Composio non ha aperto il login di Spotify.')
    const label = byId(root, 'app-status-spotify')!
    expect(textOf(label)).toBe('Non riuscito')
    expect(has(label, 'text-destructive')).toBe(true)
    expect(textOf(byId(root, 'app-retry-spotify')!)).toBe('Riprova')
  })

  it('app non collegabile (manca la configurazione di accesso): PERMANENTE — «Come si risolve» al posto di «Riprova», e porta alla scheda', () => {
    const { root } = render('failed', { reason: 'not-connectable', text: 'Composio non gestisce il login di Spotify: manca la sua configurazione di accesso.' })
    expect(textOf(byId(root, 'app-status-spotify')!)).toBe('Non si può collegare')
    expect(textOf(byId(root, 'app-error-spotify')!)).toContain('manca la sua configurazione di accesso')
    // R6 (b20-ritocchi): la causa è PERMANENTE — «Riprova» non cambierebbe
    // niente. Al suo posto «Come si risolve», che apre la scheda dell'app
    // (dove stanno la configurazione e le alternative, come l'MCP diretto)
    expect(byId(root, 'app-retry-spotify'), 'niente «Riprova» per una causa permanente').toBeNull()
    expect(textOf(byId(root, 'app-howto-spotify')!)).toBe('Come si risolve')
    expect(APPS_SRC).toContain('data-testid={`app-howto-${row.app.id}`} onClick={(e) => { stop(e); onOpen(row) }')
  })

  it('tempo massimo scaduto: la riga si sblocca con «Nessuna risposta», l\'avviso e «Riprova»', () => {
    const { root } = render('failed', { reason: 'timeout', text: 'Nessuna risposta entro 25 secondi: riprova.' })
    expect(textOf(byId(root, 'app-status-spotify')!)).toBe('Nessuna risposta')
    expect(textOf(byId(root, 'app-error-spotify')!)).toBe('Nessuna risposta entro 25 secondi: riprova.')
    expect(textOf(byId(root, 'app-retry-spotify')!)).toBe('Riprova')
  })

  it('il dettaglio tecnico resta secondario: una riga piccola grigia sotto il motivo, col testo intero nel title', () => {
    const { root } = render('failed', { reason: 'connect-failed', text: 'Composio non ha aperto il login di Spotify.', detail: 'MCP error -32000: Connection closed' })
    const detail = byId(root, 'app-error-detail-spotify')!
    expect(textOf(detail)).toBe('MCP error -32000: Connection closed')
    expect(has(detail, 'text-muted-foreground')).toBe(true)
    expect(has(detail, 'text-destructive')).toBe(false)
    expect(detail.attrs.title).toBe('MCP error -32000: Connection closed')
  })

  it('la riga porta il suo stato per la sonda: data-flow sul contenitore della riga, in ogni stato', () => {
    expect(render(null).row.parent!.attrs['data-testid']).toBe('app-state-spotify')
    expect(render(null).row.parent!.attrs['data-flow']).toBe('idle')
    expect(render('starting').row.parent!.attrs['data-flow']).toBe('starting')
    expect(render('direct').row.parent!.attrs['data-flow']).toBe('direct')
    expect(render('login').row.parent!.attrs['data-flow']).toBe('login')
    expect(render('app').row.parent!.attrs['data-flow']).toBe('app')
    expect(render('failed', { reason: 'timeout', text: 'x' }).row.parent!.attrs['data-flow']).toBe('failed')
    expect(render('conflict').row.parent!.attrs['data-flow']).toBe('conflict')
    // la riga resta DENTRO il suo contenitore (la sonda legge lo stato dal contenitore e clicca la riga)
    expect(hasAncestor(render('app').row, (n) => n.attrs['data-testid'] === 'app-state-spotify')).toBe(true)
    // i testid di prima restano al loro posto: la riga, «Connetti», «Annulla», il conflitto
    expect(byId(render(null).root, 'app-connect-spotify')).not.toBeNull()
    expect(APPS_SRC).toContain('data-testid={`app-cancel-${row.app.id}`}')
    expect(APPS_SRC).toContain('data-testid={`app-conflict-${row.app.id}`}')
    expect(APPS_SRC).toContain('testId={`app-row-${row.app.id}`}')
  })
})

describe('B3: il cablaggio — la pagina passa alla riga l\'esito del flusso', () => {
  it('PluginPanel passa flow E failure a ogni AppRow che disegna (consigliati e connettori)', () => {
    const uses = PANEL_SRC.match(/<AppRow[\s\S]*?\/>/g) ?? []
    expect(uses.length).toBe(2)
    for (const use of uses) {
      expect(use).toContain('flow={flows.flowOf(r)}')
      expect(use).toContain('failure={flows.failureOf(r)}')
    }
  })
  it('useConnectFlows è solo il cablaggio del flusso PURO: niente più Richiesta appesa senza tempo massimo, niente catch che ingoia l\'errore', () => {
    expect(APPS_SRC).toContain('createAppConnectFlows({')
    expect(APPS_SRC).toContain('failureOf: (row) => view(row).failure')
    // il vecchio «ogni errore diventa unknown-app e la riga non dice niente»
    expect(APPS_SRC).not.toContain(".catch((): Awaited<ReturnType<typeof api.appsConnect>> => ({ started: false, reason: 'unknown-app' }))")
    // le rilettture del flusso non lasciano promesse orfane
    const hook = APPS_SRC.slice(APPS_SRC.indexOf('export function useConnectFlows('), APPS_SRC.indexOf('export function AppRow('))
    expect(hook).not.toMatch(/void refreshConnectors\(\)\s*$/m)
    expect(hook).not.toMatch(/void refreshComposioGateway\(\)\s*$/m)
    expect(hook).toContain('refreshConnectors().catch(() => undefined)')
    expect(hook).toContain('flows.dispose()')
  })
  it('la card in chat sulla strada di apps:connect mostra il motivo (dalla risposta e dall\'esito pubblicato): non resta «In attesa» per sempre', () => {
    expect(CARD_SRC).toContain('appConnectPublishedFailure(route.appId, routeClickedAt.current, composioGateway?.appConnect)')
    expect(CARD_SRC).toContain("setRouteError(r.error ?? '')")
    // K2 (fase conversione-chat): il motivo è Text del catalogo — l'ancora sta nella sua prop testId, e nel DOM resta data-testid="connector-card-error"
    expect(CARD_SRC).toContain('testId="connector-card-error"')
  })
})
