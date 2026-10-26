// Codec WebSocket minimale (RFC 6455) per il canale UI ↔ daemon su 127.0.0.1:
// frame text, ping/pong, close; client→server mascherati, server→client no.
// Solo JSON locali di piccola dimensione, niente estensioni niente frammenti
// (i continuation frame vengono concatenati dal server). Zero dipendenze.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const OP_CONT = 0x0
export const OP_TEXT = 0x1
export const OP_BINARY = 0x2
export const OP_CLOSE = 0x8
export const OP_PING = 0x9
export const OP_PONG = 0xa

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Valore dell'header Sec-WebSocket-Accept per l'handshake del server. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Confronto di token a tempo costante (il token vive in un file 0600, ma non costa nulla). */
export function tokenEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest()
  )
}

export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** Dimensione massima accettata per un frame (i messaggi RPC sono JSON piccoli). */
export const MAX_FRAME_BYTES = 10 * 1024 * 1024

/**
 * Codifica un frame. I frame client→server DEVONO essere mascherati (RFC
 * 6455 §5.1); quelli server→client mai.
 */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN sempre 1: nessuna frammentazione in uscita
  if (!mask) return Buffer.concat([header, payload])
  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ key[i % 4]!
  return Buffer.concat([header, key, masked])
}

/**
 * Estrae il primo frame completo dal buffer; null se i byte non bastano.
 * Accetta frame mascherati e no, smaschera il payload, torna anche i byte
 * residui per il frame successivo.
 */
export function decodeFrame(buf: Buffer): { frame: WsFrame; rest: Buffer } | null {
  if (buf.length < 2) return null
  const fin = (buf[0]! & 0x80) !== 0
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let len = buf[1]! & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame WebSocket troppo grande')
    len = Number(big)
    off = 10
  }
  if (len > MAX_FRAME_BYTES) throw new Error('frame WebSocket troppo grande')
  const maskKey = masked ? buf.subarray(off, off + 4) : null
  if (masked) off += 4
  if (buf.length < off + len) return null
  let payload = buf.subarray(off, off + len)
  if (maskKey) {
    const out = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ maskKey[i % 4]!
    payload = out
  }
  return { frame: { fin, opcode, payload }, rest: buf.subarray(off + len) }
}
