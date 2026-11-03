#!/usr/bin/env node
// Server MCP FINTO «ufficio» su stdio per la sonda della fase 0.3.1001 (M1):
// il daemon lo collega come server MANUALE (transport stdio, fuori dal
// catalogo) e offre i suoi tool come mcp__ufficio__*. Nessuna rete, nessun
// Docker: risponde a initialize/tools/list/tools/call in JSON-RPC su stdio.
// Ogni tools/call viene APPESO al file indicato da FAKE_MCP_CALLS (una riga
// JSON per chiamata), così la sonda conta le chiamate RICEVUTE.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// il file delle chiamate: env (se la sonda lo passa) o il secondo argomento
// argv (il daemon spawna senza env di test: il percorso arriva dagli args)
const CALLS = process.env.FAKE_MCP_CALLS ?? process.argv[2] ?? '/dev/null'

const TOOLS = [
  {
    name: 'send_email',
    description: 'Invia una email dal server di posta dell’ufficio (finto della sonda)',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destinatario' },
        subject: { type: 'string', description: 'Oggetto' },
        body: { type: 'string', description: 'Corpo' }
      },
      required: ['to', 'body']
    }
  },
  {
    name: 'list_emails',
    description: 'Cerca le email dell’ufficio (finto della sonda)',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true }
  }
]

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ufficio-finto', version: '0.0.1' } } })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    appendFileSync(CALLS, JSON.stringify({ name, args, at: Date.now() }) + '\n')
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: `ufficio finto: ${name} ricevuta (to=${args.to ?? '?'})` }] }
    })
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
})
