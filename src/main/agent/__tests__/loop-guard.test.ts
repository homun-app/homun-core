// Test delle protezioni di runtime pure (fase 8, §3bis L11): loop detection
// e stato live (nome del tool + target, senza testo generato dal modello).
import { describe, expect, it } from 'vitest'
import { activityOf, abbreviateCommand } from '../loop-guard'

// SV7 (fase schermo-vivo): isToolLoop non esiste più — il controllo sta
// DOPO il risultato e vive in trackToolStreak (tabella dei casi in
// loop-streak.test.ts). Qui restano i test dell'attività live.

describe('activityOf: nome del tool e target, mai testo del modello', () => {
  it('run-command → comando abbreviato su una riga', () => {
    const a = activityOf('run-command', { command: 'git log --oneline | head -20' })
    expect(a).toEqual({ tool: 'run-command', target: 'git log --oneline | head -20' })
    const long = activityOf('run-command', { command: 'x'.repeat(200) })
    expect(long.target.length).toBeLessThanOrEqual(49)
    expect(long.target.endsWith('…')).toBe(true)
    // solo la prima riga di un comando multilinea
    expect(activityOf('run-command', { command: 'echo a\necho b' }).target).toBe('echo a')
  })

  it('file → path; mcp → nome del connettore; use-app → azione', () => {
    expect(activityOf('read-file', { path: '/home/box/appunti.md' })).toEqual({ tool: 'read-file', target: '/home/box/appunti.md' })
    expect(activityOf('mcp__gmail__send_message', {})).toEqual({ tool: 'mcp__gmail__send_message', target: 'gmail' })
    expect(activityOf('use-app', { action: 'click' })).toEqual({ tool: 'use-app', target: 'click' })
    expect(activityOf('recall_memory', { query: 'x' })).toEqual({ tool: 'recall_memory', target: '' })
  })

  it('fase 16b correzioni (P2): web_fetch → l\'URL letto (la mascotte dice «legge <host>…»)', () => {
    expect(activityOf('web_fetch', { url: 'https://fibrapro.it/login' })).toEqual({ tool: 'web_fetch', target: 'https://fibrapro.it/login' })
    // senza url: target vuoto, la frase resta sulla pagina generica
    expect(activityOf('web_fetch', {})).toEqual({ tool: 'web_fetch', target: '' })
  })

  it('abbreviateCommand tronca oltre il massimo', () => {
    expect(abbreviateCommand('ls')).toBe('ls')
    expect(abbreviateCommand('a'.repeat(60), 10)).toBe('aaaaaaaaaa…')
  })
})

// Correzione C5 (fase 10): il motivo di uno STOPPED da errore del modello —
// il 429 (o il testo "usage limit"/"rate limit" con cui Ollama cloud segnala
// la sessione esaurita) va distinto dagli altri errori.
import { stopReasonOfError } from '../loop-guard'

describe('stopReasonOfError: rate limit del provider vs errore del modello', () => {
  it('status 429 → rate-limit (qualunque il testo)', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 })
    expect(stopReasonOfError(err)).toBe('rate-limit')
  })

  it('il testo del provider ("usage limit", "rate limit", 429) → rate-limit', () => {
    expect(stopReasonOfError(new Error('session usage limit reached'))).toBe('rate-limit')
    expect(stopReasonOfError(new Error('429 Too Many Requests'))).toBe('rate-limit')
    expect(stopReasonOfError(new Error('Rate limit exceeded, retry later'))).toBe('rate-limit')
  })

  it('gli altri errori del modello restano model-error', () => {
    expect(stopReasonOfError(new Error('connection reset'))).toBe('model-error')
    expect(stopReasonOfError(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe('model-error')
    expect(stopReasonOfError('boom')).toBe('model-error')
    expect(stopReasonOfError(null)).toBe('model-error')
  })
})

// ---- fase 19a (V6): la ripetizione di computer_act ha per chiave l'HASH delle azioni ----
import { repeatKeyOf } from '../loop-guard'

describe('fase 19a (V6): computer_act con le stesse azioni ripetute e lo schermo invariato', () => {
  const act = (actions: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ actions, ...extra })
  const CLICK = [{ kind: 'click', x: 640, y: 480 }]

  it('la chiave è l\'HASH delle azioni: observe e formattazione diversa NON contano', () => {
    expect(repeatKeyOf('computer_act', act(CLICK))).toBe(repeatKeyOf('computer_act', act(CLICK)))
    // observe true/false e spazi diversi: stesse AZIONI → stessa chiave
    expect(repeatKeyOf('computer_act', act(CLICK, { observe: true }))).toBe(repeatKeyOf('computer_act', act(CLICK, { observe: false })))
    expect(repeatKeyOf('computer_act', act(CLICK))).toBe(repeatKeyOf('computer_act', JSON.stringify({ actions: CLICK }, null, 2)))
    // azioni DIVERSE → chiave diversa
    expect(repeatKeyOf('computer_act', act(CLICK))).not.toBe(repeatKeyOf('computer_act', act([{ kind: 'click', x: 1, y: 2 }])))
    // gli altri tool restano sulla coppia nome+argomenti
    expect(repeatKeyOf('browser_open', '{"url":"a"}')).toBe('browser_open\u0000{"url":"a"}')
  })

  it('SV7: le azioni di computer_act con la stessa CHIAVE (hash) sono la stessa chiamata per la serie', async () => {
    const { repeatKeyOf, trackToolStreak, initialToolStreakState } = await import('../loop-guard')
    const a1 = act(CLICK, { observe: true })
    const a2 = act(CLICK, { observe: false }) // stessa chiave: il modello crede di variare
    expect(repeatKeyOf('computer_act', a1)).toBe(repeatKeyOf('computer_act', a2))
    // tre identiche FALLITE di fila fermano (identical-failing)
    let st = initialToolStreakState()
    let stop = null as string | null
    for (let i = 0; i < 3; i++) {
      const out = trackToolStreak(st, { name: 'computer_act', args: a1 }, { fingerprint: 'f' + i, failed: true })
      st = out.state
      stop = out.stop
    }
    expect(stop).toBe('identical-failing')
  })
})
