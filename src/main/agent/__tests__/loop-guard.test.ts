// Test delle protezioni di runtime pure (fase 8, §3bis L11): loop detection
// e stato live (nome del tool + target, senza testo generato dal modello).
import { describe, expect, it } from 'vitest'
import { activityOf, abbreviateCommand, isToolLoop, TOOL_LOOP_REPEATS } from '../loop-guard'

describe('isToolLoop: la stessa tool call ripetuta 3 volte di fila', () => {
  const same = { name: 'run-command', args: '{"command":"ls"}' }

  it('la terza identica di fila è un loop (nome + argomenti identici)', () => {
    expect(isToolLoop([same, same], same)).toBe(true)
  })

  it('due sole ripetizioni non bastano; la terza chiamata diversa resetta', () => {
    expect(isToolLoop([same], same)).toBe(false)
    expect(isToolLoop([same, { name: 'run-command', args: '{"command":"ls -la"}' }], same)).toBe(false)
    expect(isToolLoop([{ ...same, name: 'read-file' }, { ...same, name: 'read-file' }], { ...same, name: 'read-file' })).toBe(true)
  })

  it('argomenti diversi non sono un loop, nemmeno a nome uguale', () => {
    const a = { name: 'send_to_user', args: '{"text":"ciao"}' }
    const b = { name: 'send_to_user', args: '{"text":"ancora ciao"}' }
    expect(isToolLoop([a, a], b)).toBe(false)
    expect(isToolLoop([a, b], a)).toBe(false)
  })

  it('le chiamate di ritorno dopo una diversa non contano', () => {
    const other = { name: 'read-file', args: '{"path":"/x"}' }
    expect(isToolLoop([same, other, same], same)).toBe(false)
    expect(isToolLoop([other, same, same], same)).toBe(true)
  })

  it('la soglia è 3 (TOOL_LOOP_REPEATS)', () => {
    expect(TOOL_LOOP_REPEATS).toBe(3)
  })
})

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

  it('la TERZA chiamata identica di fila ferma il turno (la regola delle altre ripetizioni)', () => {
    const a1 = act(CLICK, { observe: true })
    const a2 = act(CLICK, { observe: false }) // stessa chiave: il modello crede di variare
    const seq = [{ name: 'computer_act', args: a1 }, { name: 'computer_act', args: a2 }]
    expect(isToolLoop(seq, { name: 'computer_act', args: act(CLICK) })).toBe(true)
    // due e poi una DIVERSA: non è un loop
    expect(isToolLoop([seq[0]!], { name: 'computer_act', args: act([{ kind: 'key', key: 'Tab' }]) })).toBe(false)
  })
})
