// Test del protocollo RPC (serializzazione, handshake col token) e del codec
// WebSocket (RFC 6455): tutto puro, nessuna socket reale.
import { describe, expect, it } from 'vitest'
import {
  parseMessage, serializeRpcRequest, serializeRpcOk, serializeRpcError,
  serializeHello, serializeHelloOk, serializeEvent, isHelloAuthorized
} from '../rpc'
import { encodeFrame, decodeFrame, acceptKey, tokenEquals, OP_TEXT, OP_PING } from '../../shared/ws'

describe('protocollo RPC: serializzazione e parsing', () => {
  it('round-trip richiesta → risposta', () => {
    const req = serializeRpcRequest(7, 'agents:list', [])
    expect(parseMessage(req)).toEqual({ rpc: true, id: 7, method: 'agents:list', params: [] })

    const ok = serializeRpcOk(7, [{ id: 'a1', name: 'Bot' }])
    const parsedOk = parseMessage(ok)!
    expect(parsedOk).toMatchObject({ rpc: true, id: 7, ok: true })
    if ('rpc' in parsedOk && 'ok' in parsedOk && parsedOk.ok) {
      expect(parsedOk.result).toEqual([{ id: 'a1', name: 'Bot' }])
    }

    const err = serializeRpcError(7, 'boom')
    expect(parseMessage(err)).toEqual({ rpc: true, id: 7, ok: false, error: 'boom' })
  })

  it('gli eventi push viaggiano come {ev: SandbotEvent}', () => {
    const text = serializeEvent({ type: 'status', agentId: 'a1', status: 'idle' })
    expect(parseMessage(text)).toEqual({ ev: { type: 'status', agentId: 'a1', status: 'idle' } })
  })

  it('hello: serializzazione e risposta', () => {
    expect(parseMessage(serializeHello('tok123'))).toEqual({ hello: true, token: 'tok123' })
    expect(parseMessage(serializeHelloOk(true))).toEqual({ hello: true, ok: true })
    expect(parseMessage(serializeHelloOk(false))).toEqual({ hello: true, ok: false })
  })

  it('JSON non del protocollo o rotto → null', () => {
    expect(parseMessage('non json')).toBeNull()
    expect(parseMessage('{}')).toBeNull()
    expect(parseMessage('{"hello":true}')).toBeNull() // manca il token
    expect(parseMessage('{"rpc":true,"method":"x"}')).toBeNull() // manca l'id
    expect(parseMessage('42')).toBeNull()
  })

  it('i parametri non-array diventano array vuoti (difensivo)', () => {
    expect(parseMessage('{"rpc":true,"id":1,"method":"m","params":"nope"}')).toEqual({
      rpc: true, id: 1, method: 'm', params: []
    })
  })
})

describe('autenticazione: token errato rifiutato', () => {
  it('isHelloAuthorized accetta solo l\'hello col token esatto come PRIMO messaggio', () => {
    expect(isHelloAuthorized(parseMessage(serializeHello('giusto')), 'giusto')).toBe(true)
    expect(isHelloAuthorized(parseMessage(serializeHello('sbagliato')), 'giusto')).toBe(false)
    // il primo messaggio NON è un hello → rifiutato
    expect(isHelloAuthorized(parseMessage(serializeRpcRequest(1, 'agents:list')), 'giusto')).toBe(false)
    expect(isHelloAuthorized(null, 'giusto')).toBe(false)
    // la risposta hello-ok non è un hello valido
    expect(isHelloAuthorized(parseMessage(serializeHelloOk(true)), 'giusto')).toBe(false)
  })

  it('tokenEquals: confronto esatto, mai per prefisso', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true)
    expect(tokenEquals('abc', 'abd')).toBe(false)
    expect(tokenEquals('abc', 'abcdef')).toBe(false)
    expect(tokenEquals('', '')).toBe(true)
  })
})

describe('codec WebSocket (RFC 6455)', () => {
  it('acceptKey: vettore noto della RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('frame client→server mascherato: encode e decode round-trip', () => {
    const payload = Buffer.from('{"rpc":true,"id":1,"method":"ping"}', 'utf8')
    const frame = encodeFrame(OP_TEXT, payload, true)
    // bit MASK del client è acceso
    expect(frame[1]! & 0x80).toBe(0x80)
    const decoded = decodeFrame(frame)!
    expect(decoded.frame.opcode).toBe(OP_TEXT)
    expect(decoded.frame.payload.equals(payload)).toBe(true)
    expect(decoded.rest.length).toBe(0)
  })

  it('frame server→client non mascherato', () => {
    const payload = Buffer.from('ciao')
    const frame = encodeFrame(OP_TEXT, payload, false)
    expect(frame[1]! & 0x80).toBe(0)
    const decoded = decodeFrame(frame)!
    expect(decoded.frame.payload.equals(payload)).toBe(true)
  })

  it('lunghezze a 2 e 8 byte', () => {
    const medium = encodeFrame(OP_TEXT, Buffer.alloc(300, 'x'), false)
    expect(medium[1]! & 0x7f).toBe(126)
    expect(decodeFrame(medium)!.frame.payload.length).toBe(300)

    const big = encodeFrame(OP_TEXT, Buffer.alloc(70_000, 'y'), false)
    expect(big[1]! & 0x7f).toBe(127)
    expect(decodeFrame(big)!.frame.payload.length).toBe(70_000)
  })

  it('frame incompleto → null (niente eccezioni); byte residui restituiti', () => {
    const frame = encodeFrame(OP_TEXT, Buffer.alloc(100, 'z'), false)
    expect(decodeFrame(frame.subarray(0, 40))).toBeNull()
    const two = Buffer.concat([encodeFrame(OP_PING, Buffer.alloc(0), false), frame])
    const first = decodeFrame(two)!
    expect(first.frame.opcode).toBe(OP_PING)
    const second = decodeFrame(first.rest)!
    expect(second.frame.payload.length).toBe(100)
  })

  it('ping del server → il client risponde pong (round-trip del codec)', () => {
    const ping = encodeFrame(OP_PING, Buffer.from('ka'), false)
    const d = decodeFrame(ping)!
    expect(d.frame.opcode).toBe(OP_PING)
    const pong = encodeFrame(0xa, d.frame.payload, true)
    const d2 = decodeFrame(pong)!
    expect(d2.frame.opcode).toBe(0xa)
    expect(d2.frame.payload.toString()).toBe('ka')
  })
})
