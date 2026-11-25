// F7 (fase fundamenta): il «modello» — server OpenAI-compatible FINTO su
// 127.0.0.1 che risponde da copione e REGISTRA le chiamate. Stesso comportamento
// del provider delle sonde di design e di b20-bug (uno solo, in un posto solo):
//   mode 'md'        — risponde col testo di `mdText` (a paragrafi, come uno streaming vero)
//   mode 'reasoning' — ragiona e non risponde (l'avviso di risposta vuota)
//   mode 'empty'     — non emette nulla (completion_tokens 0)
//   mode 'tools'     — consuma la coda `script`: { toolCalls: [{ name, args }] } oppure { text }
// `requests` tiene n · lastUser · tools · at per i controlli delle sonde.
// Nessuna rete fuori da 127.0.0.1: ascolta su 127.0.0.1 con porta 0 (libera).
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const chunkOf = (delta, finish = null, usage) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`

export const modelloFinto = () => {
  let mode = 'md'
  let mdText = ''
  const script = [] // { toolCalls: [{ name, args }] } | { text }
  const requests = [] // { n, lastUser, tools, at }

  const provider = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let msg = {}
        try { msg = JSON.parse(body) } catch { /* non JSON */ }
        const users = (msg.messages ?? []).filter((m) => m.role === 'user')
        requests.push({ n: requests.length + 1, lastUser: String(users.at(-1)?.content ?? ''), tools: (msg.tools ?? []).map((t) => t?.function?.name ?? t?.name), at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(chunkOf({ role: 'assistant', content: '' }))
        if (mode === 'tools') {
          const next = script.shift() ?? { text: 'Fatto.' }
          for (const [i, tc] of (next.toolCalls ?? []).entries()) {
            res.write(chunkOf({ tool_calls: [{ index: i, id: `call_${randomBytes(4).toString('hex')}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] }))
          }
          if (next.toolCalls) res.write(chunkOf({}, 'tool_calls'))
          else { res.write(chunkOf({ content: next.text ?? 'ok' })); res.write(chunkOf({}, 'stop')) }
        } else if (mode === 'reasoning') {
          res.write(chunkOf({ content: null, reasoning_content: 'Penso a quali fonti controllare; non scrivo la risposta.' }))
          res.write(chunkOf({}, 'stop', { prompt_tokens: 312, completion_tokens: 42, total_tokens: 354 }))
        } else if (mode === 'empty') {
          res.write(chunkOf({}, 'stop', { prompt_tokens: 312, completion_tokens: 0, total_tokens: 312 }))
        } else {
          for (const piece of mdText.split('\n\n')) res.write(chunkOf({ content: `${piece}\n\n` }))
          res.write(chunkOf({}, 'stop'))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
      return
    }
    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  return {
    requests, script,
    get mode() { return mode },
    set mode(v) { mode = v },
    get mdText() { return mdText },
    set mdText(v) { mdText = v },
    avvia: async () => {
      await new Promise((r) => provider.listen(0, '127.0.0.1', r))
      return provider.address().port
    },
    chiudi: () => { try { provider.close() } catch { /* già chiuso */ } }
  }
}
