#!/usr/bin/env node
// Fase velocità (S1): riassume una traccia llm-trace.jsonl (quella che il loop
// appende con SANDBOT_LLM_TRACE=1) in UNA tabella leggibile: per ogni turno
// (turnId) quante chiamate, tempi totali e al primo token (media e massimo),
// byte medi degli strumenti e del sistema, token in ingresso e di ragionamento.
// Solo numeri già nella traccia: niente contenuti, niente dipendenze.
//
//   node scripts/riassunto-trace.mjs <file llm-trace.jsonl>
import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

const file = argv[2]
if (!file) {
  console.error('uso: node scripts/riassunto-trace.mjs <file llm-trace.jsonl>')
  exit(1)
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
const max = (xs) => (xs.length ? Math.max(...xs) : null)
const fmt = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`)

/** le righe del turno, nell'ordine di callIndex; null = chiamate senza turno */
const turns = new Map()
const records = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    continue // riga rotta (scrittura interrotta): si salta
  }
  records.push(rec)
  const key = rec.turnId ?? null
  if (!turns.has(key)) turns.set(key, [])
  turns.get(key).push(rec)
}

if (!records.length) {
  console.error('nessuna riga valida in ' + file)
  exit(1)
}

// controlli di privacy: la traccia contiene SOLO numeri e nomi brevi
const forbidden = ['messages', 'content', 'apiKey', 'key', 'token_text', 'systemText']
for (const rec of records) {
  for (const f of forbidden) {
    if (f in rec) {
      console.error(`riga con campo vietato "${f}": la traccia non deve contenere contenuti`)
      exit(1)
    }
  }
}

const label = (k) => (k === null ? '(fuori turno)' : k)
const rows = []
for (const [key, rs] of turns) {
  rs.sort((a, b) => (num(a.callIndex) ?? 0) - (num(b.callIndex) ?? 0))
  const first = rs.map((r) => num(r.firstTokenMs)).filter((v) => v !== null)
  const totals = rs.map((r) => num(r.totalMs)).filter((v) => v !== null)
  const toolsB = rs.map((r) => num(r.toolsBytes)).filter((v) => v !== null)
  const sysB = rs.map((r) => num(r.systemBytes)).filter((v) => v !== null)
  const msgB = rs.map((r) => num(r.messagesBytes)).filter((v) => v !== null)
  const reasoningChars = rs.reduce((n, r) => n + (num(r.reasoningLength) ?? 0), 0)
  const input = rs.reduce((n, r) => n + (num(r.usage?.input) ?? 0), 0)
  const output = rs.reduce((n, r) => n + (num(r.usage?.output) ?? 0), 0)
  const cacheRead = rs.reduce((n, r) => n + (num(r.usage?.cacheRead) ?? 0), 0)
  const cacheWrite = rs.reduce((n, r) => n + (num(r.usage?.cacheWrite) ?? 0), 0)
  rows.push({
    turn: label(key),
    calls: rs.length,
    models: [...new Set(rs.map((r) => r.model))].join(','),
    sumMs: totals.reduce((a, b) => a + b, 0),
    firstAvg: mean(first),
    firstMax: max(first),
    tools: rs.map((r) => num(r.toolsCount) ?? 0).join('+'),
    toolsBAvg: mean(toolsB),
    sysBAvg: mean(sysB),
    msgBSum: msgB.reduce((a, b) => a + b, 0),
    reasoningChars,
    input,
    output,
    cache: cacheRead + cacheWrite > 0 ? `r${cacheRead}/w${cacheWrite}` : '—',
    thinking: [...new Set(rs.map((r) => (r.thinkingSent === undefined ? undefined : r.thinkingSent)).filter((v) => v !== undefined))].join(',') || '—'
  })
}

const head = ['turno', 'chiamate', 'modelli', 'somma ms', '1° token ms (media/max)', 'tools (n)', 'tools byte (media)', 'sistema byte (media)', 'messaggi byte (somma)', 'ragionamento (caratteri)', 'token in', 'token out', 'cache r/w', 'reasoning_effort']
const table = [head, ...rows.map((r) => [
  r.turn, String(r.calls), r.models,
  fmt(r.sumMs), `${fmt(r.firstAvg)}/${fmt(r.firstMax)}`,
  r.tools, fmt(r.toolsBAvg), fmt(r.sysBAvg), fmt(r.msgBSum),
  fmt(r.reasoningChars), fmt(r.input), fmt(r.output), r.cache, r.thinking
])]
const widths = head.map((_, i) => Math.max(...table.map((row) => String(row[i]).length)))
for (const row of table) {
  console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('  '))
}
const tot = records.length
console.log(`\ntotale: ${tot} chiamate in ${turns.size} turni · modelli: ${[...new Set(records.map((r) => r.model))].join(', ')}`)
