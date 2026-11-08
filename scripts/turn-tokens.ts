// Fase token (T0.2): la MISURA dei token del turno (caratteri/4, come
// PROMPT_TOKEN_BUDGET: niente tokenizer). Per quattro configurazioni — bot
// normale senza browser, bot normale con browser, turno di gruppo, figlio —
// stampa i token del prompt di sistema, del nucleo, di OGNI gruppo e di OGNI
// tool, usando l'unica fonte assembleTurnTools (turn-tools.ts): ciò che il
// prodotto manda davvero.
//
// Uso: npx tsx scripts/turn-tokens.ts  (o il binario tsx in cache npx)
// Le macro di Lingui non si possono eseguire fuori da vitest: si registra
// l'hook scripts/lib/lingui-macro-hook.mjs e si importano i moduli DOPO.
// I dati del daemon finiscono in una mkdtemp di sistema, mai nel repo.
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// prima l'hook delle macro (db.ts stesso importa ui-messages), poi i dati e i moduli del main
register(new URL('./lib/lingui-macro-hook.mjs', import.meta.url))
const { setDataDir } = await import('../src/main/store/db')
setDataDir(mkdtempSync(join(tmpdir(), 'sandbot-turn-tokens-')))

const { systemPrompt, withLanguage, subagentSystemPrompt } = await import('../src/main/agent/prompts')
const { toolDefs, computerToolDefs } = await import('../src/main/agent/tools')
const { browserToolDefs } = await import('../src/main/agent/browser')
const { toolsForTurnSource } = await import('../src/main/agent/connectors-policy')
const { subagentToolDenyReason } = await import('../src/main/agent/subagents')
const { TOOL_GROUPS } = await import('../src/main/agent/core-tools')
const { assembleTurnTools } = await import('../src/main/agent/turn-tools')
import type { ToolDef } from '../src/main/agent/llm'

/** token stimati di una stringa: caratteri/4, arrotondati per eccesso (come i budget della fase) */
const tok = (s: string): number => Math.ceil(s.length / 4)
const toolTok = (t: ToolDef): number => tok(JSON.stringify(t))

const agent = {
  id: 'agent_x', name: 'SandBot', description: 'Ti tieni la posta in ordine.',
  providerId: 'p', model: 'm', status: 'idle' as const, unread: 0, createdAt: 1
}
const parent = { ...agent, id: 'agent_parent', name: 'Papa' }

interface Config {
  title: string
  /** fase token · scoperta (R7.1): il prompt dipende dai gruppi PRESENTI nel turno, come nel loop */
  prompt: (groups: string[]) => string
  builtins: ToolDef[]
  browserAvailable: boolean
  browserDefs: ToolDef[]
}

/** le quattro configurazioni richieste dalla fase */
function configs(): Config[] {
  // bot normale (turno dell'utente): message_user, tutte le regole del turno
  const userBuiltin = toolsForTurnSource(toolDefs, { source: 'user' })
  // turno di gruppo: send_to_user, niente fill_credential né proposte connettori
  const groupBuiltin = toolsForTurnSource(toolDefs, { source: 'group', groupTurn: {} })
  // figlio: whitelist del sottoagente (il browser del figlio è headless)
  const childBuiltin = toolsForTurnSource(
    toolDefs.filter((t) => subagentToolDenyReason(t.name) === null),
    { source: 'user', subagent: true }
  )
  const childBrowser = [...browserToolDefs, ...computerToolDefs].filter((t) => subagentToolDenyReason(t.name) === null)
  const it = 'it' as const
  // il prompt «con browser» porta le righe del browser in computerSection:
  // il flag di test del MCP finto lo accende, come nell'eval
  const withBrowserPrompt = (groups: string[]): string => {
    const had = process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
    process.env.SANDBOT_TEST_FAKE_BROWSER_MCP ??= 'scripts/fake-browser-mcp.mjs'
    try {
      return withLanguage(systemPrompt(agent, { subagents: true, connectors: true, credentials: true, groups }), it)
    } finally {
      if (had === undefined) delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
      else process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = had
    }
  }
  return [
    {
      title: 'bot normale senza browser',
      prompt: (groups) => withLanguage(systemPrompt(agent, { subagents: true, connectors: true, credentials: true, groups }), it),
      builtins: userBuiltin, browserAvailable: false, browserDefs: []
    },
    {
      title: 'bot normale con browser',
      prompt: withBrowserPrompt,
      builtins: userBuiltin, browserAvailable: true,
      browserDefs: [...browserToolDefs, ...computerToolDefs]
    },
    {
      // fase token · scoperta: teams: true come nel loop (prima lo script
      // misurava il turno di gruppo SENZA la sezione «Teams and groups»)
      title: 'turno di gruppo',
      prompt: (groups) => withLanguage(systemPrompt(agent, { subagents: false, connectors: false, credentials: false, teams: true, groups }), it),
      builtins: groupBuiltin, browserAvailable: false, browserDefs: []
    },
    {
      title: 'figlio (sottoagente)',
      prompt: (groups) => withLanguage(subagentSystemPrompt(parent, { id: 'sub_x', title: 'prova' }, groups), it),
      builtins: childBuiltin, browserAvailable: true, browserDefs: childBrowser
    }
  ]
}

function main(): void {
  const out: string[] = []
  out.push('# turn-tokens — token stimati (caratteri/4) del turno, per configurazione')
  out.push('# fonte: assembleTurnTools (src/main/agent/turn-tools.ts) — la stessa del loop e dell\'eval')
  out.push('# prompt: system prompt del turno SENZA le sezioni dinamiche (memoria, skill, bot principale, connettori),')
  out.push('#         con le righe «quando» dei gruppi PRESENTI nel turno (fase token · scoperta, R7.1)')
  out.push('')
  for (const c of configs()) {
    const r = assembleTurnTools({
      builtins: c.builtins, browserAvailable: c.browserAvailable, browserDefs: c.browserDefs,
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [],
      ...(c.title.startsWith('figlio') ? { subagent: true } : {}),
      ...(c.title.startsWith('turno di gruppo') ? { groupTurn: true } : {})
    })
    const promptT = tok(c.prompt(r.deferredIndex.map((g) => g.id)))
    const toolT = r.tools.reduce((n, t) => n + toolTok(t), 0)
    out.push(`## ${c.title}`)
    out.push(`prompt: ${promptT}`)
    out.push(`tools del turno: ${toolT} (${r.tools.length} tool)`)
    out.push(`totale prompt+tools: ${promptT + toolT}`)
    out.push('per tool:')
    for (const t of r.tools) out.push(`  ${t.name}: ${toolTok(t)}`)
    out.push('gruppi (TOOL_GROUPS, tool verso il modello):')
    for (const g of r.deferredIndex) {
      out.push(`  ${g.id}: ${g.tools.reduce((n, t) => n + toolTok(t), 0)} (${g.tools.length} tool)`)
    }
    void TOOL_GROUPS
    out.push('')
  }
  console.log(out.join('\n'))
}

main()
