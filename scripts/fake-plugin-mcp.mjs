#!/usr/bin/env node
// Server MCP FINTO per la sonda della fase plugin (PL): il daemon lo collega
// come server MANUALE (stdio) e offre i suoi tool come mcp__plugin-demo__*,
// con le ANNOTAZIONI giuste per dividere Sola lettura / Scrittura / Altro e
// l'insieme fisso: search e read (readOnlyHint), delete_draft
// (destructiveHint), create_draft (senza annotazioni → Altro), send_email
// (invio, nome da invio → insieme fisso col lucchetto). Nessuna rete,
// nessun Docker: JSON-RPC su stdio, come fake-ufficio-mcp.
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'search',
    description: 'Cerca nei documenti (finto della sonda)',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'read',
    description: 'Legge un documento (finto della sonda)',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'create_draft',
    description: 'Prepara una bozza (finto della sonda)',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  },
  {
    name: 'delete_draft',
    description: 'Cestina una bozza (finto della sonda)',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true }
  },
  {
    name: 'send_email',
    description: 'Invia una email (finto della sonda)',
    inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] }
  }
]

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
    const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
    process.stdout.write(out + '\n')
  }
  if (msg.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plugin-demo', version: '1.0.0' } })
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
