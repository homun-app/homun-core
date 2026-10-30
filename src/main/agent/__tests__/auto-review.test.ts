// Test dell'auto-review (fase 8, §3bis L5): la decisione pura (gate +
// esclusioni + esito del revisore + contatori) e la chiamata al revisore con
// modello finto (JSON non valido, errore, timeout). Il revisore NON riceve il
// transcript: il prompt contiene solo le regole e l'azione in un blocco DATO.
import { describe, expect, it } from 'vitest'
import {
  autoReviewDecision, runReviewer, reviewerPrompt, describeActionForReviewer,
  liftContaminatedAllow, CONTAMINATED_ASK_TOOLS,
  AUTO_REVIEW_MAX_PER_TURN, type AutoReviewAction, type ReviewerModel
} from '../auto-review'
import { DEFAULT_AUTO_REVIEW, type AutoReviewSettings } from '../../../shared/types'

const RULE = 'comandi ls e cat dentro la home del bot'
const BLOCK = 'scrivere fuori dalla home del bot'

const cfg: AutoReviewSettings = {
  enabled: true, allowRules: [RULE], blockRules: [BLOCK], providerId: 'p', model: 'm'
}

const cmd: AutoReviewAction = { tool: 'run-command', args: { command: 'ls' }, neverAuto: false, untrustedTurn: false }
const allowOutcome = { ok: true as const, decision: 'allow' as const, ruleMatched: RULE }

describe('liftContaminatedAllow (F8, pura): allow → ask nel turno contaminato', () => {
  it('un verdetto allow dei tool con effetti torna a chiedere, col motivo del turno contaminato', () => {
    for (const tool of [...CONTAMINATED_ASK_TOOLS]) {
      const v = liftContaminatedAllow({ kind: 'allow', via: 'rule' }, tool, true)
      expect(v.kind, tool).toBe('ask')
      if (v.kind === 'ask') expect(v.reason, tool).toContain('il turno ha letto contenuti web')
    }
  })

  it('deny e ask passano INVARIATI (le regole blocked continuano a negare)', () => {
    const deny = { kind: 'deny' as const, reason: 'fermati sempre' }
    expect(liftContaminatedAllow(deny, 'run-command', true)).toBe(deny)
    const ask = { kind: 'ask' as const, reason: 'chiedi' }
    expect(liftContaminatedAllow(ask, 'run-command', true)).toBe(ask)
  })

  it('fuori dal turno contaminato, e per gli altri tool, il verdetto non cambia', () => {
    const allow = { kind: 'allow' as const, via: 'rule' as const }
    expect(liftContaminatedAllow(allow, 'run-command', false)).toBe(allow)
    expect(liftContaminatedAllow(allow, 'write-file', true)).toBe(allow)
  })
})

describe('autoReviewDecision: la decisione finale (pura)', () => {
  it('auto-review spenta → mai auto-allow (default disabled)', () => {
    expect(autoReviewDecision(DEFAULT_AUTO_REVIEW, cmd, allowOutcome, 0)).toMatchObject({ autoAllow: false })
  })

  it('revisore allow con regola citata parola per parola → auto-allow', () => {
    const d = autoReviewDecision(cfg, cmd, allowOutcome, 0)
    expect(d).toMatchObject({ autoAllow: true, ruleMatched: RULE })
  })

  it('non scavalca MAI le esclusioni, nemmeno con una regola allow che corrisponderebbe', () => {
    // turno aperto da un altro bot o da un evento esterno (prompt injection)
    expect(autoReviewDecision(cfg, { ...cmd, untrustedTurn: true }, allowOutcome, 0).autoAllow).toBe(false)
    // comandi never-auto (shell, interpreti, wrapper)
    expect(autoReviewDecision(cfg, { ...cmd, neverAuto: true }, allowOutcome, 0).autoAllow).toBe(false)
    // azioni che cambiano il comportamento futuro del bot
    for (const tool of ['update_skill', 'update_memory', 'update_state']) {
      expect(autoReviewDecision(cfg, { ...cmd, tool }, allowOutcome, 0).autoAllow).toBe(false)
    }
  })

  it('fallback ad ask: JSON non valido, errore, timeout, decisione ask del revisore', () => {
    expect(autoReviewDecision(cfg, cmd, { ok: false, error: 'JSON non valido' }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: false, error: 'timeout (5000 ms)' }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'ask', reason: 'regola fermati' }, 0).autoAllow).toBe(false)
  })

  it('una regola block che corrisponde vince: allow che cita la blockRule (o nessuna regola) non passa', () => {
    // il revisore che citasse la regola di fermatela come "matched" non passa:
    // ruleMatched deve essere una delle allowRules, alla lettera
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', ruleMatched: BLOCK }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow' }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', ruleMatched: 'regola inventata' }, 0).autoAllow).toBe(false)
  })

  it('tetto di 20 approvazioni automatiche per turno, poi si torna a chiedere', () => {
    const n = AUTO_REVIEW_MAX_PER_TURN
    expect(autoReviewDecision(cfg, cmd, allowOutcome, n - 1).autoAllow).toBe(true)
    expect(autoReviewDecision(cfg, cmd, allowOutcome, n).autoAllow).toBe(false)
  })
})

describe('reviewerPrompt: il revisore vede SOLO regole e azione, come DATO', () => {
  it('contiene le due liste e l\'azione dentro <azione>, mai il transcript', () => {
    const p = reviewerPrompt(cfg, cmd, 'it')
    expect(p).toContain(RULE)
    expect(p).toContain(BLOCK)
    expect(p).toContain('<azione>')
    expect(p).toContain('tool: run-command')
    expect(p).toContain('"command": "ls"')
    // la regola che vince: una regola "fermati" batte le "continua"
    expect(p).toContain('ALWAYS ask')
    // gli argomenti sono dati, non istruzioni
    expect(p).toContain('DATA')
    // contesto dell'ambiente (di sistema): senza workingDirectory si gira nella
    // home del bot — serve a giudicare le regole "dentro la home"
    expect(p).toContain('the working directory is the bot\'s HOME')
    // fase 17b (A3): la riga di lingua per il reason (l'utente lo legge nella card)
    expect(p).toContain('Write the reason in Italian')
    expect(reviewerPrompt(cfg, cmd, 'en')).toContain('Write the reason in English')
  })

  it('per una bozza il revisore vede destinatario/oggetto/corpo', () => {
    const p = reviewerPrompt(cfg, {
      tool: 'draft_external', neverAuto: false, untrustedTurn: false,
      draft: { channel: 'email', to: 'x@example.com', subject: 'ciao', body: 'corpo del messaggio' }
    }, 'it')
    expect(p).toContain('recipient: x@example.com')
    expect(p).toContain('subject: ciao')
    expect(p).toContain('corpo del messaggio')
  })

  it('describeActionForReviewer tronca gli argomenti giganti', () => {
    const long = describeActionForReviewer({ ...cmd, args: { command: 'x'.repeat(10_000) } })
    expect(long.length).toBeLessThan(5_000)
    expect(long).toContain('truncated')
  })
})

describe('runReviewer: normalizzazione e fallback (modello finto)', () => {
  const model = (resp: unknown): ReviewerModel => ({
    call: async () => resp as { toolCalls: Array<{ arguments: string }> | undefined }
  })

  it('tool call valida → esito ok', async () => {
    const out = await runReviewer(cfg, cmd, model({
      toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', ruleMatched: RULE, reason: 'regola rispettata' }) }]
    }))
    expect(out).toEqual({ ok: true, decision: 'allow', ruleMatched: RULE, reason: 'regola rispettata' })
  })

  it('JSON non valido → ok:false', async () => {
    const out = await runReviewer(cfg, cmd, model({ toolCalls: [{ arguments: '{non json' }] }))
    expect(out).toEqual({ ok: false, error: 'invalid JSON' })
  })

  it('nessuna tool call → ok:false', async () => {
    expect(await runReviewer(cfg, cmd, model({}))).toEqual({ ok: false, error: 'no structured decision' })
    expect(await runReviewer(cfg, cmd, model({ toolCalls: [] }))).toEqual({ ok: false, error: 'no structured decision' })
  })

  it('decisione fuori dai valori → ok:false', async () => {
    const out = await runReviewer(cfg, cmd, model({ toolCalls: [{ arguments: JSON.stringify({ decision: 'denied' }) }] }))
    expect(out).toEqual({ ok: false, error: 'invalid decision' })
  })

  it('errore del modello → ok:false con il messaggio', async () => {
    const out = await runReviewer(cfg, cmd, {
      call: async () => { throw new Error('connessione persa') }
    })
    expect(out).toEqual({ ok: false, error: 'connessione persa' })
  })

  it('timeout di 5 s (qui 10 ms con modello appeso) → ok:false', async () => {
    const out = await runReviewer(cfg, cmd, {
      call: () => new Promise(() => undefined) // non risponde mai
    }, 10)
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toContain('timeout')
  }, 5_000)
})
