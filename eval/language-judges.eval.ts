// Fase 17b (A5): verifica OFFLINE della suite eval — giudici e controllo di
// lingua su TRASCRIZIONI FINTTE, nelle due lingue, senza alcun modello. Gira
// con la config dell'eval (npx vitest run --config vitest.eval.config.ts
// eval/language-judges.eval.ts): importa behaviors.eval.ts con EVAL_SKIP_SUITE=1
// così la corsa del modello non si registra, e giudica i casi 1, 36 e 39 con
// turni costruiti a mano, per it e per en.
import { describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '../src/main/agent/llm'

/** il modulo dell'eval in una lingua: EVAL_LANG decisa PRIMA dell'import */
const loadEval = async (lang: 'it' | 'en') => {
  process.env.EVAL_LANG = lang
  process.env.EVAL_SKIP_SUITE = '1'
  vi.resetModules()
  return await import('./behaviors.eval.js')
}

/** un turno sintetico: N tool call in un passo, i messaggi consegnati, niente errori */
const turnOf = (
  calls: ToolCall[],
  delivered: string[]
): { steps: Array<{ text: string; toolCalls: ToolCall[] }>; delivered: string[]; allCalls: ToolCall[]; error?: string; endedWithAsk: boolean } => ({
  steps: [{ text: '', toolCalls: calls }],
  delivered,
  allCalls: calls,
  endedWithAsk: calls.some((c) => c.name === 'ask_user')
})

const tc = (id: string, name: string, args: Record<string, unknown>): ToolCall =>
  ({ id, name, arguments: JSON.stringify(args) })

/** il testo in una lingua fissa, indipendente dal run (per le trascrizioni finte) */
const one = (calls: ToolCall[], delivered: string[], lang: 'it' | 'en') =>
  ({ calls, delivered, lang })

describe('fase 17b (A5): giudici dell\'eval con trascrizioni finte, nelle due lingue', () => {
  for (const runLang of ['it', 'en'] as const) {
    it(`run=${runLang}: caso 1 (silenzio della routine) è indipendente dalla lingua`, async () => {
      const { CASES } = await loadEval(runLang)
      const judge = CASES.find((c) => c.id === 1)!.judge
      // nessun messaggio consegnato → passa
      expect(judge(turnOf([tc('h1', 'mcp__gmail__search', { query: 'is:unread' })], [])).pass).toBe(true)
      // un riepilogo vuoto consegnato → fallisce
      expect(judge(turnOf([], ['Nessuna novità.'])).pass).toBe(false)
    })

    it(`run=${runLang}: caso 36 passa SOLO se la risposta è nella lingua del MESSAGGIO (l'altra)`, async () => {
      const { CASES } = await loadEval(runLang)
      const judge = CASES.find((c) => c.id === 36)!.judge
      const other = runLang === 'it' ? 'en' : 'it'
      const inOther = other === 'it'
        ? 'Certo: posso leggere la tua posta e prepararti la giornata.'
        : 'Sure: I can read your mail and prepare your day.'
      const inRun = runLang === 'it'
        ? 'Certo: posso leggere la tua posta e prepararti la giornata.'
        : 'Sure: I can read your mail and prepare your day.'
      expect(judge(turnOf([], [inOther])).pass).toBe(true)
      expect(judge(turnOf([], [inRun])).pass).toBe(false)
      // niente consegnato → fallisce
      expect(judge(turnOf([], [])).pass).toBe(false)
    })

    it(`run=${runLang}: caso 39 (documento) vuole write_document lungo + messaggio breve`, async () => {
      const { CASES } = await loadEval(runLang)
      const judge = CASES.find((c) => c.id === 39)!.judge
      const doc = tc('d1', 'write_document', {
        title: 'Ferie del team',
        content: (runLang === 'it'
          ? 'Come organizzare le ferie del team: raccolta delle preferenze, calendario condiviso, turni di copertura.'
          : 'How to organize the team vacation schedule: collect preferences, shared calendar, coverage shifts.') + ' ' + 'x'.repeat(600)
      })
      const brief = runLang === 'it' ? 'Nota pronta in libreria.' : 'Note ready in the library.'
      expect(judge(turnOf([doc], [brief])).pass).toBe(true)
      // contenuto troppo corto → fallisce
      const short = tc('d2', 'write_document', { title: 'Ferie', content: 'poco' })
      expect(judge(turnOf([short], [brief])).pass).toBe(false)
      // nessun messaggio all'utente → fallisce
      expect(judge(turnOf([doc], [])).pass).toBe(false)
    })

    it(`run=${runLang}: caso 37 (novità VERA nella routine) vuole UN messaggio che cita la scadenza`, async () => {
      const { CASES } = await loadEval(runLang)
      const judge = CASES.find((c) => c.id === 37)!.judge
      const cite = runLang === 'it'
        ? 'La consegna dei materiali è domani alle 10: serve la tua firma.'
        : 'The material delivery is tomorrow at 10: your signature is needed.'
      expect(judge(turnOf([], [cite])).pass).toBe(true)
      // senza la scadenza → fallisce
      expect(judge(turnOf([], [runLang === 'it' ? 'Una email dal fornitore.' : 'An email from the supplier.'])).pass).toBe(false)
      // due messaggi → fallisce
      expect(judge(turnOf([], [cite, cite])).pass).toBe(false)
    })

    it(`run=${runLang}: caso 38 (brief nell'altra lingua) vuole il post nel gruppo`, async () => {
      const { CASES } = await loadEval(runLang)
      const judge = CASES.find((c) => c.id === 38)!.judge
      const post = tc('g1', 'post_to_group', { text: runLang === 'it' ? 'Lista della spesa pronta per 8 persone.' : 'Shopping list ready for 8 people.' })
      expect(judge(turnOf([post], [])).pass).toBe(true)
      expect(judge(turnOf([], [runLang === 'it' ? 'Lista pronta.' : 'List ready.'])).pass).toBe(false)
    })

    it(`run=${runLang}: controllo di lingua conta ok/sbagliati/non decidibili sui testi controllati`, async () => {
      const { controlledTexts, expectedLangOf } = await loadEval(runLang)
      const { detectLanguage } = await import('../src/shared/language')
      const other = runLang === 'it' ? 'en' : 'it'
      const textIn = (lang: 'it' | 'en') => lang === 'it'
        ? 'Ecco il riepilogo della tua posta in arrivo di oggi.'
        : 'Here is the summary of your incoming mail for today.'
      const turn = turnOf([
        tc('s1', 'send_to_user', { text: textIn(runLang) }),
        tc('a1', 'ask_user', { prompt: textIn(runLang), options: [{ label: textIn(runLang) }] }),
        tc('s2', 'send_to_user', { text: textIn(other) }),
        tc('p1', 'post_to_group', { text: 'ok' })
      ], [])
      const texts = controlledTexts(turn as never)
      // send + ask prompt + option nella lingua del run; un testo nell'altra;
      // «ok» è non decidibile
      let ok = 0, wrong = 0, undecidable = 0
      for (const [, text] of texts) {
        const det = detectLanguage(text)
        if (det === null) { undecidable++; continue }
        if (det === expectedLangOf(1)) ok++
        else wrong++
      }
      expect(ok).toBe(3)
      expect(wrong).toBe(1)
      expect(undecidable).toBeGreaterThanOrEqual(1)
      // il caso 36 attende l'ALTRA lingua
      expect(expectedLangOf(36)).toBe(other)
      expect(expectedLangOf(1)).toBe(runLang)
    })
  }
})
