// Fase app: il client Composio FINTO, sul modello di composio-fake.ts di
// Rakazo, adattato all'API diretta dell'SDK 0.25.0 (toolkits.get/authorize,
// connectedAccounts.list/waitForConnection/delete, tools.getRawComposioTools/
// execute). Deterministico e offline: lo iniettano i test unitari e la sonda
// Electron (SANDBOT_TEST_FAKE_COMPOSIO=<file json>, valido solo insieme alle
// altre SANDBOT_TEST_*). Il file della sonda:
//   {
//     "toolkits": [{ "slug": "SLACK", "name": "Slack", "category": "comunicazione",
//                    "tagline": "Canali e messaggi", "developerConfig": false }],
//     "tools":    { "SLACK": [{ "slug": "SLACK_SEND_MESSAGE", "name": "Send message",
//                    "description": "…", "version": "20260101_00", "inputParameters": {…} }] },
//     "autoLoginMs": 900
//   }
// Il toolkit senza login ha "noAuth": true; quello che su Composio richiede la
// configurazione dello sviluppatore ha "developerConfig": true. Se il file
// esiste, ogni execute viene APPESA come riga JSON a <file>.calls.log (la
// sonda verifica da fuori che l'execute sia arrivata al finto, UNA volta).
import { existsSync, appendFileSync } from 'node:fs'
import type {
  ComposioClientLike, ComposioConnectedAccount, ComposioConnectionRequest,
  ComposioRawTool, ComposioToolkitData
} from './composio'

/** La riga di una chiamata execute registrata dal finto (file .calls.log). */
export interface FakeComposioExecution {
  userId: string
  slug: string
  version?: string
  arguments: Record<string, unknown>
  at: number
}

/** La voce del toolkit nel file JSON della sonda (più i due flag finti). */
export interface FakeToolkitSpec extends ComposioToolkitData {
  /** mezza riga per la UI (il finto non ha i tagline veri di Composio) */
  tagline?: string
  /** su Composio serve la configurazione dello sviluppatore: non collegabile */
  developerConfig?: boolean
}

/** Il contenuto del file SANDBOT_TEST_FAKE_COMPOSIO. */
export interface FakeComposioSpec {
  toolkits: FakeToolkitSpec[]
  tools?: Record<string, FakeToolSpec[]>
  /** dopo quanti ms il login nel browser «finto» completa (modalità redirect) */
  autoLoginMs?: number
}

export interface FakeToolSpec {
  slug: string
  name?: string
  description?: string
  version?: string
  inputParameters?: Record<string, unknown>
  /** l'execute di QUESTA azione fallisce con error (per provare la pulizia) */
  failWithError?: string
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 })
}

type FakeAccount = {
  id: string
  userId: string
  /** Composio riporta i toolkit degli account in minuscolo */
  toolkit: string
  status: 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'FAILED'
}

/**
 * Il finto: catalogo con paginazione a cursore, OAuth che completa da solo
 * dopo autoLoginMs (o con completeLogin), toolkit senza login, toolkit «da
 * sviluppatore», execute con controllo della versione e log su file.
 */
export class FakeComposioClient implements ComposioClientLike {
  readonly executions: FakeComposioExecution[] = []
  readonly accounts: FakeAccount[] = []
  /** le richieste authorize in attesa del login (id → toolkit) */
  readonly pending = new Map<string, string>()
  readonly authorizeCalls: Array<{ userId: string; slug: string }> = []
  private readonly spec: FakeComposioSpec
  private readonly callsLogFile: string | null
  private nextId = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(spec: FakeComposioSpec, callsLogFile?: string) {
    this.spec = spec
    this.callsLogFile = callsLogFile ?? null
  }

  /** Il finto dal file della sonda (SANDBOT_TEST_FAKE_COMPOSIO): letture e log execute su <file>.calls.log. */
  static fromFileSync(read: (p: string) => string, path: string): FakeComposioClient {
    return new FakeComposioClient(JSON.parse(read(path)) as FakeComposioSpec, `${path}.calls.log`)
  }

  readonly toolkits: ComposioClientLike['toolkits'] = {
    page: async (query) => {
      const limit = query?.limit ?? 50
      const start = Number(query?.cursor ?? 0)
      // il flag developerConfig del file diventa managedAuth: false (il
      // protocollo del daemon: nessun login gestito da Composio)
      const items: ComposioToolkitData[] = this.spec.toolkits.slice(start, start + limit).map((t) => {
        const { developerConfig, ...rest } = t
        return { ...rest, ...(developerConfig ? { managedAuth: false } : {}) }
      })
      return {
        items,
        nextCursor: start + limit < this.spec.toolkits.length ? String(start + limit) : null
      }
    },
    authorize: async (userId, slug) => {
      this.authorizeCalls.push({ userId, slug })
      const toolkit = this.spec.toolkits.find((t) => t.slug.toLowerCase() === slug.toLowerCase())
      if (!toolkit) throw notFound(`Toolkit ${slug} not found`)
      if (toolkit.developerConfig) {
        // l'API diretta rifiuta: nessun login gestito da Composio per il toolkit
        throw new Error('ToolRouterV2_NoManagedAuth: no Composio-managed auth config for this toolkit; the developer must configure authentication')
      }
      if (toolkit.noAuth) {
        throw new Error(`ToolkitsIsNoAuth: ${toolkit.slug} does not require authentication`)
      }
      // OAuth con redirect: l'account nasce INITIATED e diventa ACTIVE dopo
      // autoLoginMs (il «login nel browser»), come fa l'utente vero
      const id = `ca_${++this.nextId}`
      this.accounts.push({ id, userId, toolkit: slug.toLowerCase(), status: 'INITIATED' })
      this.pending.set(id, slug)
      const autoMs = this.spec.autoLoginMs ?? 900
      if (autoMs > 0) {
        const timer = setTimeout(() => this.completeLogin(id), autoMs)
        this.timers.add(timer)
      }
      return this.connectionRequest(id)
    }
  }

  readonly connectedAccounts: ComposioClientLike['connectedAccounts'] = {
    list: async (query) => {
      const toolkits = query?.toolkitSlugs?.map((s) => s.toLowerCase())
      const matches = this.accounts.filter(
        (a) =>
          (!query?.userIds || query.userIds.includes(a.userId)) &&
          (!query?.statuses || query.statuses.includes(a.status)) &&
          (!toolkits || toolkits.includes(a.toolkit))
      )
      const limit = query?.limit ?? 100
      const start = Number(query?.cursor ?? 0)
      return {
        items: matches.slice(start, start + limit).map((a) => this.toAccount(a)),
        nextCursor: start + limit < matches.length ? String(start + limit) : null
      }
    },
    waitForConnection: async (id) => {
      const account = this.accounts.find((a) => a.id === id)
      if (!account) throw notFound(`Connected account ${id} not found`)
      if (account.status !== 'ACTIVE') throw new Error(`Connected account ${id} is ${account.status}`)
      return this.toAccount(account)
    },
    delete: async (id) => {
      const index = this.accounts.findIndex((a) => a.id === id)
      if (index < 0) throw notFound(`Connected account ${id} not found`)
      this.accounts.splice(index, 1)
      this.pending.delete(id)
      return { success: true }
    }
  }

  readonly tools: ComposioClientLike['tools'] = {
    raw: async (toolkits) => {
      const wanted = toolkits.map((s) => s.toLowerCase())
      const out: ComposioRawTool[] = []
      for (const slug of wanted) {
        for (const tool of this.spec.tools?.[slug.toUpperCase()] ?? []) {
          out.push({
            slug: tool.slug,
            name: tool.name ?? tool.slug,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputParameters ? { inputParameters: tool.inputParameters } : {}),
            ...(tool.version ? { version: tool.version } : {}),
            toolkit: { slug: slug.toLowerCase(), name: this.spec.toolkits.find((t) => t.slug.toLowerCase() === slug)?.name ?? slug }
          })
        }
      }
      return out
    },
    execute: async (slug, body) => {
      const fail = this.findToolSpec(slug)?.failWithError
      if (fail) {
        // l'errore contiene una chiave finta: la pulizia del daemon la toglie
        return { data: {}, error: fail, successful: false }
      }
      const tool = this.findToolSpec(slug)
      if (tool?.version && body.version && body.version !== tool.version) {
        return { data: {}, error: `version mismatch: expected ${tool.version}, got ${body.version}`, successful: false }
      }
      const record: FakeComposioExecution = {
        userId: body.userId ?? '',
        slug,
        ...(body.version ? { version: body.version } : {}),
        arguments: body.arguments ?? {},
        at: Date.now()
      }
      this.executions.push(record)
      if (this.callsLogFile) {
        try { appendFileSync(this.callsLogFile, JSON.stringify(record) + '\n') } catch { /* log best effort */ }
      }
      return { data: { ok: true, tool: slug, arguments: body.arguments ?? {} }, error: null, successful: true }
    }
  }

  /** Completa il login di una richiesta authorize (il test fa l'utente). */
  completeLogin(requestId: string): void {
    const account = this.accounts.find((a) => a.id === requestId)
    if (account) account.status = 'ACTIVE'
    this.pending.delete(requestId)
  }

  /** Un account non più ACTIVE → «da ricollegare» (il test lo usa). */
  expireAccount(id: string): void {
    const account = this.accounts.find((a) => a.id === id)
    if (account) account.status = 'EXPIRED'
  }

  /** Chiude i timer dell'auto-login (fine dei test). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private connectionRequest(id: string): ComposioConnectionRequest {
    const state = {
      id,
      status: 'INITIATED' as const,
      redirectUrl: `https://composio-finta.test/authorize?request=${id}`
    }
    return {
      ...state,
      waitForConnection: (timeout?: number) =>
        this.waitLogin(id, timeout ?? 300_000)
    }
  }

  private waitLogin(id: string, timeout: number): Promise<ComposioConnectedAccount> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = (): void => {
        const account = this.accounts.find((a) => a.id === id)
        if (!account) return reject(notFound(`Connected account ${id} not found`))
        if (account.status === 'ACTIVE') return resolve(this.toAccount(account))
        if (account.status === 'FAILED' || account.status === 'EXPIRED') {
          return reject(new Error(`Connected account ${id} is ${account.status}`))
        }
        if (Date.now() - started > timeout) return reject(new Error(`Connected account ${id} timed out`))
        setTimeout(poll, 50)
      }
      poll()
    })
  }

  private findToolSpec(slug: string): FakeToolSpec | undefined {
    const toolkit = slug.split('_')[0] ?? ''
    return (this.spec.tools?.[toolkit] ?? []).find((t) => t.slug === slug)
  }

  private toAccount(a: FakeAccount): ComposioConnectedAccount {
    return {
      id: a.id,
      status: a.status,
      toolkit: { slug: a.toolkit },
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  }
}
