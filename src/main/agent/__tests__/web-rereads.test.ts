// Fase chat-limiti (CL4): niente più letture a vuoto. Un offset OLTRE la
// fine della pagina dà un testo CHIARO (la pagina è finita), mai un
// segmento vuoto; la lettura IDENTICA nello stesso turno (stesso url finale
// e stesso offset) si risponde dalla cache del turno con una riga davanti,
// senza nessuna rete; un offset diverso invece legge davvero.
import { describe, expect, it } from 'vitest'
import { webFetchWindowOutput, TurnWebReads, ALREADY_READ_PREFIX } from '../web-tools'

describe('CL4: offset oltre la fine → la pagina è FINITA, testo chiaro (mai un segmento vuoto)', () => {
  it('offset ≥ lunghezza: il messaggio dice quanti caratteri ha la pagina e che oltre quell\'offset non c\'è niente', () => {
    const out = webFetchWindowOutput('x'.repeat(404), 1600)
    expect(out).toContain('[the page ended: 404 characters in total')
    expect(out).toContain('no segment past offset 1600')
    // NESSUN segmento vuoto: non c'è la riga di segmento, solo l'avviso
    expect(out).not.toContain('[segment from offset 1600')
    expect(out.trim()).toBe(out.trim().replace(/\s+$/, ''))
  })

  it('offset esattamente alla fine (N): anche quello è «finita»', () => {
    const out = webFetchWindowOutput('0123456789', 10)
    expect(out).toContain('[the page ended: 10 characters in total')
    expect(out).not.toContain('segment from offset 10')
  })

  it('GUARDIA: offset DENTRO la pagina resta come oggi (segmento con testa e coda)', () => {
    expect(webFetchWindowOutput('0123456789', 5)).toBe('[segment from offset 5 of 10 characters]\n56789')
    expect(webFetchWindowOutput('corto', undefined)).toBe('corto')
  })
})

describe('CL4: la lettura identica nello stesso turno NON fa rete (cache del turno)', () => {
  it('stesso url e stesso offset → hit dalla cache del turno, il fetch NON si chiama', async () => {
    const reads = new TurnWebReads()
    let fetches = 0
    const fetchOnce = async (): Promise<string> => {
      fetches++
      return 'contenuto letto'
    }
    // prima lettura: miss → fetch → remember
    expect(reads.lookup('https://annunci.example.it/lista', 0)).toBeNull()
    const output = await fetchOnce()
    reads.remember('https://annunci.example.it/lista', 0, { output, finalUrl: 'https://annunci.example.it/lista' })
    // seconda lettura IDENTICA: hit, nessun nuovo fetch
    const hit = reads.lookup('https://annunci.example.it/lista', 0)
    expect(hit).not.toBeNull()
    expect(hit?.output).toBe('contenuto letto')
    expect(fetches).toBe(1)
    // la riga che il loop mette davanti
    expect(`${ALREADY_READ_PREFIX}\n${hit?.output}`).toContain('already read in this turn: same content')
  })

  it('un offset DIVERSO invece legge di nuovo (miss)', () => {
    const reads = new TurnWebReads()
    reads.remember('https://annunci.example.it/lista', 0, { output: 'primo', finalUrl: 'https://annunci.example.it/lista' })
    expect(reads.lookup('https://annunci.example.it/lista', 1600)).toBeNull()
  })

  it('la cache registra anche l\'url FINALE: rileggere quello (dopo un redirect) è comunque un hit', () => {
    const reads = new TurnWebReads()
    reads.remember('https://esempio.it/vecchio', 0, { output: 'via redirect', finalUrl: 'https://annunci.example.it/final' })
    expect(reads.lookup('https://annunci.example.it/final', 0)?.output).toBe('via redirect')
  })
})
