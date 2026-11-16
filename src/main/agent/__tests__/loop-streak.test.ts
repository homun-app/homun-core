// SV7 (fase schermo-vivo) — la serie con i RISULTATI: trackToolStreak è PURA
// e qui c'è la TABELLA DEI CASI — per ogni soglia, un passo PRIMA non ferma e
// la soglia ferma. Più le impronte (tempi e durate via, lo schermo invariato
// come stessa risposta, l'errore come fallimento) e le chiavi «simili».
import { describe, expect, it } from 'vitest'
import {
  trackToolStreak,
  initialToolStreakState,
  shapeKeyOf,
  toolResultFingerprint,
  normalizeResultForFingerprint,
  IDENTICAL_FAILING_STOP,
  IDENTICAL_NO_PROGRESS_STOP,
  SIMILAR_STOP,
  SAME_RESULT_STOP,
  OVER_LIMIT_ACTIONS_STOP,
  type ToolStreakState,
  type TrackedToolCall
} from '../loop-guard'

const call = (name: string, args: string): TrackedToolCall => ({ name, args })
const ok = (fingerprint: string) => ({ fingerprint, failed: false })
const fail = (fingerprint: string) => ({ fingerprint, failed: true })

/** Spinge N chiamate identiche sulla serie e torna lo stato + l'ultima fermata. */
function run(state: ToolStreakState, c: TrackedToolCall, r: { fingerprint: string; failed: boolean; overLimit?: boolean }, n: number) {
  let s = state
  let stop = null as ReturnType<typeof trackToolStreak>['stop']
  for (let i = 0; i < n; i++) {
    const out = trackToolStreak(s, c, r)
    s = out.state
    stop = out.stop
  }
  return { s, stop }
}

describe('SV7: trackToolStreak — la tabella delle soglie', () => {
  it('le soglie esportate sono quelle decise (3/6/25/25/4)', () => {
    expect(IDENTICAL_FAILING_STOP).toBe(3)
    expect(IDENTICAL_NO_PROGRESS_STOP).toBe(6)
    expect(SIMILAR_STOP).toBe(25)
    expect(SAME_RESULT_STOP).toBe(25)
    expect(OVER_LIMIT_ACTIONS_STOP).toBe(4)
  })

  it('chiamata identica che FALLISCE: 2 non fermano, la TERZA ferma (identical-failing)', () => {
    const c = call('mcp__srv__query', '{"q":"stato"}')
    const two = run(initialToolStreakState(), c, fail('f1'), IDENTICAL_FAILING_STOP - 1)
    expect(two.stop).toBeNull()
    const three = run(initialToolStreakState(), c, fail('f1'), IDENTICAL_FAILING_STOP)
    expect(three.stop).toBe('identical-failing')
  })

  it('chiamata identica con la STESSA risposta riuscita: 5 non fermano, la SESTA ferma (identical-no-progress)', () => {
    const c = call('list-credentials', '{}')
    const five = run(initialToolStreakState(), c, ok('fp-uguale'), IDENTICAL_NO_PROGRESS_STOP - 1)
    expect(five.stop).toBeNull()
    const six = run(initialToolStreakState(), c, ok('fp-uguale'), IDENTICAL_NO_PROGRESS_STOP)
    expect(six.stop).toBe('identical-no-progress')
  })

  it('chiamate identiche con risposte DIVERSE: 24 non fermano, la 25ª ferma (similar)', () => {
    const c = call('run-command', '{"command":"ls"}')
    let s = initialToolStreakState()
    let stop = null as string | null
    for (let i = 0; i < SIMILAR_STOP; i++) {
      const out = trackToolStreak(s, c, ok('risposta-' + (i % 3))) // risposte che si ripetono ma NON identiche alla precedente
      s = out.state
      stop = out.stop
    }
    // un passo prima della soglia non ferma
    expect(s.similar).toBe(SIMILAR_STOP)
    expect(stop).toBe('similar')
    // e ricontrollo che a 24 non fermasse
    let s2 = initialToolStreakState()
    let stop2 = null as string | null
    for (let i = 0; i < SIMILAR_STOP - 1; i++) {
      const out = trackToolStreak(s2, c, ok('risposta-' + (i % 3)))
      s2 = out.state
      stop2 = out.stop
    }
    expect(stop2).toBeNull()
  })

  it('chiamate che cambiano SOLO NEI NUMERI sono SIMILI: la 25ª ferma (similar)', () => {
    let s = initialToolStreakState()
    let stop = null as string | null
    for (let i = 1; i <= SIMILAR_STOP; i++) {
      const out = trackToolStreak(s, call('web_fetch', JSON.stringify({ url: `https://sito.example/pagina?n=${i}` })), ok('fp-' + i))
      s = out.state
      stop = out.stop
    }
    expect(stop).toBe('similar')
  })

  it('lo STESSO strumento con la STESSA risposta QUALUNQUE input: la 25ª ferma (same-result)', () => {
    let s = initialToolStreakState()
    let stop = null as string | null
    for (let i = 1; i <= SAME_RESULT_STOP; i++) {
      const out = trackToolStreak(s, call('list-credentials', JSON.stringify({ q: i })), ok('sempre-questa'))
      s = out.state
      stop = out.stop
    }
    expect(stop).toBe('same-result')
  })

  it('computer_act oltre il limite RIFIUTATO di fila: la QUARTA ferma (over-limit-actions)', () => {
    // lotti DIVERSI fra loro (il modello ritenta con altri comandi giganti):
    // conta la serie dei RIFIUTI, non l'identità delle chiamate
    const lot = (n: number) => call('computer_act', JSON.stringify({ actions: [{ kind: 'click', index: n }, ...Array.from({ length: 30 }, (_v, i) => ({ kind: 'wait', ms: 100 + i }))] }))
    let s = initialToolStreakState()
    let stop = null as string | null
    for (let i = 1; i <= OVER_LIMIT_ACTIONS_STOP; i++) {
      const out = trackToolStreak(s, lot(i), { fingerprint: 'rifiuto-' + i, failed: true, overLimit: true })
      s = out.state
      stop = out.stop
      if (i < OVER_LIMIT_ACTIONS_STOP) expect(stop).toBeNull()
    }
    expect(stop).toBe('over-limit-actions')
  })

  it('await_shell con la STESSA risposta NON ferma a 6 (aspettare è il suo mestiere): ferma solo tra i simili a 25', () => {
    const c = call('await_shell', '{"shellId":"s1"}')
    const six = run(initialToolStreakState(), c, ok('ancora in corso'), IDENTICAL_NO_PROGRESS_STOP)
    expect(six.stop).toBeNull() // niente identical-no-progress per le attese
    let s = six.s
    let stop = null as string | null
    for (let i = 0; i < SIMILAR_STOP - IDENTICAL_NO_PROGRESS_STOP; i++) {
      const out = trackToolStreak(s, c, ok('ancora in corso'))
      s = out.state
      stop = out.stop
    }
    expect(stop).toBe('similar') // ma la serie «simile» cresce comunque
  })

  it('un errore CONTA COME FALLIMENTO: tre identiche con errore fermano', () => {
    const c = call('web_fetch', '{"url":"https://x.example"}')
    let s = initialToolStreakState()
    let stop = null as string | null
    for (let i = 0; i < 3; i++) {
      const out = trackToolStreak(s, c, fail(toolResultFingerprint('Error: connection refused')))
      s = out.state
      stop = out.stop
    }
    expect(stop).toBe('identical-failing')
  })

  it('una chiamata DIVERSA azzera le serie delle identiche: mai falsi positivi', () => {
    let s = initialToolStreakState()
    s = trackToolStreak(s, call('web_fetch', '{"url":"https://a.example"}'), ok('r1')).state
    s = trackToolStreak(s, call('web_fetch', '{"url":"https://a.example"}'), fail('boom')).state
    // una chiamata diversa (forma diversa) azzera le identiche e RIAPRE la
    // serie dei simili da 1 (la prima di una serie nuova conta)
    s = trackToolStreak(s, call('list-credentials', '{}'), ok('r2')).state
    expect(s.keyFailing).toBe(0)
    expect(s.similar).toBe(1)
  })
})

describe('SV7: le impronte dei risultati', () => {
  it('tempi e durate NON contano: lo stesso contenuto con orari diversi è la STESSA impronta', () => {
    const a = toolResultFingerprint('Comando eseguito in 123 ms alle 2026-11-16T13:40:12Z\nok')
    const b = toolResultFingerprint('Comando eseguito in 987 ms alle 2026-11-16T13:41:59Z\nok')
    expect(a).toBe(b)
  })

  it('lo schermo INVIARIATO... due catture uguali hanno la STESSA impronta', () => {
    // il loop passa direttamente il fatto «schermo invariato»: qui si prova che
    // due catture con SOLO l'ora diversa hanno la stessa impronta
    const a = toolResultFingerprint('Screen: 1280x800.\nThe screen is unchanged since your last screenshot.')
    const b = toolResultFingerprint('Screen: 1280x800.\nThe screen is unchanged since your last screenshot.')
    expect(a).toBe(b)
  })

  it('contenuti DIVERSI hanno impronte diverse', () => {
    expect(toolResultFingerprint('risposta A')).not.toBe(toolResultFingerprint('risposta B'))
  })

  it('la chiave SIMILE sostituisce le sequenze di cifre', () => {
    expect(shapeKeyOf('web_fetch', '{"url":"https://x.example/p2?n=42"}'))
      .toBe(shapeKeyOf('web_fetch', '{"url":"https://x.example/p9?n=777"}'))
    expect(shapeKeyOf('web_fetch', '{"url":"https://x.example/p2?n=42"}'))
      .not.toBe(shapeKeyOf('web_fetch', '{"url":"https://altro.example/p2?n=42"}'))
  })

  it('la normalizzazione toglie le durate in italiano e in inglese', () => {
    const n = normalizeResultForFingerprint('fatto in 30 secondi, poi 1.5 s e 250 ms e 12:30')
    expect(n).not.toMatch(/\d/)
  })
})
