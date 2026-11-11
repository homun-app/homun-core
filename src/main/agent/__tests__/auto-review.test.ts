// Test dell'auto-review (fase 8, §3bis L5): la decisione pura (gate +
// esclusioni + esito del revisore + contatori) e la chiamata al revisore con
// modello finto (JSON non valido, errore, timeout). Il revisore NON riceve il
// transcript: il prompt contiene solo le regole e l'azione in un blocco DATO.
import { describe, expect, it } from 'vitest'
import {
  autoReviewDecision, neverAskDecision, approvalsMode, runReviewer, reviewerPrompt, describeActionForReviewer,
  liftContaminatedAllow, CONTAMINATED_ASK_TOOLS, ownerWordsOf, botBriefOf,
  AUTO_REVIEW_MAX_PER_TURN, REVIEWER_TOOL, type AutoReviewAction, type ReviewerModel
} from '../auto-review'
import { DEFAULT_AUTO_REVIEW, type AutoReviewSettings } from '../../../shared/types'

const RULE = 'comandi ls e cat dentro la home del bot'
const BLOCK = 'scrivere fuori dalla home del bot'

const cfg: AutoReviewSettings = {
  enabled: true, allowRules: [RULE], blockRules: [BLOCK], providerId: 'p', model: 'm'
}

const cmd: AutoReviewAction = { tool: 'run-command', args: { command: 'ls' }, neverAuto: false, untrustedTurn: false }
const allowOutcome = { ok: true as const, decision: 'allow' as const, basis: 'rule' as const, ruleMatched: RULE }

describe('liftContaminatedAllow (F8, pura): allow → ask nel turno contaminato', () => {
  it('un verdetto allow dei tool con effetti torna a chiedere, col motivo del turno contaminato', () => {
    for (const tool of [...CONTAMINATED_ASK_TOOLS]) {
      const v = liftContaminatedAllow({ kind: 'allow', via: 'rule' }, tool, true)
      expect(v.kind, tool).toBe('ask')
      // fase 17c (C2): reason inglese per il modello; la card usa l'UiText
      if (v.kind === 'ask') {
        expect(v.reason, tool).toContain('the turn has read untrusted web content')
        expect(v.ui?.id).toBe('approval.contaminated')
      }
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
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'ask', basis: 'request', reason: 'regola fermati' }, 0).autoAllow).toBe(false)
  })

  it('una regola block che corrisponde vince: allow che cita la blockRule (o nessuna regola) non passa', () => {
    // il revisore che citasse la regola di fermatela come "matched" non passa:
    // ruleMatched deve essere una delle allowRules, alla lettera
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule', ruleMatched: BLOCK }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule' }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule', ruleMatched: 'regola inventata' }, 0).autoAllow).toBe(false)
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
      toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', basis: 'rule', ruleMatched: RULE, reason: 'regola rispettata' }) }]
    }))
    expect(out).toEqual({ ok: true, decision: 'allow', basis: 'rule', ruleMatched: RULE, reason: 'regola rispettata' })
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

// ---- RW (fase revisore sulla richiesta): il giudice di Rakazo ----

const RULE_WORDS = 'mi dici cosa ho su trello'
const BOT_BRIEF = 'Trello — tiene d\'occhio le mie board'

describe('RW1: ownerWordsOf — SOLO le parole del proprietario, per tipo di turno', () => {
  // la conversazione del test: un messaggio utente, poi una card di un ALTRO
  // bot, poi il risultato di uno strumento (che NON è parole del proprietario)
  const entries = [
    { role: 'assistant', kind: 'message', content: 'premessaggio del bot' },
    { role: 'user', kind: 'message', content: RULE_WORDS },
    { role: 'assistant', kind: 'message', content: 'messaggio di un altro bot' },
    { role: 'system', kind: 'tool-result', content: 'RISULTATO-ESTERNO-da-non-mai-vedere' }
  ]

  it('turno privato aperto da un suo messaggio → quel messaggio (userText)', () => {
    expect(ownerWordsOf({ source: 'user', userText: RULE_WORDS, entries })).toBe(RULE_WORDS)
  })

  it('routine a orario senza evento esterno → le istruzioni della routine (userText)', () => {
    expect(ownerWordsOf({ source: 'routine', userText: '[recurring routine: Trello] controlla le board', entries }))
      .toBe('[recurring routine: Trello] controlla le board')
  })

  it('routine con evento esterno → vuoto (il testo non è del proprietario)', () => {
    expect(ownerWordsOf({ source: 'routine', externalEvent: true, userText: '<evento>…</evento>', entries })).toBe('')
  })

  it('risvegli di sistema → l\'ultimo messaggio utente della conversazione, anche con un bot dopo', () => {
    for (const initiator of ['SHELL_DONE', 'SUBAGENTS_DONE', 'CONNECTOR_CONNECTED', 'LOOK_AROUND', 'ROUTINE']) {
      expect(ownerWordsOf({ source: 'user', initiator, userText: 'testo del risveglio, non suo', entries }), initiator).toBe(RULE_WORDS)
    }
  })

  it('mai risultati di strumenti, mai testo di altri bot: il revisore non li vede', () => {
    const w = ownerWordsOf({ source: 'user', initiator: 'SHELL_DONE', userText: 'x', entries })
    expect(w).not.toContain('RISULTATO-ESTERNO')
    expect(w).not.toContain('altro bot')
  })

  it('turni di gruppo, figli e task → vuoto; niente messaggi utente → vuoto', () => {
    expect(ownerWordsOf({ source: 'group', userText: 'apertura del gruppo', entries })).toBe('')
    expect(ownerWordsOf({ source: 'user', userText: 'brief', entries, subagent: { id: 's', parentId: 'p' } })).toBe('')
    expect(ownerWordsOf({ source: 'user', userText: 'brief', entries, taskId: 7 })).toBe('')
    expect(ownerWordsOf({ source: 'user', initiator: 'SHELL_DONE', userText: 'x', entries: [{ role: 'system', kind: 'tool-result', content: 'solo tool' }] })).toBe('')
  })

  it('taglio a 1000 caratteri; botBrief (nome+descrizione) a 240', () => {
    const long = ownerWordsOf({ source: 'user', userText: 'a'.repeat(2_000), entries })
    expect(long.length).toBe(1_000)
    expect(long.endsWith('…')).toBe(true)
    expect(botBriefOf('Trello', 'd'.repeat(500)).length).toBe(240)
    expect(botBriefOf('Trello', 'tiene d\'occhio le mie board')).toBe(BOT_BRIEF)
  })
})

describe('RW1: reviewerPrompt — la richiesta del proprietario e il bot come DATI', () => {
  const act: AutoReviewAction = { tool: 'run-command', args: { command: 'ls' }, neverAuto: false, untrustedTurn: false, ownerWords: RULE_WORDS, botBrief: BOT_BRIEF }

  it('le parole del proprietario stanno in <richiesta_del_proprietario>, il bot in <bot>, l\'azione in <azione>', () => {
    const p = reviewerPrompt(cfg, act, 'it')
    expect(p).toContain('<richiesta_del_proprietario>')
    expect(p).toContain(RULE_WORDS)
    expect(p).toContain('<bot>')
    expect(p).toContain(BOT_BRIEF)
    expect(p).toContain('<azione>')
    expect(p).toContain('tool: run-command')
  })

  it('i tre blocchi sono DATI, non istruzioni; la riga di lingua e il contesto del box restano', () => {
    const p = reviewerPrompt(cfg, act, 'it')
    expect(p).toContain('DATA')
    expect(p).toContain('Write the reason in Italian')
    expect(p).toContain("the working directory is the bot's HOME")
    // la tool call forzata resta
    expect(p).toContain('report_decision')
  })

  it('«When in doubt, ask» NON c\'è più: il dubbio vero è già «va oltre?»', () => {
    expect(reviewerPrompt(cfg, act, 'it')).not.toContain('When in doubt, ask')
  })

  it('i criteri in ordine: regola di fermo → ask; regola continua → allow citata; altrimenti si giudica sulla richiesta', () => {
    const p = reviewerPrompt(cfg, act, 'it')
    expect(p.indexOf('ALWAYS ask')).toBeLessThan(p.indexOf('plausibly serves'))
    expect(p).toContain('plausibly serves what the owner asked for or the bot\'s job')
    expect(p).toContain('hard to undo')
  })

  it('senza testo del proprietario il blocco c\'è comunque (vuoto marcato), il revisore giudica sul lavoro del bot', () => {
    const p = reviewerPrompt(cfg, { ...act, ownerWords: '' }, 'it')
    expect(p).toContain('<richiesta_del_proprietario>')
    expect(p.toLowerCase()).toContain('none')
  })

  it('il testo di un risultato di strumento nella conversazione NON entra nel prompt', () => {
    const words = ownerWordsOf({ source: 'user', initiator: 'SHELL_DONE', userText: 'x', entries: [
      { role: 'user', kind: 'message', content: RULE_WORDS },
      { role: 'system', kind: 'tool-result', content: 'RISULTATO-ESTERNO-da-non-mai-vedere' }
    ] })
    const p = reviewerPrompt(cfg, { ...act, ownerWords: words }, 'it')
    expect(p).not.toContain('RISULTATO-ESTERNO')
  })
})

describe('RW1: autoReviewDecision con basis — la richiesta può far passare da sola', () => {
  const requestAllow = { ok: true as const, decision: 'allow' as const, basis: 'request' as const, reason: 'lettura delle board richiesta dall\'utente' }

  it('allowRules VUOTE e revisore allow basis request → autoAllow true (oggi false)', () => {
    const empty: AutoReviewSettings = { enabled: true, allowRules: [], blockRules: [], providerId: 'p', model: 'm' }
    const d = autoReviewDecision(empty, cmd, requestAllow, 0)
    expect(d).toMatchObject({ autoAllow: true, basis: 'request' })
  })

  it('basis rule con una regola inventata → ask', () => {
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule', ruleMatched: 'regola inventata' }, 0).autoAllow).toBe(false)
  })

  it('una blockRule citata → ask QUALUNQUE sia la decisione e la basis', () => {
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule', ruleMatched: BLOCK }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'request', ruleMatched: BLOCK }, 0).autoAllow).toBe(false)
  })

  it('basis rule con la regola citata parola per parola → autoAllow con basis rule e ruleMatched', () => {
    const d = autoReviewDecision(cfg, cmd, { ok: true, decision: 'allow', basis: 'rule', ruleMatched: RULE }, 0)
    expect(d).toMatchObject({ autoAllow: true, basis: 'rule', ruleMatched: RULE })
  })

  it('OGNI esclusione hard resta ask anche con basis request', () => {
    // turno non fidato, never-auto, comportamento futuro, scambio file, tetto 20
    expect(autoReviewDecision(cfg, { ...cmd, untrustedTurn: true }, requestAllow, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, { ...cmd, neverAuto: true }, requestAllow, 0).autoAllow).toBe(false)
    for (const tool of ['update_skill', 'update_memory', 'update_state']) {
      expect(autoReviewDecision(cfg, { ...cmd, tool }, requestAllow, 0).autoAllow, tool).toBe(false)
    }
    expect(autoReviewDecision(cfg, { ...cmd, tool: 'copy_to_box' }, requestAllow, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, requestAllow, AUTO_REVIEW_MAX_PER_TURN).autoAllow).toBe(false)
    // revisore indisponibile o che chiede → ask come oggi
    expect(autoReviewDecision(cfg, cmd, { ok: false, error: 'timeout' }, 0).autoAllow).toBe(false)
    expect(autoReviewDecision(cfg, cmd, { ok: true, decision: 'ask', basis: 'request' }, 0).autoAllow).toBe(false)
  })
})

describe('RW1: runReviewer — basis nell\'esito strutturato', () => {
  const model = (resp: unknown): ReviewerModel => ({
    call: async () => resp as { toolCalls: Array<{ arguments: string }> | undefined }
  })

  it('basis request valida → ok con basis', async () => {
    const out = await runReviewer(cfg, cmd, model({
      toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', basis: 'request', reason: 'serve alla richiesta' }) }]
    }))
    expect(out).toEqual({ ok: true, decision: 'allow', basis: 'request', reason: 'serve alla richiesta' })
  })

  it('basis rule con ruleMatched → ok con basis e regola', async () => {
    const out = await runReviewer(cfg, cmd, model({
      toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', basis: 'rule', ruleMatched: RULE }) }]
    }))
    expect(out).toEqual({ ok: true, decision: 'allow', basis: 'rule', ruleMatched: RULE })
  })

  it('basis fuori dai valori → ok:false (fail closed)', async () => {
    const out = await runReviewer(cfg, cmd, model({
      toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', basis: 'vibes' }) }]
    }))
    expect(out).toEqual({ ok: false, error: 'invalid basis' })
  })
})

// ---- RX (fase revisore: correzioni dalla misura) ----

describe('RX1: il revisore risponde sempre in forma valida', () => {
  // modello finto che risponde in SEQUENZA e registra ogni chiamata (prompt e tool)
  const seqModel = (responses: Array<unknown>, delayFirstMs = 0) => {
    const calls: Array<{ content: string; tools: unknown[] }> = []
    let i = 0
    const model: ReviewerModel = {
      call: async (messages, tools) => {
        calls.push({ content: messages[0]!.content, tools: [...tools] })
        if (calls.length === 1 && delayFirstMs) await new Promise((r) => setTimeout(r, delayFirstMs))
        const resp = responses[Math.min(i++, responses.length - 1)]
        if (resp instanceof Promise) return resp as never
        return resp as { toolCalls: Array<{ arguments: string }> | undefined }
      }
    }
    return { model, calls }
  }
  const noDecision = { toolCalls: [{ arguments: JSON.stringify({ basis: 'request', reason: 'Il proprietario ha chiesto esplicitamente di rispondere a Marco con la mail pronta' }) }] }
  const valid = { toolCalls: [{ arguments: JSON.stringify({ decision: 'allow', basis: 'request', reason: 'lettura chiesta dal proprietario' }) }] }

  it('REVIEWER_TOOL: proprietà in ordine decision, basis, ruleMatched, reason; reason «one short sentence, at most 25 words»', () => {
    expect(Object.keys(REVIEWER_TOOL.parameters.properties)).toEqual(['decision', 'basis', 'ruleMatched', 'reason'])
    expect(REVIEWER_TOOL.parameters.required).toEqual(['decision', 'basis'])
    expect(REVIEWER_TOOL.parameters.properties.reason.description).toContain('One short sentence, at most 25 words')
  })

  it('il prompt lo dice in una riga: The reason is one short sentence.', () => {
    expect(reviewerPrompt(cfg, cmd, 'it')).toContain('The reason is one short sentence.')
  })

  it('risposta senza decision → UNA seconda chiamata → esito valido', async () => {
    const { model, calls } = seqModel([noDecision, valid])
    const out = await runReviewer(cfg, cmd, model)
    expect(out).toEqual({ ok: true, decision: 'allow', basis: 'request', reason: 'lettura chiesta dal proprietario' })
    expect(calls.length).toBe(2)
    // la seconda chiamata è lo STESSO prompt con la riga di richiamo in coda, stessa tool
    expect(calls[1]!.content.startsWith(calls[0]!.content)).toBe(true)
    expect(calls[1]!.content).toContain('Your previous answer was missing the required fields: answer again with report_decision including decision and basis.')
    expect(calls[1]!.tools).toEqual(calls[0]!.tools)
  })

  it('nessuna tool call alla prima → seconda chiamata → esito valido', async () => {
    const { model, calls } = seqModel([{ toolCalls: [] }, valid])
    expect(await runReviewer(cfg, cmd, model)).toEqual({ ok: true, decision: 'allow', basis: 'request', reason: 'lettura chiesta dal proprietario' })
    expect(calls.length).toBe(2)
  })

  it('due risposte invalide → ok:false (e si torna a chiedere)', async () => {
    const { model, calls } = seqModel([noDecision])
    expect(await runReviewer(cfg, cmd, model)).toEqual({ ok: false, error: 'invalid decision' })
    expect(calls.length).toBe(2)
  })

  it('"Allow" / " request " si normalizzano; "pass" resta invalido', async () => {
    const out = await runReviewer(cfg, cmd, seqModel([{
      toolCalls: [{ arguments: JSON.stringify({ decision: 'Allow', basis: ' request ', reason: 'richiesta chiara' }) }]
    }]).model)
    expect(out).toEqual({ ok: true, decision: 'allow', basis: 'request', reason: 'richiesta chiara' })
    const { model, calls } = seqModel([{
      toolCalls: [{ arguments: JSON.stringify({ decision: 'pass', basis: 'request' }) }]
    }])
    expect(await runReviewer(cfg, cmd, model)).toEqual({ ok: false, error: 'invalid decision' })
    expect(calls.length).toBe(2)
  })

  it('reason di 400 caratteri tagliato a 160 con «…» (come truncateReviewText di Rakazo)', async () => {
    const out = await runReviewer(cfg, cmd, seqModel([{
      toolCalls: [{ arguments: JSON.stringify({ decision: 'ask', basis: 'request', reason: 'r'.repeat(400) }) }]
    }]).model)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.reason?.length).toBe(160)
      expect(out.reason?.endsWith('…')).toBe(true)
    }
  })

  it('timeout alla PRIMA chiamata → nessuna riprova', async () => {
    const calls: unknown[] = []
    const model: ReviewerModel = {
      call: () => { calls.push(1); return new Promise(() => undefined) }
    }
    const out = await runReviewer(cfg, cmd, model, 20)
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toContain('timeout')
    expect(calls.length).toBe(1)
  }, 5_000)

  it('errore di rete alla PRIMA chiamata → nessuna riprova', async () => {
    const calls: unknown[] = []
    const model: ReviewerModel = {
      call: async () => { calls.push(1); throw new Error('connessione persa') }
    }
    expect(await runReviewer(cfg, cmd, model)).toEqual({ ok: false, error: 'connessione persa' })
    expect(calls.length).toBe(1)
  })

  it('prima risposta invalida ma tempo rimasto SOTTO 1/3 → nessuna riprova', async () => {
    const { model, calls } = seqModel([noDecision], 80) // consuma l'80% di 100 ms
    const out = await runReviewer(cfg, cmd, model, 100)
    expect(out).toEqual({ ok: false, error: 'invalid decision' })
    expect(calls.length).toBe(1)
  }, 5_000)
})

// ---- fase impostazioni (I4.3): il modo «Non chiedere» — la sorella pura ----

describe('neverAskDecision (I4.3): ask → allow tranne le esclusioni fisse', () => {
  const clean: AutoReviewAction = { tool: 'write-file', args: { path: 'a.txt' }, neverAuto: false, untrustedTurn: false }

  it('azione normale → allow sintetico (senza regole, senza revisore, senza tetto)', () => {
    const d = neverAskDecision(clean)
    expect(d.allow).toBe(true)
    if (d.allow) expect(d.reason).toContain('never ask')
  })

  it('il tetto per turno NON esiste: 100 azioni di fila restano allow', () => {
    for (let i = 0; i < 100; i++) {
      expect(neverAskDecision(clean).allow, `azione ${i}`).toBe(true)
    }
  })

  it('turno aperto da un altro bot o evento esterno → card', () => {
    expect(neverAskDecision({ ...clean, untrustedTurn: true }).allow).toBe(false)
  })

  it('turno contaminato + azione con effetti (CONTAMINATED_ASK_TOOLS) → card', () => {
    for (const tool of [...CONTAMINATED_ASK_TOOLS]) {
      const d = neverAskDecision({ ...clean, tool, contaminated: true })
      expect(d.allow, tool).toBe(false)
    }
    // i tool SENZA effetti di un turno contaminato passano (come liftContaminatedAllow)
    expect(neverAskDecision({ ...clean, tool: 'write-file', contaminated: true }).allow).toBe(true)
  })

  it('comando never-auto → card (la chiave non dice cosa eseguirà davvero)', () => {
    expect(neverAskDecision({ ...clean, neverAuto: true }).allow).toBe(false)
  })

  it('azioni che cambiano il comportamento futuro del bot → card', () => {
    for (const tool of ['update_skill', 'update_memory', 'update_state']) {
      expect(neverAskDecision({ ...clean, tool }).allow, tool).toBe(false)
    }
  })

  it('lo scambio di file col Mac → card (protezione fissa, come ALWAYS_ASK_TOOLS)', () => {
    expect(neverAskDecision({ ...clean, tool: 'copy_to_box' }).allow).toBe(false)
    expect(neverAskDecision({ ...clean, tool: 'copy_from_box' }).allow).toBe(false)
  })
})

describe('approvalsMode (I4.1): il modo dai setting, con compatibilità', () => {
  const mkSettings = (map: Record<string, unknown>) => ({
    getSetting: <T,>(key: string, fallback: T): T => (key in map ? map[key] as T : fallback)
  })

  it('approvals.mode è la fonte', () => {
    expect(approvalsMode(mkSettings({ 'approvals.mode': 'never' }))).toBe('never')
    expect(approvalsMode(mkSettings({ 'approvals.mode': 'auto' }))).toBe('auto')
    expect(approvalsMode(mkSettings({ 'approvals.mode': 'ask' }))).toBe('ask')
  })

  it('senza approvals.mode (dati di ieri): autoReview.enabled decide', () => {
    expect(approvalsMode(mkSettings({ autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: true } }))).toBe('auto')
    expect(approvalsMode(mkSettings({ autoReview: { ...DEFAULT_AUTO_REVIEW, enabled: false } }))).toBe('ask')
    expect(approvalsMode(mkSettings({}))).toBe('ask')
  })
})
