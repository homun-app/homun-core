// Fase 19a (V9): il codec WebSocket con l'opcode BINARIO (0x2) — il canale
// del ponte dello schermo (noVNC parla RFB in frame binari). Codifica e
// decodifica dei frame binari, frammentati e no, mascherati e no.
import { describe, expect, it } from 'vitest'
import { encodeFrame, decodeFrame, OP_BINARY, OP_CONT, OP_TEXT, type WsFrame } from '../ws'

/** Un frame grezzo con header esplicito (per la frammentazione in ingresso). */
function rawFrame(fin: boolean, opcode: number, payload: Buffer, mask = false): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  if (mask) header[1] |= 0x80
  if (!mask) return Buffer.concat([header, payload])
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ key[i % 4]!
  return Buffer.concat([header, key, masked])
}

/** Rimette insieme i frammenti come fa il ponte (concat dei continuation). */
function joinFragments(buf: Buffer): { opcode: number; payload: Buffer } | null {
  let rest = buf
  let opcode = 0
  const parts: Buffer[] = []
  while (rest.length) {
    const parsed = decodeFrame(rest)
    if (!parsed) return null
    rest = parsed.rest
    const f: WsFrame = parsed.frame
    if (f.opcode === OP_BINARY || f.opcode === OP_TEXT) opcode = f.opcode
    if (f.opcode === OP_BINARY || f.opcode === OP_TEXT || f.opcode === OP_CONT) parts.push(f.payload)
    if (f.fin) return { opcode, payload: Buffer.concat(parts) }
  }
  return null
}

describe('fase 19a (V9): frame BINARI nel codec WebSocket', () => {
  it('OP_BINARY è 0x2 (l\'opcode del ponte dello schermo)', () => {
    expect(OP_BINARY).toBe(0x2)
    expect(OP_CONT).toBe(0x0)
  })

  it('codifica e decodifica un frame binario INTATTO (roundtrip)', () => {
    // l'handshake RFB: "RFB 003.008\n" e qualche byte dopo
    const rfb = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([0x01, 0x02, 0xff, 0x00])])
    const enc = encodeFrame(OP_BINARY, rfb, false)
    const parsed = decodeFrame(enc)
    expect(parsed).not.toBeNull()
    expect(parsed!.frame.fin).toBe(true)
    expect(parsed!.frame.opcode).toBe(OP_BINARY)
    expect(Buffer.compare(parsed!.frame.payload, rfb)).toBe(0)
    expect(parsed!.rest.length).toBe(0)
  })

  it('il frame server→client non è mascherato; quello client→server SÌ e si decodifica uguale', () => {
    const rfb = Buffer.from('RFB 003.008\n')
    const masked = encodeFrame(OP_BINARY, rfb, true)
    expect(masked[1]! & 0x80).toBe(0x80) // bit di maschera
    const parsed = decodeFrame(masked)
    expect(Buffer.compare(parsed!.frame.payload, rfb)).toBe(0)
    const plain = encodeFrame(OP_BINARY, rfb, false)
    expect(plain[1]! & 0x80).toBe(0)
    // il payload mascherato viaggia OFFUSCATO sul filo
    expect(masked.includes(rfb)).toBe(false)
  })

  it('i frame binari frammentati si rimettono insieme nello STESSO payload', () => {
    const whole = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.alloc(500, 0xab)])
    const fragments = Buffer.concat([
      rawFrame(false, OP_BINARY, whole.subarray(0, 4)),
      rawFrame(false, OP_CONT, whole.subarray(4, 300)),
      rawFrame(true, OP_CONT, whole.subarray(300))
    ])
    const joined = joinFragments(fragments)
    expect(joined).not.toBeNull()
    expect(joined!.opcode).toBe(OP_BINARY)
    expect(Buffer.compare(joined!.payload, whole)).toBe(0)
  })

  it('due frame binari di fila nel buffer: il primo esce, il resto resta', () => {
    const a = encodeFrame(OP_BINARY, Buffer.from('RFB 003.008\n'), false)
    const b = encodeFrame(OP_BINARY, Buffer.from([0x01, 0x00]), false)
    const parsed = decodeFrame(Buffer.concat([a, b]))
    expect(Buffer.compare(parsed!.frame.payload, Buffer.from('RFB 003.008\n'))).toBe(0)
    const second = decodeFrame(parsed!.rest)
    expect(Buffer.compare(second!.frame.payload, Buffer.from([0x01, 0x00]))).toBe(0)
    expect(second!.rest.length).toBe(0)
  })

  it('i frame binari grandi (128 KB, tipo un aggiornamento dello schermo) passano intatti', () => {
    const big = Buffer.alloc(128 * 1024, 0x5a)
    const parsed = decodeFrame(encodeFrame(OP_BINARY, big, false))
    expect(parsed!.frame.payload.length).toBe(128 * 1024)
    expect(Buffer.compare(parsed!.frame.payload, big)).toBe(0)
  })

  it('un frame binario mascherato e frammentato (il client noVNC) si decodifica intero', () => {
    const whole = Buffer.alloc(1000, 0x33)
    const fragments = Buffer.concat([
      rawFrame(false, OP_BINARY, whole.subarray(0, 100), true),
      rawFrame(true, OP_CONT, whole.subarray(100), true)
    ])
    const joined = joinFragments(fragments)
    expect(joined).not.toBeNull()
    expect(Buffer.compare(joined!.payload, whole)).toBe(0)
  })
})
