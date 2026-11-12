// CA2 (fase composio-account): la finestra App mostra gli ACCOUNT di
// un'app Composio collegata — alias in grassetto, email in grigio, stato
// («Da ricollegare» per i non attivi), «Rinomina» e «Togli» per ognuno e
// «Aggiungi un altro account» sotto. Qui le funzioni PURE del modello di
// vista: le righe degli account e il messaggio del LIMITE in parole semplici.
import { describe, expect, it } from 'vitest'
import {
  gatewayAccountRows, accountLimitMessage, accountLabelOf
} from '../apps-view'
import type { ComposioGatewayAppInfo } from '../../../../shared/types'

const app = (accounts: ComposioGatewayAppInfo['accounts']): ComposioGatewayAppInfo => ({
  slug: 'gmail',
  name: 'Gmail',
  status: 'ACTIVE',
  accountId: accounts?.[0]?.accountId ?? null,
  accounts
})

describe('CA2: gatewayAccountRows — le righe degli account di un\'app collegata', () => {
  it('alias in evidenza, email accanto, «Da ricollegare» per i non attivi (solo IT qui: le frasi vivono nei cataloghi Lingui)', () => {
    const rows = gatewayAccountRows(app([
      { accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE' },
      { accountId: 'a2', alias: 'personale', email: 'fabio@gmail.test', status: 'RECONNECT' }
    ]))
    expect(rows).toEqual([
      { key: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', reconnect: false },
      { key: 'a2', alias: 'personale', email: 'fabio@gmail.test', reconnect: true }
    ])
  })

  it('senza alias l\'email (o la parte locale) fa da etichetta; MAI l\'id tecnico', () => {
    const rows = gatewayAccountRows(app([
      { accountId: 'acc_9', email: 'utente@example.com', status: 'ACTIVE' }
    ]))
    expect(rows[0]?.alias).toBe('utente@example.com')
    // nessun alias e nessuna email: «account N», mai l'id
    const bare = gatewayAccountRows(app([{ accountId: 'coup_hurricane', status: 'ACTIVE' }]))
    expect(bare[0]?.alias).toBe('account 1')
  })

  it('app senza account (dati vecchi o chiave di progetto): nessuna riga', () => {
    expect(gatewayAccountRows(app(undefined))).toEqual([])
    expect(gatewayAccountRows(app([]))).toEqual([])
  })
})

describe('CA2: accountLimitMessage — il limite in parole semplici', () => {
  it('IT: «Hai già 5 account Gmail: togline uno per aggiungerne un altro»', () => {
    expect(accountLimitMessage(5, 'Gmail', 'it')).toBe('Hai già 5 account Gmail: togline uno per aggiungerne un altro.')
  })

  it('EN: la stessa frase in inglese', () => {
    expect(accountLimitMessage(5, 'Gmail', 'en')).toBe('You already have 5 Gmail accounts: remove one to add another.')
  })
})

describe('CA2/CA3: accountLabelOf — l\'etichetta dell\'account usato da una card', () => {
  const accounts = [
    { accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE' as const },
    { accountId: 'coup_x', alias: 'personale', email: 'fabio@gmail.test', status: 'ACTIVE' as const }
  ]

  it('per ALIAS o per ID: «lavoro (fabio@azienda.test)»', () => {
    expect(accountLabelOf(accounts, 'lavoro')).toBe('lavoro (fabio@azienda.test)')
    expect(accountLabelOf(accounts, 'coup_x')).toBe('personale (fabio@gmail.test)')
  })

  it('sconosciuto o vuoto: l\'account COM\'È (alias o id del modello), nessuna invenzione', () => {
    expect(accountLabelOf(accounts, 'altro')).toBe('altro')
    expect(accountLabelOf(accounts, '')).toBe('')
    expect(accountLabelOf([], 'lavoro')).toBe('lavoro')
  })
})
