// Webhook dei trigger (fase 6, §3bis L3): POST http://127.0.0.1:<porta del
// daemon>/hooks/<routineId> con Authorization: Bearer <token della routine>.
// Corpo massimo 64 KB; token sbagliato → 401, routine assente/disattiva →
// 404, corpo troppo grande → 413. La richiesta valida accoda un job
// 'routine-run' con l'evento nel payload (entra nel turno nel blocco
// <evento>, come dato e non come istruzione). Il corpo non scade mai nella
// coda: un webhook ricevuto a agente occupato viene eseguito appena libero.
import { timingSafeEqual, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { getRoutine } from '../main/store/db'
import { enqueueJob } from '../main/store/jobs'
import type { SandbotEvent, TriggerEventPayload } from '../shared/types'

/** Tetto del corpo della richiesta (spec: 64 KB). */
export const WEBHOOK_MAX_BODY = 64 * 1024

/** Genera il token di una routine webhook (il server lo crea, la UI lo copia). */
export function generateWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export interface WebhookDeps {
  db: DatabaseSync
  emit(e: SandbotEvent): void
  now(): number
}

/** Confronto timing-safe del token (Bearer). */
export function webhookTokenOk(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(header ?? '')
  if (!m) return false
  const a = Buffer.from(m[1]!)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Legge il corpo rispettando il tetto: null se superato (→ 413). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

const send = (res: ServerResponse, code: number, body: Record<string, unknown>): void => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** La richiesta è per un hook? (POST /hooks/<routineId>) */
export function isWebhookRequest(req: IncomingMessage): boolean {
  return req.method === 'POST' && !!/^\/hooks\/\d+/.exec(req.url ?? '')
}

/**
 * Gestisce la richiesta di webhook; true se era un /hooks/* (ha risposto).
 * Il token vive nel trigger della routine (creato insieme, mostrato dalla UI
 * per essere copiato): non c'è auth del canale ws qui perché il chiamante è
 * un sistema esterno, non la UI.
 */
export async function handleWebhook(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps): Promise<boolean> {
  if (!isWebhookRequest(req)) return false
  const id = Number(/^\/hooks\/(\d+)/.exec(req.url ?? '')?.[1])
  const routine = Number.isInteger(id) && id > 0 ? getRoutine(id) : null
  const trigger = routine?.trigger
  if (!routine || trigger?.type !== 'webhook') {
    send(res, 404, { ok: false, error: 'routine webhook non trovata' })
    return true
  }
  if (!webhookTokenOk(req.headers.authorization, trigger.token)) {
    send(res, 401, { ok: false, error: 'token non valido' })
    return true
  }
  const body = await readBody(req, WEBHOOK_MAX_BODY)
  if (body === null) {
    send(res, 413, { ok: false, error: `corpo oltre ${WEBHOOK_MAX_BODY} byte` })
    return true
  }
  if (!routine.enabled) {
    send(res, 404, { ok: false, error: 'routine in pausa' })
    return true
  }
  const text = body.toString('utf8')
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    // corpo non JSON: entra come testo grezzo
  }
  const now = deps.now()
  const event: TriggerEventPayload = {
    source: 'webhook',
    title: 'Webhook ricevuto',
    data,
    at: now
  }
  enqueueJob(deps.db, {
    agentId: routine.agent_id,
    kind: 'routine-run',
    payload: { routineId: routine.id, title: routine.title, prompt: routine.prompt, event },
    runAt: now,
    now
  })
  send(res, 200, { ok: true })
  return true
}
