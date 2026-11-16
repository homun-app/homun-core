// T1 (fase prima-release): le funzioni PURE del guardia delle temporanee —
// il confronto avvio/finestra è verificabile senza creare cartelle vere.
import { describe, expect, it } from 'vitest'
import {
  newLeftovers,
  prefixOf,
  countByPrefix,
  uniqueDirs,
  guardMessage,
} from '../test-tmp-guard'

const p = (dir: string, name: string): string => `${dir}/${name}`

describe('T1 — test-tmp-guard (funzioni pure)', () => {
  it('nessuna nuova: avvio e fine uguali → vuoto', () => {
    const start = [p('/t', 'sandbot-a-111111'), p('/t', 'sandbot-b-222222')]
    expect(newLeftovers(start, [...start])).toEqual([])
  })

  it('una nuova: compare a fine corsa e non era all\'avvio', () => {
    const start = [p('/t', 'sandbot-a-111111')]
    const end = [...start, p('/t', 'sandbot-nuova-333333')]
    expect(newLeftovers(start, end)).toEqual([p('/t', 'sandbot-nuova-333333')])
  })

  it('le sandbot-fase- (le sonde) sono escluse', () => {
    expect(newLeftovers([], [p('/t', 'sandbot-fase-prima-release-x1y2z3')])).toEqual([])
    expect(newLeftovers([], [p('/t', 'sandbot-fase-9ab8c7')])).toEqual([])
  })

  it('una voce non sandbot- è ignorata anche se è nuova', () => {
    expect(newLeftovers([], [p('/t', 'altro-444444'), p('/t', 'com.apple.che-frega')])).toEqual([])
  })

  it('la stessa cartella si conta una volta sola (due base uguali)', () => {
    expect(uniqueDirs(['/private/var/tmp/t', '/private/var/tmp/t'])).toEqual(['/private/var/tmp/t'])
    expect(uniqueDirs(['/a', '/b', '/a', '/b', '/c'])).toEqual(['/a', '/b', '/c'])
  })

  it('il prefisso è tutto fino all\'ultimo trattino (il suffisso mkdtemp)', () => {
    expect(prefixOf('sandbot-box-setup-test-n3Kd2z')).toBe('sandbot-box-setup-test-')
    expect(prefixOf('sandbot-catalogo-abc123')).toBe('sandbot-catalogo-')
    expect(prefixOf('sandbot-vitest-data-XyZ918')).toBe('sandbot-vitest-data-')
  })

  it('countByPrefix conta per prefisso', () => {
    const paths = [
      p('/t', 'sandbot-box-setup-test-111111'),
      p('/t', 'sandbot-box-setup-test-222222'),
      p('/t', 'sandbot-catalogo-333333'),
    ]
    expect(countByPrefix(paths)).toEqual([
      ['sandbot-box-setup-test-', 2],
      ['sandbot-catalogo-', 1],
    ])
  })

  it('il messaggio dice quante, per prefisso, i primi 5 nomi e la regola', () => {
    const paths = Array.from({ length: 7 }, (_, i) =>
      p('/t', `sandbot-box-setup-test-${String(i).padStart(6, '0')}`)
    ).concat([p('/t', 'sandbot-catalogo-999999')])
    const msg = guardMessage(paths)
    expect(msg).toContain('8') // quante in tutto
    expect(msg).toContain('sandbot-box-setup-test- ×7')
    expect(msg).toContain('sandbot-catalogo- ×1')
    // solo i primi 5 nomi
    expect(msg).toContain('sandbot-box-setup-test-000000')
    expect(msg).toContain('sandbot-box-setup-test-000004')
    expect(msg).not.toContain('sandbot-box-setup-test-000005')
    expect(msg).not.toContain('sandbot-box-setup-test-000006')
    expect(msg).not.toContain('sandbot-catalogo-999999')
    expect(msg).toContain('ogni cartella temporanea si cancella a fine test')
  })
})
