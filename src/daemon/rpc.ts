// Protocollo sul canale UI ↔ daemon: RPC JSON {id, method, params} con
// risposta {id, ok, result | error}, eventi push {ev} (le stesse SandbotEvent
// di oggi) e handshake {hello, token}. Nessun messaggio viene processato
// prima dell'hello: le connessioni senza token valido vengono rifiutate.
// Funzioni pure (serializzazione e validation), testabili senza socket.
import type { SandbotEvent } from '../shared/types'
import { tokenEquals } from '../shared/ws'

export interface RpcRequestMsg { rpc: true; id: number; method: string; params?: unknown[] }
export type RpcResponseMsg =
  | { rpc: true; id: number; ok: true; result: unknown }
  | { rpc: true; id: number; ok: false; error: string }
export interface HelloMsg { hello: true; token: string }
export interface HelloOkMsg { hello: true; ok: boolean }
export interface EventMsg { ev: SandbotEvent }

export type IncomingMessage = RpcRequestMsg | RpcResponseMsg | HelloMsg | HelloOkMsg | EventMsg

/** Parsifica un messaggio in entrata; null se il JSON o la forma non è del protocollo. */
export function parseMessage(text: string): IncomingMessage | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  if (m.hello === true && typeof m.token === 'string') return { hello: true, token: m.token }
  if (m.hello === true && typeof m.ok === 'boolean') return { hello: true, ok: m.ok }
  if (m.rpc === true && typeof m.id === 'number' && typeof m.method === 'string') {
    return { rpc: true, id: m.id, method: m.method, params: Array.isArray(m.params) ? m.params : [] }
  }
  if (m.rpc === true && typeof m.id === 'number' && m.ok === true) {
    return { rpc: true, id: m.id, ok: true, result: m.result }
  }
  if (m.rpc === true && typeof m.id === 'number' && m.ok === false && typeof m.error === 'string') {
    return { rpc: true, id: m.id, ok: false, error: m.error }
  }
  if (m.ev !== null && typeof m.ev === 'object' && typeof (m.ev as { type?: unknown }).type === 'string') {
    return { ev: m.ev as SandbotEvent }
  }
  return null
}

export const serializeRpcRequest = (id: number, method: string, params: unknown[] = []): string =>
  JSON.stringify({ rpc: true, id, method, params })

export const serializeRpcOk = (id: number, result: unknown): string =>
  JSON.stringify({ rpc: true, id, ok: true, result })

export const serializeRpcError = (id: number, error: string): string =>
  JSON.stringify({ rpc: true, id, ok: false, error })

export const serializeHello = (token: string): string => JSON.stringify({ hello: true, token })
export const serializeHelloOk = (ok: boolean): string => JSON.stringify({ hello: true, ok })
export const serializeEvent = (e: SandbotEvent): string => JSON.stringify({ ev: e })

/** Il primo messaggio è un hello col token giusto? (rifiuta tutto il resto) */
export function isHelloAuthorized(msg: IncomingMessage | null, expectedToken: string): boolean {
  if (msg === null || !('hello' in msg) || !('token' in msg)) return false
  return tokenEquals(msg.token, expectedToken)
}
