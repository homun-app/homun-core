// E1 (fase mcp-env): il form stdio della finestra «Server MCP» con la
// sezione «Variabili» — righe nome = valore, interruttore «segreto» (acceso
// di default se il nome contiene TOKEN/KEY/SECRET/PASSWORD/AUTH), i segreti
// salvati CIFRATI (input password, in modifica si sostituiscono non si
// leggono), l'elenco mostra i nomi e •••• mai i valori.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { envRowsFromServer, saveEnvPayload, newEnvRow } from '../lib/mcp-env'

const WIN_SRC = readFileSync(fileURLToPath(new URL('../components/plugin/manual-servers.tsx', import.meta.url)), 'utf8')

describe('E1: il modello delle righe Variabili del form stdio', () => {
  it('envRowsFromServer: i non segreti portano il valore, i segreti restano vuoti (si sostituiscono)', () => {
    const rows = envRowsFromServer({
      envSpec: [
        { name: 'MATTERMOST_URL', secret: false },
        { name: 'MATTERMOST_TOKEN', secret: true }
      ],
      envValues: { MATTERMOST_URL: 'https://mm.example', MATTERMOST_TOKEN: 'mai-qui' }
    })
    expect(rows).toEqual([
      { name: 'MATTERMOST_URL', value: 'https://mm.example', secret: false, saved: false },
      { name: 'MATTERMOST_TOKEN', value: '', secret: true, saved: true }
    ])
  })

  it(String.raw`saveEnvPayload: i valori segreti digitati vanno nel cassetto cifrato, gli altri nella config`, () => {
    const p = saveEnvPayload([
      { name: 'MATTERMOST_URL', value: 'https://mm.example', secret: false, saved: false },
      { name: 'MATTERMOST_TOKEN', value: 'tok-nuovo', secret: true, saved: true },
      { name: 'MATTERMOST_EMPTY', value: '', secret: true, saved: true }
    ])
    expect(p.envSpec).toEqual([
      { name: 'MATTERMOST_URL', secret: false },
      { name: 'MATTERMOST_TOKEN', secret: true },
      { name: 'MATTERMOST_EMPTY', secret: true }
    ])
    expect(p.envValues).toEqual({ MATTERMOST_URL: 'https://mm.example' })
    expect(p.envSecrets).toEqual({ MATTERMOST_TOKEN: 'tok-nuovo' })
  })

  it('le righe senza nome non producono niente (riga vuota ignorata)', () => {
    const p = saveEnvPayload([newEnvRow(), { name: 'A', value: 'a', secret: false, saved: false }])
    expect(p.envSpec).toEqual([{ name: 'A', secret: false }])
    expect(p.envValues).toEqual({ A: 'a' })
    expect(p.envSecrets).toEqual({})
  })
})

describe('E1: il wiring del form (guardia sul sorgente di McpWindow.tsx)', () => {
  it(String.raw`la sezione «Variabili» c'è, con righe nome = valore e aggiungi/togli`, () => {
    expect(WIN_SRC).toContain('Variabili')
    expect(WIN_SRC).toMatch(/data-testid="mcp-env-rows"/)
    expect(WIN_SRC).toMatch(/data-testid="mcp-env-add"/)
    expect(WIN_SRC).toMatch(/data-testid="mcp-env-remove"/)
  })

  it('l\'interruttore segreto e i valori segreti si digitano in un input password', () => {
    expect(WIN_SRC).toMatch(/data-testid="mcp-env-secret"/)
    expect(WIN_SRC).toMatch(/type="password"/)
    expect(WIN_SRC).toMatch(/envNameLooksSecret/)
  })

  it('il salvataggio manda i SEGRETI nel parametro cifrato (secret.env), mai nella config', () => {
    expect(WIN_SRC, 'il secret porta { env: <solo segreti> }').toMatch(/\{ env: env\.envSecrets \}/)
    expect(WIN_SRC, 'la dichiarazione e i valori non segreti vanno nella config').toMatch(/envSpec: env\.envSpec, envValues: env\.envValues/)
    expect(WIN_SRC, 'mai i segreti dentro envValues').not.toMatch(/envValues:\s*\{[^}]*envSecrets/)
  })

  it('l\'elenco dei server mostra i NOMI delle variabili e i segreti come ••••, mai i valori', () => {
    expect(WIN_SRC).toMatch(/••••/)
    expect(WIN_SRC).toMatch(/envSpec/)
  })
})
