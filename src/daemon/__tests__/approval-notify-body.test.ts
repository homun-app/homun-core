// A3 (fase approvazioni-chiare): la notifica di sistema delle richieste —
// a finestra NON a fuoco, con il BOT e la FRASE RIPULITA (come X2: niente
// testo libero di siti o server, solo le frasi dell'elenco chiuso per
// categoria). Il clic apre il centro su quella richiesta; NESSUNA scelta
// direttamente dalla notifica. Le notifiche rispettano l'interruttore per
// bot. Qui: il corpo PURO + le guardie sul wiring del runtime.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const { approvalNotifyBodyOf } = await import('../approval-notifications')

/** un meta di card con TANTO testo libero: URL, server, destinatario */
const META = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tool: 'browser_type',
  input: { ref: 'e4', text: 'x', submit: true },
  browser: { url: 'https://spa.example/prenota?segreto=1' },
  siteGrant: { domain: 'spa.example' },
  mcpServerRead: { slug: 'ufficio', name: 'Ufficio' },
  ...over
})

describe('A3: il corpo RIPULITO della notifica (come X2)', () => {
  it('la frase è dell\'elenco chiuso, per categoria — mai il testo libero della card', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['dati-tuoi', META({ tool: 'fill_credential' }), /dati tuoi|i tuoi dati|your (personal )?data/i],
      ['pagamento', META({ tool: 'browser_click', browserAsk: { kind: 'commit', name: 'Paga ora 250 €' } }), /pagamento|payment/i],
      ['invio', META({ tool: 'draft_external', message: { type: 'draft', to: 'amministrazione@rossi.example' } }), /invio|sending|outgoing/i],
      ['sito-interattivo', META(), /sito|site/i],
      ['mac', META({ tool: 'use-app' }), /mac/i],
      ['team', META({ tool: 'send_to_agent' }), /team/i]
    ]
    for (const [name, meta, re] of cases) {
      const it = approvalNotifyBodyOf('it', { kind: 'approval', content: 'browser_type: vuole https://spa.example/prenota', meta })
      const en = approvalNotifyBodyOf('en', { kind: 'approval', content: 'browser_type: vuole https://spa.example/prenota', meta })
      expect(it, name).toMatch(re)
      expect(en, name).toMatch(re)
    }
  })

  it('MAI l\'URL, il server o il destinatario dentro la notifica', () => {
    for (const lang of ['it', 'en'] as const) {
      const body = approvalNotifyBodyOf(lang, { kind: 'approval', content: 'mcp__ufficio__send_email verso amministrazione@rossi.example', meta: META({ tool: 'mcp__ufficio__send_email' }) })
      expect(body).not.toContain('spa.example')
      expect(body).not.toContain('rossi.example')
      expect(body).not.toContain('ufficio')
      expect(body).not.toContain('https://')
    }
  })

  it('senza categoria nota resta la frase generica, comunque senza testo libero', () => {
    const body = approvalNotifyBodyOf('it', { kind: 'approval', content: 'run-command: rm -rf /Mac/segreti', meta: META({ tool: 'run-command', input: { command: 'rm -rf /Mac/segreti' } }) })
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('rm -rf')
  })
})

describe('A3: il wiring della notifica (guardie sul sorgente del runtime)', () => {
  it('il runtime registra il raggruppatore e gli passa le CARD (non il percorso dei 5 s)', () => {
    const src = read('../runtime.ts')
    expect(src).toMatch(/createApprovalNotifier\(/)
    expect(src).toMatch(/onApprovalBorn\(/)
    // il fuoco della finestra arriva dalla presenza (focus/blur → presence:window-focus)
    expect(src).toMatch(/presence\.windowFocused\(\)/)
  })

  it('il clic apre il CENTRO su quella richiesta (openApprovalsFor), mai una scelta dalla notifica', () => {
    const bridge = read('../host-bridge.ts')
    expect(bridge).toMatch(/openApprovalsFor/)
    const ipc = read('../../main/ipc.ts')
    expect(ipc).toMatch(/open-approvals/)
    // NESSUNA azione di decisione nella notifica: host.notify non decide
    expect(ipc).not.toMatch(/host\.notify[^;]*'allow'|approve/)
  })
})
