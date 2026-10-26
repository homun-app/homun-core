// Test dello store cifrato dei segreti dei connettori (fase 5): envelope
// AES-256-GCM come il vault, NESSUN valore in chiaro nei settings, chiave
// richiesta a ogni operazione (nel daemon arriva dal Keychain).
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createConnectorsSecretStore } from '../sealed-store'

function makeEnv() {
  const settings = new Map<string, unknown>()
  const key = randomBytes(32)
  let keyReads = 0
  const store = createConnectorsSecretStore({
    getKey: async () => {
      keyReads++
      return key
    },
    getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
    setSetting: (k: string, v: unknown) => settings.set(k, v)
  })
  return { settings, key, keyReads: () => keyReads, store }
}

describe('store cifrato per server MCP', () => {
  it('write → settings contengono SOLO envelope sandVault, mai il valore in chiaro', async () => {
    const { settings, store } = makeEnv()
    await store.write('srv1', 'bearer', 'TOKEN-SEGRETTO-123')
    const raw = JSON.stringify([...settings.values()])
    expect(raw).not.toContain('TOKEN-SEGRETTO-123')
    expect(raw).toContain('sandVault')
    // roundtrip
    expect(await store.read<string>('srv1', 'bearer')).toBe('TOKEN-SEGRETTO-123')
  })

  it('i campi sono indipendenti: aggiornare i token non tocca il client', async () => {
    const { store } = makeEnv()
    await store.write('srv1', 'oauth.client', { client_id: 'abc' })
    await store.write('srv1', 'oauth.tokens', { access_token: 'A1' })
    await store.write('srv1', 'oauth.tokens', { access_token: 'A2' })
    expect(await store.read<Record<string, string>>('srv1', 'oauth.tokens')).toEqual({ access_token: 'A2' })
    expect(await store.read<Record<string, string>>('srv1', 'oauth.client')).toEqual({ client_id: 'abc' })
  })

  it('una chiave diversa non decifra (auth tag GCM)', async () => {
    const { settings } = makeEnv()
    const key2 = randomBytes(32)
    const store2 = createConnectorsSecretStore({
      getKey: async () => key2,
      getSetting: <T>(k: string, fb: T): T => (settings.has(k) ? (settings.get(k) as T) : fb),
      setSetting: () => undefined
    })
    settings.set('connectors.secrets', {
      srv1: { bearer: { sandVault: 1, data: Buffer.concat([randomBytes(12), randomBytes(16), randomBytes(32)]).toString('base64') } }
    })
    await expect(store2.read('srv1', 'bearer')).rejects.toThrow()
  })

  it('remove campi singoli e removeAll del server', async () => {
    const { settings, store } = makeEnv()
    await store.write('srv1', 'oauth.tokens', { access_token: 'A' })
    await store.write('srv1', 'oauth.client', { client_id: 'c' })
    await store.write('srv2', 'bearer', 'B')
    await store.remove('srv1', ['oauth.tokens'])
    expect(await store.read('srv1', 'oauth.tokens')).toBeUndefined()
    expect(await store.read('srv1', 'oauth.client')).toBeDefined()
    await store.remove('srv1', ['oauth.client'])
    // nessuna voce vuota per srv1
    expect(JSON.stringify([...settings.values()])).not.toContain('srv1')
    expect(await store.read('srv2', 'bearer')).toBe('B')
    await store.removeAll('srv2')
    expect(await store.read('srv2', 'bearer')).toBeUndefined()
  })
})
