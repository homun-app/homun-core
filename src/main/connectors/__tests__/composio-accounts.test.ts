// CA1 (fase composio-account): lo stato del gateway passa a PIÙ ACCOUNT per
// app — `{ [slug]: { name, accounts: […] } }` — con una migrazione PURA e
// IDEMPOTENTE dal formato vecchio (un account per app). Qui le funzioni pure:
// migrazione, normalizzazione degli alias (minuscole, senza spazi, unici nel
// toolkit) e l'alias predefinito (parte locale dell'email, altrimenti
// «account 2», «account 3»).
import { describe, expect, it } from 'vitest'
import {
  assignDefaultAliases, defaultAliasFor, normalizeAlias, uniqueAlias,
  gatewayAppStatusOf, type GatewayAccount, type GatewayAppStored
} from '../composio-accounts'

const account = (over: Partial<GatewayAccount> = {}): GatewayAccount => ({
  accountId: 'acc_1',
  status: 'ACTIVE',
  connectedAt: 1_000,
  ...over
})

describe('CA1: normalizeGatewayApps — la migrazione dal formato vecchio, pura e idempotente', () => {
  it('il formato VECCHIO (un account piatto) diventa accounts: [un account]', async () => {
    const { normalizeGatewayApps } = await import('../composio-accounts')
    const out = normalizeGatewayApps({
      gmail: { name: 'Gmail', accountId: 'gmail_aaa', status: 'ACTIVE', connectedAt: 42, email: 'utente@example.com' },
      slack: { name: 'Slack', accountId: null, status: 'FAILED', connectedAt: 43 }
    })
    expect(out.gmail).toEqual({
      name: 'Gmail',
      accounts: [{ accountId: 'gmail_aaa', status: 'ACTIVE', connectedAt: 42, email: 'utente@example.com' }]
    })
    // la riga FALLITA senza account resta: un account senza id, stato FAILED
    expect(out.slack).toEqual({
      name: 'Slack',
      accounts: [{ accountId: null, status: 'FAILED', connectedAt: 43 }]
    })
  })

  it('il formato NUOVO passa invariato (idempotente: migrare due volte non cambia nulla)', async () => {
    const { normalizeGatewayApps } = await import('../composio-accounts')
    const stored = {
      gmail: {
        name: 'Gmail',
        accounts: [
          { accountId: 'a1', alias: 'lavoro', email: 'f@azienda.test', status: 'ACTIVE', connectedAt: 1, isDefault: true },
          { accountId: 'a2', alias: 'personale', status: 'RECONNECT', connectedAt: 2 }
        ]
      }
    }
    expect(normalizeGatewayApps(normalizeGatewayApps(stored))).toEqual(stored)
  })

  it('input non oggetto o voci rotte → oggetto vuoto / riga vuota, mai un\'eccezione', async () => {
    const { normalizeGatewayApps } = await import('../composio-accounts')
    expect(normalizeGatewayApps(undefined)).toEqual({})
    expect(normalizeGatewayApps(null)).toEqual({})
    expect(normalizeGatewayApps('x')).toEqual({})
    // il nome mancante si sostituisce con lo slug (la riga non si perde)
    expect(normalizeGatewayApps({ gmail: { accounts: [account()] } }).gmail.name).toBe('gmail')
    expect(normalizeGatewayApps({ gmail: {} }).gmail).toEqual({ name: 'gmail', accounts: [] })
  })
})

describe('CA1: gli alias — minuscole, senza spazi, unici nel toolkit', () => {
  it('normalizeAlias: minuscolo e senza spazi (dentro e ai bordi)', () => {
    expect(normalizeAlias('  Lavoro ')).toBe('lavoro')
    expect(normalizeAlias('Casa Personale')).toBe('casapersonale')
    expect(normalizeAlias('Fabio Gmail')).toBe('fabiogmail')
  })

  it('uniqueAlias: un alias già preso diventa univoco col suffisso -2, -3…', () => {
    expect(uniqueAlias('lavoro', new Set(['lavoro']))).toBe('lavoro-2')
    expect(uniqueAlias('lavoro', new Set(['lavoro', 'lavoro-2']))).toBe('lavoro-3')
    expect(uniqueAlias('personale', new Set(['lavoro']))).toBe('personale')
  })

  it('defaultAliasFor: la parte locale dell\'email; senza email «account N» (dal secondo)', () => {
    expect(defaultAliasFor('fabio@azienda.test', 2)).toBe('fabio')
    // il PRIMO account senza email resta senza alias; dal secondo «account N»
    expect(defaultAliasFor(undefined, 1)).toBe('')
    expect(defaultAliasFor(undefined, 2)).toBe('account 2')
    expect(defaultAliasFor(undefined, 3)).toBe('account 3')
    // l'email senza parte locale non inventa nulla
    expect(defaultAliasFor('@azienda.test', 2)).toBe('account 2')
  })
})

describe('CA1: assignDefaultAliases — l\'alias predefinito agli account senza alias', () => {
  it('la parte locale dell\'email appena nota; «account N» per gli altri; mai due alias uguali', () => {
    const out = assignDefaultAliases([
      account({ accountId: 'a1', email: 'fabio@azienda.test' }),
      account({ accountId: 'a2', email: 'fabio@gmail.test' }),
      account({ accountId: 'a3' })
    ])
    expect(out.map((a) => a.alias)).toEqual(['fabio', 'fabio-2', 'account 3'])
    // il primo account SENZA email non prende alias; il secondo sì
    const due = assignDefaultAliases([account({ accountId: 'a1' }), account({ accountId: 'a2' })])
    expect(due.map((a) => a.alias)).toEqual([undefined, 'account 2'])
  })

  it('gli alias GIÀ presenti non si toccano (il rename dell\'utente resta)', () => {
    const out = assignDefaultAliases([
      account({ accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test' }),
      account({ accountId: 'a2', email: 'fabio@azienda.test' })
    ])
    expect(out.map((a) => a.alias)).toEqual(['lavoro', 'fabio'])
  })
})

describe('CA1: gatewayAppStatusOf — lo stato dell\'APP dai suoi account', () => {
  const app = (accounts: GatewayAccount[]): GatewayAppStored => ({ name: 'Gmail', accounts })

  it('any ACTIVE → ACTIVE; altrimenti RECONNECT se c\'è da ricollegare, FAILED se tutto fallito', () => {
    expect(gatewayAppStatusOf(app([account({ status: 'RECONNECT' }), account({ status: 'ACTIVE' })]))).toBe('ACTIVE')
    expect(gatewayAppStatusOf(app([account({ status: 'RECONNECT' })]))).toBe('RECONNECT')
    expect(gatewayAppStatusOf(app([account({ status: 'FAILED' })]))).toBe('FAILED')
    expect(gatewayAppStatusOf(app([account({ status: 'FAILED' }), account({ status: 'RECONNECT' })]))).toBe('RECONNECT')
    expect(gatewayAppStatusOf(app([]))).toBe('FAILED')
  })
})
