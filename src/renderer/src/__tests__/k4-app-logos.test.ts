// K4 (fase team-bot): il logo VERO delle app nelle righe dei connettori,
// ovunque compaiano. La finestra «Collega app» e le card della chat lo
// fanno già (catalogLogoUrl/logoUrlForSlug); qui entrano anche le righe dei
// server della finestra «Server MCP» (per nome: «Mattermost» → il suo SVG)
// e le testate dell'importazione (Gemini CLI → gemini.svg). Solo se il file
// MANCA resta l'iniziale nel quadrato tenue di oggi. Il foglio del server
// (nome, o il publisher del registro) era morto da PL7: la fase linguaggio
// (C0) lo ha cancellato con i suoi test.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const LOGOS_SRC = read('../lib/app-logos.ts')
const WIN_SRC = read('../components/plugin/manual-servers.tsx') + read('../components/plugin/import-list.tsx')

// il modulo vive su import.meta.glob (vite): nei test node la mappa è vuota
// ma le FUNZIONI PURE restano verificabili — il matching UI è nelle guardie
const { logoStemForName } = await import('../lib/app-logos')

describe('K4: la funzione pura del matching nome → file del logo', () => {
  it('«Mattermost» → mattermost, «DeepWiki MCP» → deepwiki_mcp, spazi e maiuscole non contano', () => {
    expect(logoStemForName('Mattermost')).toBe('mattermost')
    expect(logoStemForName('DeepWiki MCP')).toBe('deepwiki_mcp')
    expect(logoStemForName('  Gmail ')).toBe('gmail')
    expect(logoStemForName('')).toBe('')
  })
})

describe('K4: la riga del server usa il logo quando c\'è (finestra «Server MCP»)', () => {
  it('la riga mcp-server-row chiama logoUrlForName col nome del server e rende una <img> col suo testid', () => {
    expect(LOGOS_SRC).toMatch(/export function logoUrlForName/)
    expect(WIN_SRC).toMatch(/logoUrlForName\(s\.name\)/)
    expect(WIN_SRC).toMatch(/data-testid="mcp-server-logo"/)
    expect(WIN_SRC).toMatch(/<img[^>]*mcp-server-logo|data-testid="mcp-server-logo"/)
  })
})

describe("K4: le testate dell'importazione usano il logo quando il file c'è", () => {
  it("la mappa fonte → logo esiste e Gemini CLI punta a gemini (l'unica con file nel repo)", () => {
    expect(WIN_SRC).toMatch(/SOURCE_LOGO/)
    expect(WIN_SRC).toMatch(/gemini:\s*'gemini'/)
  })
})
