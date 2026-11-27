// Q4 (fase squadra): guardia del rendering della timeline — TeamChat fonde i
// messaggi con le card di approvazione per tempo e renderizza le righe relay
// («Treni → Alloggio: …») e le card artifact (documento: apri a lato / file:
// si apre qui). Le regole «non sveglia nessuno» sono nei test dello store.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(fileURLToPath(new URL('../components/TeamChat.tsx', import.meta.url)), 'utf8')

describe('Q4: la timeline della squadra nel renderer (guardie sul sorgente)', () => {
  it('le righe relay e artifact si renderizzano, con i loro testid', () => {
    expect(SRC).toContain("m.authorKind === 'relay'")
    expect(SRC).toContain("m.authorKind === 'artifact'")
    expect(SRC).toContain('data-testid="relay-row"')
    expect(SRC).toContain('data-testid="artifact-card"')
  })

  it('la timeline FONDE messaggi e card di approvazione per tempo (il punto in cui sono nate)', () => {
    expect(SRC).toContain('for (const c of groupCards)')
    expect(SRC).toContain('rows.sort((a, b) => a.at - b.at)')
  })

  it('la card inline offre «Consenti una volta»/«Rifiuta» e usa la resolveApproval di oggi', () => {
    expect(SRC).toContain('data-testid="timeline-approval"')
    expect(SRC).toContain('resolveGroupApproval(c.agentId, c.approvalId')
  })

  it('K3, difetto (f): la card di approvazione della timeline è marcata come RIGA (role="listitem", dentro la lista role="list" della timeline): due approvazioni con gli stessi bottoni non sono doppioni per la regola R2 della galleria', () => {
    expect(SRC).toMatch(/<div[^>]*role="listitem"[^>]*data-testid="timeline-approval"|<div[^>]*data-testid="timeline-approval"[^>]*role="listitem"/)
    expect(SRC).toContain('role="list"')
  })

  it('il documento apre la pagina a lato (openPage dalla Libreria), il file si apre qui', () => {
    expect(SRC).toContain("openPage(p.id!, 'library')")
    expect(SRC).toContain('api.filesRead(')
  })
})
