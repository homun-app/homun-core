// Test della chiave Keychain dei connettori (fase 5): la chiave NON compare
// mai nell'argv del comando `security` (i comandi partono da stdin con -i),
// la lettura usa find-generic-password -w, e la creazione è idempotente.
// FASE RILASCIO — CORREZIONI (K1): getConnectorsKey passa da master-keys
// (keys.json + safeStorage, provato in master-keys.test.ts); qui si prova
// DIRETTAMENTE getKeychainKey, la via storica del runner `security` che
// resta per la lettura/migrazione delle voci vecchie.
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getKeychainKey, CONNECTORS_SERVICE, type SecurityRunner } from '../keychain'

/** Runner finto: registra ogni argv e stdin; risponde come il Keychain. */
function fakeSecurity(): { run: SecurityRunner; argvs: string[][]; stdins: string[]; store: Map<string, string> } {
  const argvs: string[][] = []
  const stdins: string[] = []
  const store = new Map<string, string>() // "account|service" → valore
  const run: SecurityRunner = async (args, input) => {
    argvs.push(args)
    if (input !== undefined) stdins.push(input)
    if (args[0] === 'find-generic-password') {
      const key = `${args[args.indexOf('-a') + 1]}|${args[args.indexOf('-s') + 1]}`
      const v = store.get(key)
      return v ? { out: v + '\n', err: '', code: 0 } : { out: '', err: 'not found', code: 1 }
    }
    if (args[0] === '-i') {
      // modalità interattiva: un comando per riga dallo stdin
      for (const line of (input ?? '').split('\n')) {
        if (!line.trim() || line.trim() === 'quit') continue
        const m = line.match(/add-generic-password -a (\S+) -s (\S+) -w (\S+)(?: -U)?/)
        if (m) store.set(`${m[1]}|${m[2]}`, m[3]!)
      }
      return { out: '', err: '', code: 0 }
    }
    return { out: '', err: 'comando non supportato', code: 1 }
  }
  return { run, argvs, stdins, store }
}

describe('chiave AES dei connettori nel Keychain', () => {
  it('prima occorrenza: genera 32 byte, li scrive via `security -i` (stdin) e NON nell\'argv', async () => {
    const f = fakeSecurity()
    const key = await getKeychainKey(CONNECTORS_SERVICE, f.run)
    expect(key).toHaveLength(32)
    // la scrittura passa da stdin di `security -i`
    expect(f.argvs.some((a) => a[0] === '-i')).toBe(true)
    expect(f.stdins.some((s) => s.includes('add-generic-password') && s.includes(key.toString('base64')))).toBe(true)
    // la chiave NON è mai nell'argv di nessun comando (visibile a `ps`)
    for (const argv of f.argvs) {
      expect(argv.join(' ')).not.toContain(key.toString('base64'))
      expect(argv.join(' ')).not.toContain(key.toString('hex'))
    }
  })

  it('voce esistente: si legge con find-generic-password -w (valore sullo stdout, mai in argv)', async () => {
    const f = fakeSecurity()
    const existing = randomBytes(32)
    f.store.set('sandbot|sandbot-connectors-key', existing.toString('base64'))
    const key = await getKeychainKey(CONNECTORS_SERVICE, f.run)
    expect(key.equals(existing)).toBe(true)
    expect(f.argvs[0]).toEqual(['find-generic-password', '-a', 'sandbot', '-s', 'sandbot-connectors-key', '-w'])
    expect(f.argvs.length).toBe(1) // nessuna scrittura
  })

  it('scrittura che perde una gara: rilegge la chiave creata concorrentemente', async () => {
    const existing = randomBytes(32)
    const raced = randomBytes(32)
    let written = false
    const run: SecurityRunner = async (args, input) => {
      if (args[0] === 'find-generic-password') {
        return written
          ? { out: raced.toString('base64') + '\n', err: '', code: 0 }
          : { out: '', err: 'not found', code: 1 }
      }
      if (args[0] === '-i' && input?.includes('add-generic-password')) {
        written = true // un altro processo ha scritto per primo
        return { out: '', err: 'already exists', code: 1 }
      }
      return { out: '', err: '', code: 1 }
    }
    const key = await getKeychainKey(CONNECTORS_SERVICE, run)
    expect(key.equals(raced)).toBe(true)
  })
})
