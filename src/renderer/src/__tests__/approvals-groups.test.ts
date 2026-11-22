// U7 (fase prima-release): la pagina Approvazioni raggruppa i consensi per
// BOT (nome e mascotte) col gruppo «Tutti i bot» per le righe NULL; la parola
// dei comandi in monospazio e il tipo in chiaro. Il raggruppamento e il tipo
// sono PURI (lib/approval-app); la pagina li usa (guardie sul sorgente).
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { groupGrantsByBot, grantKindOf, type GrantLike } from '../lib/approval-app'

const PAGE = readFileSync(fileURLToPath(new URL('../components/settings/ApprovalsPage.tsx', import.meta.url)), 'utf8')
const CARD = readFileSync(fileURLToPath(new URL('../components/ApprovalCard.tsx', import.meta.url)), 'utf8')

const g = (id: number, tool: string, target: string, agentId: string | null): GrantLike =>
  ({ id, tool, target, createdAt: id, scope: null, expiresAt: null, agentId })

describe('U7: groupGrantsByBot (pura)', () => {
  it("un gruppo per bot, nell'ordine in cui compaiono; «Tutti i bot» (NULL) per ULTIMO", () => {
    const groups = groupGrantsByBot([
      g(1, 'run-command', 'curl', null),
      g(2, 'run-command', 'curl', 'bot-a'),
      g(3, 'use-app', 'app:Posta', 'bot-b'),
      g(4, 'run-command', 'grep', 'bot-a')
    ])
    expect(groups.map((x) => x.agentId)).toEqual(['bot-a', 'bot-b', null])
    expect(groups[0]!.grants.map((x) => x.id)).toEqual([2, 4])
    expect(groups[2]!.grants.map((x) => x.id)).toEqual([1])
  })

  it("una riga per concessione: i doppioni non esistono più (l'indice unico del DB), e il gruppo è la fonte unica", () => {
    const groups = groupGrantsByBot([g(7, 'run-command', 'head', 'bot-a')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.grants).toHaveLength(1)
  })
})

describe('U7: grantKindOf (pura) — il tipo in chiaro', () => {
  it('comando, app, strumento', () => {
    expect(grantKindOf('run-command')).toBe('comando')
    expect(grantKindOf('use-app')).toBe('app')
    expect(grantKindOf('write-file')).toBe('strumento')
    expect(grantKindOf('mcp__gmail__send')).toBe('strumento')
  })
})

describe('U7: la pagina e la card (guarda sul sorgente)', () => {
  it('la pagina raggruppa con groupGrantsByBot, col gruppo «Tutti i bot» e la mascotte', () => {
    expect(PAGE).toContain('groupGrantsByBot')
    expect(PAGE).toContain('Tutti i bot')
    expect(PAGE).toContain('<Bot ')
    expect(PAGE).toContain('grantKindLabelOf')
  })

  it('per i comandi la PAROLA in monospazio (non tool · target)', () => {
    expect(PAGE).toMatch(/tool === 'run-command'[\s\S]{0,120}<code[^>]*>\{g\.target\}<\/code>/)
  })

  it("la card dice «Consenti sempre a <bot>» (per un aiutante: il bot che l'ha lanciato)", () => {
    // A1 (fase approvazioni-chiare): l'etichetta vive nel t`…` del modello unico
    expect(CARD).toMatch(/Consenti sempre a \$\{agentName\}/)
    expect(CARD).not.toMatch(/<Trans>Sempre<\/Trans>/)
  })
})
