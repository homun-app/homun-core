// Fase 19b (T7): la codifica dei frame del terminale (shared/terminal-frames)
// — input, resize, limiti. Il protocollo è quello di Rakazo:
// [kind:u8][len:u32be][payload], kind 0 = byte per il pty, kind 1 = resize
// cols:u16be rows:u16be limitati 1–1000.
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_INPUT, TERMINAL_RESIZE, TERMINAL_MAX_FRAME,
  encodeTerminalFrame, encodeTerminalInput, encodeTerminalResize, clampTerminalSize
} from '../terminal-frames'

describe('fase 19b (T7): i frame del terminale', () => {
  it('le costanti: input 0, resize 1, tetto 1 MiB', () => {
    expect(TERMINAL_INPUT).toBe(0)
    expect(TERMINAL_RESIZE).toBe(1)
    expect(TERMINAL_MAX_FRAME).toBe(1 << 20)
  })

  it('encodeTerminalFrame: [kind:u8][len:u32be][payload]', () => {
    const f = encodeTerminalFrame(0, new Uint8Array([0x61, 0x62, 0x63]))
    expect(Array.from(f)).toEqual([0, 0, 0, 0, 3, 0x61, 0x62, 0x63])
    // payload lungo: la lunghezza viaggia BIG-ENDIAN su 4 byte
    const big = encodeTerminalFrame(1, new Uint8Array(300).fill(7))
    expect(big.length).toBe(5 + 300)
    expect(big[1]).toBe(0)
    expect(big[2]).toBe(0)
    expect(big[3]).toBe(1)
    expect(big[4]).toBe(0x2c)
  })

  it('encodeTerminalInput: il testo diventa UTF-8 in un frame kind 0', () => {
    const f = encodeTerminalInput('ls -la\n')
    expect(f[0]).toBe(TERMINAL_INPUT)
    const len = (f[1]! << 24) | (f[2]! << 16) | (f[3]! << 8) | f[4]!
    expect(len).toBe(7)
    expect(new TextDecoder().decode(f.subarray(5))).toBe('ls -la\n')
    // il testo multibyte resta byte UTF-8
    const acc = encodeTerminalInput('àè')
    expect(new TextDecoder().decode(acc.subarray(5))).toBe('àè')
  })

  it('encodeTerminalResize: cols e rows in u16be, limitati a 1–1000', () => {
    const f = encodeTerminalResize(120, 40)
    expect(f[0]).toBe(TERMINAL_RESIZE)
    const len = (f[1]! << 24) | (f[2]! << 16) | (f[3]! << 8) | f[4]!
    expect(len).toBe(4)
    expect(f[5]).toBe(0)
    expect(f[6]).toBe(120)
    expect(f[7]).toBe(0)
    expect(f[8]).toBe(40)
    // i limiti: sotto 1 → 1, sopra 1000 → 1000, NaN e 0 → 1
    expect(clampTerminalSize(1)).toBe(1)
    expect(clampTerminalSize(0)).toBe(1)
    expect(clampTerminalSize(Number.NaN)).toBe(1)
    expect(clampTerminalSize(1000)).toBe(1000)
    expect(clampTerminalSize(4000)).toBe(1000)
    expect(clampTerminalSize(80.4)).toBe(80)
    const clamped = encodeTerminalResize(4000, 0)
    expect((clamped[5]! << 8) | clamped[6]!).toBe(1000)
    expect((clamped[7]! << 8) | clamped[8]!).toBe(1)
  })
})
