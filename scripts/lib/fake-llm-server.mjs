// Fase token (T7.5): finto server LLM su 127.0.0.1 che risponde sempre «ok»
// (SSE, formato OpenAI chat completions) e CONTA i byte del body delle
// richieste — serve solo a misurare i token (caratteri/4) della richiesta
// che l'eval manda davvero. Nessun modello, nessuna rete oltre localhost.
// Uso: node scripts/lib/fake-llm-server.mjs <porta> (0 = porta libera;
// stampa «listening <porta>» su stderr e resta su finché non gli arriva SIGTERM)
import http from 'node:http'

const port = Number(process.argv[2] ?? 0)
let calls = 0
let totalBytes = 0
let firstBytes = 0

const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if ((req.url ?? '').includes('/chat/completions') && req.method === 'POST') {
      calls++
      totalBytes += body.length
      if (calls === 1) firstBytes = body.length
      console.error(`[fake] call ${calls}: body ${body.length} chars ≈ ${Math.ceil(body.length / 4)} token`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const mk = (delta, finish) => JSON.stringify({
        id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake',
        choices: [{ index: 0, delta, finish_reason: finish }]
      })
      res.end(`data: ${mk({ content: 'ok' }, null)}\n\ndata: ${mk({}, 'stop')}\n\ndata: [DONE]\n\n`)
      return
    }
    // /api/show e amici (capabilities di ollama): risposta vuota che non rompe
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

srv.listen(port, '127.0.0.1', () => {
  console.error(`listening ${srv.address().port}`)
})
process.on('SIGTERM', () => {
  console.error(`summary calls=${calls} first=${firstBytes} (~${Math.ceil(firstBytes / 4)} tok) total=${totalBytes} (~${Math.ceil(totalBytes / 4)} tok)`)
  srv.close(() => process.exit(0))
})
