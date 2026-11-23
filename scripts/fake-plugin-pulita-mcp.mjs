#!/usr/bin/env node
// Server MCP FINTO con MOLTI strumenti per la sonda della fase plugin-pulita
// (PP1): il daemon lo collega come server MANUALE (stdio) e la scheda del
// plugin elenca i suoi tool in «Autorizzazioni» — abbastanza da far SCORRERE
// la scheda a 1200×800 e a 900×600 (≥ 20: qui 24). Metà in sola lettura
// (readOnlyHint), il resto senza annotazioni, così si dividono tra «Sola
// lettura» e «Altro». Nessuna rete, nessun Docker: JSON-RPC su stdio, come
// fake-plugin-mcp.mjs (di cui NON sostituisce nulla: quello resta com'è).
import { createInterface } from 'node:readline'

const N = 24
const TOOLS = Array.from({ length: N }, (_, i) => {
  const n = String(i + 1).padStart(2, '0')
  const read = i % 2 === 0
  return {
    name: `azione_${n}`,
    description: `Azione ${n} del server finto della sonda (${read ? 'sola lettura' : 'modifica'})`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...(read ? { annotations: { readOnlyHint: true } } : {})
  }
})

let nextId = 0
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const reply = (result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
  if (msg.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plugin-pulita-demo', version: '1.0.0' } })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    reply({ tools: TOOLS })
    return
  }
  if (msg.method === 'tools/call') {
    reply({ content: [{ type: 'text', text: `ok ${String(msg.params?.name ?? '')} #${++nextId}` }] })
    return
  }
  reply({})
})
