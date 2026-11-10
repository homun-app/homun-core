// RW (fase revisore sulla richiesta, punto 3): le cadute di connessione MCP.
// Ogni errore di trasporto finisce nel log del daemon (server, strumento,
// millisecondi, messaggio — MAI gli argomenti); se la chiamata era una
// LETTURA si riconnette e si ripete UNA volta da sole, coperte
// dall'approvazione già data; le scritture non si ripetono mai. Tutto PURO
// con dipendenze iniettate (il client MCP finto chiude la prima volta).
import { describe, expect, it } from 'vitest'
import { callMcpWithRetry } from '../retry'

/** un client MCP finto: le prime `fails` chiamate chiudono la connessione */
function fakeClient(fails: number) {
  const calls: Array<{ reconnect: boolean }> = []
  let failed = 0
  return {
    calls,
    attempt: async (reconnect: boolean): Promise<string> => {
      calls.push({ reconnect })
      if (failed < fails) {
        failed++
        throw new Error('MCP error -32000: Connection closed')
      }
      return '{"ok":true}'
    }
  }
}

describe('RW3: callMcpWithRetry — log, ritentativa delle letture, mai delle scritture', () => {
  it('LETTURA: prima chiamata chiusa → UNA riga di log, riconnessione e ripetizione riuscita', async () => {
    const client = fakeClient(1)
    const lines: string[] = []
    const now = { t: 1_000 }
    const out = await callMcpWithRetry({
      server: 'composio', tool: 'COMPOSIO_SEARCH_TOOLS', isRead: true,
      attempt: client.attempt,
      log: (l) => lines.push(l),
      now: () => (now.t += 250)
    })
    expect(out).toBe('{"ok":true}')
    // una sola riga di log: server, strumento, millisecondi, messaggio
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('server=composio')
    expect(lines[0]).toContain('tool=COMPOSIO_SEARCH_TOOLS')
    expect(lines[0]).toContain('ms=250')
    expect(lines[0]).toContain('Connection closed')
    // due tentativi: il secondo DOPO la riconnessione
    expect(client.calls).toEqual([{ reconnect: false }, { reconnect: true }])
  })

  it('SCRITTURA: mai ripetuta — l\'errore va al modello come oggi', async () => {
    const client = fakeClient(1)
    const lines: string[] = []
    await expect(callMcpWithRetry({
      server: 'composio', tool: 'TRELLO_CREATE_CARD', isRead: false,
      attempt: client.attempt,
      log: (l) => lines.push(l),
      now: () => 5_000
    })).rejects.toThrow('Connection closed')
    expect(client.calls).toEqual([{ reconnect: false }])
    expect(lines).toHaveLength(1)
  })

  it('gli ARGOMENTI non finiscono mai nel log (solo il messaggio dell\'errore)', async () => {
    const lines: string[] = []
    await callMcpWithRetry({
      server: 's', tool: 'T', isRead: false,
      attempt: async () => { throw new Error('boom con {"token":"sekret_xyz"}') },
      log: (l) => lines.push(l),
      now: () => 1
    }).catch(() => undefined)
    expect(lines[0]).toContain('boom')
    // il log non porta gli argomenti della chiamata: la riga è fissa nei campi
    expect(lines[0].match(/=/g)?.length).toBe(4)
  })

  it('retryWhen:false (es. token scaduto) non ripete nemmeno le letture', async () => {
    const client = fakeClient(1)
    await expect(callMcpWithRetry({
      server: 'composio', tool: 'COMPOSIO_SEARCH_TOOLS', isRead: true,
      attempt: client.attempt,
      retryWhen: () => false,
      log: () => undefined,
      now: () => 1
    })).rejects.toThrow('Connection closed')
    expect(client.calls).toEqual([{ reconnect: false }])
  })
})
