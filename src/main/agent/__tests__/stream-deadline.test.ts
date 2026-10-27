// Test delle scadenze dello stream (fase 8, §3bis L11): primo token entro
// firstTokenMs, inattività tra due chunk entro idleMs. I tempi sono piccoli e
// gli iteratori finti: niente orologi finti, scadenze reali in millisecondi.
import { describe, expect, it } from 'vitest'
import { nextWithDeadline, StreamDeadlineError, DEFAULT_STREAM_DEADLINES } from '../stream-deadline'

/** Iteratore finto: risolve i chunk in sequenza; una voce 'hang' non risponde mai. */
function fakeIter(script: Array<'a' | 'hang' | 'done'>): AsyncIterator<string> {
  let i = 0
  return {
    next: () => {
      const step = script[i++] ?? 'done'
      if (step === 'hang') return new Promise<IteratorResult<string>>(() => undefined)
      if (step === 'done') return Promise.resolve({ done: true as const, value: undefined })
      return Promise.resolve({ done: false, value: step })
    }
  }
}

const OPTS = { firstTokenMs: 10_000, idleMs: 40 }

describe('nextWithDeadline', () => {
  it('i valori di default sono 150 s per il primo token e 90 s di inattività', () => {
    expect(DEFAULT_STREAM_DEADLINES).toEqual({ firstTokenMs: 150_000, idleMs: 90_000 })
  })

  it('chunk tempestivi: nessuna scadenza, il risultato passa intatto', async () => {
    const it = fakeIter(['a', 'a', 'done'])
    expect((await nextWithDeadline(it, false, OPTS)).value).toBe('a')
    expect((await nextWithDeadline(it, true, OPTS)).value).toBe('a')
    expect((await nextWithDeadline(it, true, OPTS)).done).toBe(true)
  })

  it('nessun primo chunk entro firstTokenMs → StreamDeadlineError first-token', async () => {
    const opts = { firstTokenMs: 30, idleMs: 40 }
    await expect(nextWithDeadline(fakeIter(['hang']), false, opts)).rejects.toMatchObject({ deadline: 'first-token' })
    await expect(nextWithDeadline(fakeIter(['hang']), false, opts)).rejects.toBeInstanceOf(StreamDeadlineError)
  })

  it('chunk arrivati e poi silenzio oltre idleMs → StreamDeadlineError idle', async () => {
    const it = fakeIter(['a', 'hang'])
    const opts = { firstTokenMs: 10_000, idleMs: 30 }
    expect((await nextWithDeadline(it, false, opts)).value).toBe('a')
    await expect(nextWithDeadline(it, true, opts)).rejects.toMatchObject({ deadline: 'idle' })
  })

  it('prima del primo chunk vale firstTokenMs, non idleMs', async () => {
    // idleMs minuscolo ma firstTokenMs grande: il primo chunk lento PASSA
    const slow = {
      next: () => new Promise<IteratorResult<string>>((res) => setTimeout(() => res({ done: false, value: 'x' }), 60))
    }
    const r = await nextWithDeadline(slow, false, { firstTokenMs: 10_000, idleMs: 20 })
    expect(r.value).toBe('x')
  })
})
