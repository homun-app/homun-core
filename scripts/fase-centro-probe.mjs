#!/usr/bin/env node
// Sonda della fase centro-autorizzazioni — i flussi della spec provati DAL
// VIVO con la UI, come le altre sonde: app VERA (out/, serve `npm run build`
// prima) su dati temporanei, modello FINTO openai-compatible scriptabile su
// 127.0.0.1, CLI `container` FINTA, Portachiavi/SafeStorage FINTI, browser
// MCP FINTO, server MCP «ufficio» FINTO per la bozza. MAI il container vero,
// mai download, rete solo su 127.0.0.1.
//
// Scenario (spec): 2 squadre e 1 bot singolo, con un sottoagente; 5 richieste
// in attesa — dati tuoi (fill della Cassaforte), invio (bozza email), sito
// interattivo ×2 (browser_type con submit), login (fill del sottoagente).
//
// Controlli: la voce «Da approvare» con 5; i gruppi giusti; i filtri; la
// decisione dal centro che sblocca il turno del bot; la card nella chat del
// bot passata a decisa; il riquadro ridotto «+N altrove» in cima (A3 fase
// approvazioni-chiare: la richiesta del bot aperto sta SOPRA il campo);
// «Rimanda»; nessun «approva tutto».
//
// fase approvazioni-chiare — ESTENSIONE: il menu «Altre scelte ▾» del centro
// (A1, le scelte del modello unico), il REGISTRO con le decisioni complete
// (A2), «Consentiti sempre» con Revoca → il gate chiede di nuovo, e la
// richiesta del bot aperto sopra il campo di scrittura (A3).
//
// Catture CDP delle tavole 4 e 5 in docs/catture/fase-centro/; quelle della
// fase approvazioni-chiare (centro col Registro, chat con la richiesta in
// basso) in docs/catture/fase-approvazioni-chiare/. VERDE in TRE corse di
// fila: node scripts/fase-centro-probe.mjs. Attese dei click UI ≤ 5 s
// (lezione di fase-squadra). Pulizia K4: 0 cartelle sandbot-fase-centro-*, 0
// daemon della sonda, 0 llama-server nati con la corsa.
//
// F7 (fase fondamenta): la sonda usa il MOTORE comune (scripts/lib/sonda.mjs):
// un avvio per corsa, porta CDP libera scelta a caso (niente --run), e le
// attese sono su CONDIZIONE (s.attendi e varianti), non a tempo. Cosa
// controlla NON cambia: stesse verifiche e stesso numero di controlli verdi
// (55).
import { spawnSync, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { avviaSonda, messaggioTentativiLocali } from './lib/sonda.mjs'
import { findProbeDaemons } from './lib/probe-daemons.mjs'

const run = 1
const ROOT = resolve(import.meta.dirname, '..')
const PREFIX = 'sandbot-fase-centro'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-centro')
mkdirSync(SHOTS, { recursive: true })
// fase approvazioni-chiare: le catture della fase nuova
const SHOTS2 = join(ROOT, 'docs', 'catture', 'fase-approvazioni-chiare')
mkdirSync(SHOTS2, { recursive: true })
// fase ritocchi-beta18 (R1): le catture della chat con la riga compatta e il
// riquadro, e del «1 di N» con le frecce
const SHOTS3 = join(ROOT, 'docs', 'catture', 'fase-ritocchi-beta18')
mkdirSync(SHOTS3, { recursive: true })

const log = (...a) => console.log(`[sonda r${run}]`, ...a)

let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  if (!ok) failed++
  log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- il modello FINTO della sonda: risposte a pattern sul body (quando `when` calza).
// `when` può essere una stringa, UNA LISTA (tutte presenti nel body) o una
// FUNZIONE (body, tools) — il FIGLIO si riconosce dai tool (ha wake_parent,
// come la sonda aiutanti: il suo prompt non porta un nome affidabile) ----
const script = []
const matches = (body, tools, when) =>
  typeof when === 'function' ? !!when(body, tools)
  : when == null ? true
  : Array.isArray(when) ? when.every((w) => body.includes(w))
  : body.includes(when)
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
const chatRequests = []
const served = []
const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'

const providerServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      chatRequests.push(body)
      const tools = [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1])
      const idx = script.findIndex((x) => matches(body, tools, x.when))
      const next = idx >= 0 ? script.splice(idx, 1)[0] : { kind: 'text', text: 'ok' }
      const who = /You are (@?[\wÀ-ÿ']+)/.exec(body)?.[1] ?? (tools.includes('wake_parent') ? 'FIGLIO' : '?')
      const lastUser = body.slice(Math.max(0, body.lastIndexOf('"role":"user"')), Math.max(0, body.lastIndexOf('"role":"user"')) + 220).replace(/\n/g, ' ')
      served.push({ res: next.kind === 'tool' ? next.name : `text:${String(next.text).slice(0, 30)}`, who, u: lastUser.slice(0, 130) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (next.kind === 'tool') {
        res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_finto', type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null))
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({ role: 'assistant', content: next.text }, null))
        res.write(sse({}, 'stop'))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- F7: il MOTORE comune — la CLI `container` FINTA (mai quella vera) e il
// browser MCP FINTO nell'ENV dell'app: le cartelle le crea il motore, e i
// valori si impostano su sonda.env PRIMA di sonda.avvia() ----
const sonda = await avviaSonda({
  prefix: PREFIX,
  envExtra: {},
  log
})
// la CLI `container` FINTA nella cartella dati del motore: impostata nell'ENV prima di avviare
const FAKE_CONTAINER = join(sonda.data, 'fake-container.sh')
writeFileSync(FAKE_CONTAINER, [
  '#!/bin/sh',
  '# CLI container FINTA della sonda: niente docker, niente container vero',
  'if [ "$1" = "--version" ]; then echo "container 1.7.1-finta"; exit 0; fi',
  'echo "[]" ; exit 0'
].join('\n'))
chmodSync(FAKE_CONTAINER, 0o755)
sonda.env.HOMUN_CONTAINER_PATH = FAKE_CONTAINER
sonda.env.SANDBOT_TEST_FAKE_BROWSER_MCP = join(ROOT, 'scripts', 'fake-browser-mcp.mjs')

// i llama-server GIÀ in corsa (per esempio l'Ollama dell'utente) non sono
// della sonda — il controllo di pulizia conta solo quelli NASCITI dopo
const llamaBaseline = (() => {
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-x', 'llama-server'], { encoding: 'utf8' })
    return new Set(String(out.stdout ?? '').trim().split('\n').filter(Boolean))
  } catch { return new Set() }
})()

const connessione = await sonda.avvia()
const portaDebug = connessione.porta
log('CDP collegato al renderer (porta', portaDebug + ')')

/** fase barra-sobria: le squadre sono CHIUSE di default — i membri si
 *  aprono dalla chevron, la strada di prodotto, prima di selezionarli */
const openTeamMembers = async (teamName) => {
  // il clic si RIPETE: la barra si remonta a ogni cambio di stato dei bot e la chevron può sparire fra un poll e l'altro
  const fine = Date.now() + 10_000
  for (;;) {
    const ok = await sonda.eval(`
      const btns = [...document.querySelectorAll('aside button[aria-label]')]
      const b = btns.find((x) => (x.getAttribute('aria-label') ?? '').includes(${JSON.stringify(`Apri i membri di ${teamName}`)}))
      if (!b) return false
      b.click()
      return true
    `).catch(() => false)
    if (ok === true) return true
    if (Date.now() > fine) {
      log('DEBUG chevron assente entro 10 s:', JSON.stringify(await sonda.eval(`return [...document.querySelectorAll('aside button')].slice(0, 12).map((b) => (b.getAttribute('aria-label') ?? '') + ' | ' + (b.textContent ?? '').trim().slice(0, 30))`).catch((e2) => 'eval: ' + e2.message)))
      return false
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
/** seleziona un bot nella barra laterale e aspetta il compositore privato.
 * La RIGA può arrivare col refresh coalescente (fino a 10 s per trovarla); la
 * REAZIONE al click — il compositore del bot — resta entro 5 s: se la UI
 * rallenta, la sonda deve essere rossa. */
const selectBot = async (name) => {
  const fine = Date.now() + 10_000
  for (;;) {
    const ok = await sonda.eval(`
      const rows = [...document.querySelectorAll('aside button')]
      const row = rows.find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))
      if (!row) return false
      row.scrollIntoView({ block: 'center' })
      row.click()
      return true
    `).catch(() => false)
    if (ok && await sonda.attendi(`document.querySelector('form textarea') && (document.querySelector('form textarea').placeholder ?? '').includes(${JSON.stringify(name)})`, { entro: 5_000, motivo: 'il compositore privato di ' + name }).catch(() => false)) return true
    if (Date.now() > fine) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}
/** il messaggio scritto e inviato col submit del form (come l'utente). */
const sendMessage = async (text) => {
  await sonda.scrivi('form textarea', text)
  return sonda.eval(`
  const ta = document.querySelector('form textarea')
  if (!ta) return false
  const form = ta.closest('form')
  form.requestSubmit()
  return true
`)
}
/** il clic per testid: il loop di retry è nel motore (sonda.clic); qui resta
 * solo la semantica della sonda — false, non throw, se non riesce (≤ 5 s) */
const clickTestid = async (testid, entro = 5_000) => sonda.clic(testid, { entro }).catch(() => false)
/** il clic di una voce per testo (i filtri del centro sono bottoni pilola):
 * loop di retry nel motore (sonda.clicTesto), false se non riesce */
const clickText = (text, { scope = 'document', exact = false, entro = 5_000 } = {}) =>
  sonda.clicTesto(text, scope, { entro, esatto: exact }).catch(() => false)
const shot = async (name) => { await sonda.cattura(join(SHOTS, name)); log('cattura', name) }
/** la cattura della fase approvazioni-chiare (cartella della fase) */
const shot2 = async (name) => { await sonda.cattura(join(SHOTS2, name)); log('cattura (fase approvazioni-chiare)', name) }
/** la cattura della fase ritocchi-beta18 (R1) */
const shot3 = async (name) => { await sonda.cattura(join(SHOTS3, name)); log('cattura (fase ritocchi-beta18)', name) }
/** aprire un menu Radix (si apre col POINTERDOWN, non col solo click —
 *  lezione di fase uso-permessi) e aspettare le voci */
const openMenu = async (testid, entro = 5_000) => {
  const opened = await sonda.eval(`
    const b = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }))
    b.click()
    return true
  `).catch(() => false)
  if (!opened) return false
  return sonda.attendi(`document.querySelectorAll('[role="menuitem"]').length > 0`, { entro, motivo: 'le voci del menu' }).catch(() => false)
}
/** aprire il menu Radix della CARD che contiene il testo cercato */
const openMenuInCard = async (cardText, testid, entro = 5_000) => {
  const opened = await sonda.eval(`
    const cards = [...document.querySelectorAll('[data-testid="approvals-center-card"]')]
    const card = cards.find((c) => c.textContent.includes(${JSON.stringify(cardText)}))
    const b = card?.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }))
    b.click()
    return true
  `).catch(() => false)
  if (!opened) return false
  return sonda.attendi(`document.querySelectorAll('[role="menuitem"]').length > 0`, { entro, motivo: 'le voci del menu della card' }).catch(() => false)
}

/** cliccare la voce del menu aperto col testid cercato */
const clickMenuItem = (testid) => sonda.eval(`
  const b = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!b) return false
  b.click()
  return true
`).catch(() => false)

/** click su un bottone dentro la CARD che contiene il testo cercato (per decidere LA richiesta giusta) — si RIPETE: la lista si remonta a ogni decisione */
const clickInCard = async (cardText, testid, entro = 5_000) => {
  const fine = Date.now() + entro
  for (;;) {
    const ok = await sonda.eval(`
      const cards = [...document.querySelectorAll('[data-testid="approvals-center-card"]')]
      const card = cards.find((c) => c.textContent.includes(${JSON.stringify(cardText)}))
      if (!card) return false
      const b = card.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!b) return false
      b.scrollIntoView({ block: 'center' })
      b.click()
      return true
    `).catch(() => false)
    if (ok === true) return true
    if (Date.now() > fine) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

try {
  // ---- setup: provider finto, guida chiusa, i bot, le squadre, l'MCP ufficio ----
  await sonda.attendi(`typeof window.sandbot !== 'undefined' && !!window.sandbot`, { entro: 40_000, motivo: 'il preload sia pronto' })
  await sonda.viewport(1280, 860, { scala: 2 })
  await sonda.rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await sonda.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await sonda.rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await sonda.rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sonda.attendiRete({ quieta: 250, entro: 3_000 }).catch(() => undefined)
    }
    if (await sonda.eval(`return !!document.querySelector('aside')`).catch(() => false)) break
  }
  if (!(await sonda.attendi(`!!document.querySelector('aside')`, { entro: 5_000, motivo: 'la guida si sia chiusa' }).catch(() => false))) throw new Error('la guida non si è chiusa: ' + sonda.appLog().slice(-600))

  const mkBot = async (name, role) => {
    const a = await sonda.rpc(`createAgent(${JSON.stringify(name)}, ${JSON.stringify(role)})`)
    await sonda.rpc(`updateAgent(${JSON.stringify(a.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    return a
  }
  // i coordinatori non hanno riga propria nella barra (stanno nella riga
  // della squadra): per selezionare TUTTI i bot che chiedono, il coordinatore
  // è un bot a parte che non chiede nulla
  const capoWt = await mkBot('Capo Torino', 'Coordina il weekend')
  const capoFm = await mkBot('Capo Fatture', 'Coordina i solleciti')
  const turismo = await mkBot('Turismo', 'Itinerari e musei')
  const alloggio = await mkBot('Alloggio', 'Hotel e disponibilità')
  const archivio = await mkBot('Archivio', 'Documenti delle fatture')
  const solleciti = await mkBot('Solleciti', 'Email di sollecito')
  const ricerche = await mkBot('Ricerche', 'Ricerche online')
  const wt = await sonda.rpc(`groupCreate(${JSON.stringify('Weekend Torino')}, ${JSON.stringify([capoWt.id, turismo.id, alloggio.id])}, ${JSON.stringify(capoWt.id)}, ${JSON.stringify('Guida del weekend')})`)
  const fm = await sonda.rpc(`groupCreate(${JSON.stringify('Fatture marzo')}, ${JSON.stringify([capoFm.id, archivio.id, solleciti.id])}, ${JSON.stringify(capoFm.id)}, ${JSON.stringify('Contabilità')})`)
  check('setup: le due squadre e il bot singolo', !!wt?.id && !!fm?.id, `${wt?.name}/${fm?.name}`)

  // i login della Cassaforte (modulo del museo e login del sottoagente)
  const museo = await sonda.rpc(`vaultSaveLogin(${JSON.stringify({ label: 'Museo Egizio', origins: ['https://spa.example'], username: 'utente-musei', password: 'pwd-musei-8a4b2c' })})`)
  const linkedin = await sonda.rpc(`vaultSaveLogin(${JSON.stringify({ label: 'LinkedIn', origins: ['https://spa.example'], username: 'utente-linkedin', password: 'pwd-linkedin-9c1d3e' })})`)

  // il server MCP «ufficio» FINTO: la bozza dell'invio (mai rete vera)
  const mcpCallsFile = join(sonda.data, 'ufficio-calls.jsonl')
  const serverCfg = { id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-ufficio-mcp.mjs'), mcpCallsFile], enabled: true, enabledFor: ['*'] }
  await sonda.rpc(`mcpSave(${JSON.stringify(serverCfg)})`)
  const mcpOk = await sonda.rpc(`mcpTest('srv-ufficio')`)
  check('setup: il server MCP «ufficio» è collegato (bozze senza rete)', mcpOk?.ok === true && (mcpOk.tools ?? []).some((t) => t.includes('send_email')), JSON.stringify(mcpOk)?.slice(0, 120))
  // come la sonda 0.3.1001: dopo il collegamento si ricarica la pagina perché
  // i tool del server siano offerti al modello
  await sonda.eval(`location.reload(); return true`).catch(() => undefined)
  if (!(await sonda.attendi(`!!document.querySelector('aside')`, { entro: 25_000, motivo: 'la pagina torni dopo il reload' }).catch(() => false))) throw new Error('la pagina non è tornata dopo il reload: ' + sonda.appLog().slice(-500))
  // fase barra-sobria: le squadre sono chiuse di default e i turni della
  // sonda passano dai MEMBRI — si aprono dalla chevron (scelta che si ricorda)
  for (const teamName of ['Weekend Torino', 'Fatture marzo']) {
    if (!(await openTeamMembers(teamName))) throw new Error(`apertura membri di ${teamName} non riuscita`)
  }
  if (!(await sonda.attendi(`[...document.querySelectorAll('aside button')].some((b) => b.textContent.trim().startsWith('Turismo'))`, { entro: 5_000, motivo: 'i membri aperti si vedano' }).catch(() => false))) throw new Error('i membri aperti non si vedono')

  // =========== lo script del modello: le 5 richieste ===========
  // 1. Turismo (Weekend Torino): fill_credential col login del museo → i tuoi dati
  const T1 = ['You are Turismo', 'modulo-museo']
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T1)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T1)
  callTool('fill_credential', { id: String(museo.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T1)
  callTool('fill_credential', { id: String(museo.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T1)
  sayText('Modulo del museo compilato col login della Cassaforte.', T1)
  // 2. Alloggio (Weekend Torino): browser_type con submit → sito interattivo
  const T2 = ['You are Alloggio', 'verifica-alloggio']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2)
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2)
  callTool('browser_type', { ref: 'e4', text: 'rossi@example.com', submit: true }, T2)
  // 3bis. Alloggio, SECONDA tornata (dopo la Revoca del consenso sempre: il
  // gate deve chiedere di nuovo) — riconosciuta dal messaggio nuovo
  const T2b = ['You are Alloggio', 'verifica-alloggio-2']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2b)
  callTool('browser_type', { ref: 'e4', text: 'rossi@example.com', submit: true }, T2b)
  // 3. Archivio (Fatture marzo): browser_type con submit sulla pagina della prenota → sito interattivo
  const T3 = ['You are Archivio', 'fatture-archivio']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T3)
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T3)
  callTool('browser_type', { ref: 'e4', text: 'Rossi Srl', submit: true }, T3)
  // 4. Solleciti (Fatture marzo): email di sollecito → BOZZA (invio)
  // la bozza NON ferma il turno (si decide dopo): UNA sola chiamata basta
  const T4 = ['You are Solleciti', 'sollecito-rossi']
  callTool('mcp__ufficio__send_email', { to: 'amministrazione@rossisrl.example', subject: 'Fattura 214 scaduta il 28/02', body: 'Gentile Rossi Srl, la fattura 214 è scaduta. Cordialità.' }, T4)
  sayText('Bozza del sollecito pronta: la decidi tu.', T4)
  // 5a. Ricerche (bot singolo): il LOGIN di LinkedIn con la Cassaforte
  const T5 = ['You are Ricerche', 'login-linkedin']
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T5)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T5)
  callTool('fill_credential', { id: String(linkedin.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T5)
  callTool('fill_credential', { id: String(linkedin.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T5)
  // 5b. Ricerche lancia anche il SOTTOAGENTE: i figli non hanno il browser (è
  // del padre), il loro run-command chiede comunque all'utente — la sua card
  // dal centro si RIFIUTA (extra: si decide anche la richiesta di un figlio)
  const T6 = ['You are Ricerche', 'compito-figlio']
  callTool('spawn_subagent', { title: 'Controllo fattura', brief: 'Obiettivo: eseguire un comando echo innocuo (compito-figlio) e riferire l\'esito. Confini: nessuna rete, non toccare file fuori dalla cartella temporanea, nessun altro strumento. Risultato: una riga con l\'output del comando.' }, T6)
  sayText('Ho lanciato l\'aiutante per il controllo: ti chiede il permesso.', T6)
  // R1 (fase ritocchi-beta18): l'AIUTANTE di Alloggio — la sua richiesta conta
  // per ALLOGGIO (bot aperto): due richieste dello stesso bot nel riquadro
  // sopra il campo → «1 di 2» con le frecce. Le sue voci stanno PRIMA di
  // quelle del figlio di T6 nell'array (findIndex FIFO) e si riconoscono
  // dal BRIEF («Controllo camera»): il figlio di T6 non le consuma e la
  // voce «Fatto.» di T6 — che quel figlio non consuma mai — non ruba il
  // turno a questo
  const CHILD2 = (body) => body.includes('Controllo camera')
  const T7 = ['You are Alloggio', 'figlio-alloggio']
  callTool('spawn_subagent', { title: 'Controllo camera', brief: 'Obiettivo: eseguire un comando echo innocuo (figlio-alloggio) e riferire l\'esito. Confini: nessuna rete, non toccare file fuori dalla cartella temporanea, nessun altro strumento. Risultato: una riga con l\'output del comando.' }, T7)
  sayText('Ho lanciato l\'aiutante: ti chiede il permesso.', T7)
  callTool('run-command', { command: 'echo controllo-camera' }, CHILD2)
  callTool('wake_parent', { summary: 'Permesso concesso: controllo eseguito.' }, CHILD2)
  sayText('Fatto.', CHILD2)
  const CHILD = (_body, tools) => tools.includes('wake_parent')
  callTool('run-command', { command: 'echo controllo-fattura' }, CHILD)
  callTool('wake_parent', { summary: 'Il comando è stato rifiutato: controllo non eseguito.' }, CHILD)
  sayText('Fatto.', CHILD)

  // ---- i turni: un messaggio privato a ogni bot (il sottoagente parte da solo).
  // Ricerche è ULTIMO: il limite di prodotto è 3 browser per computer e il
  // suo login ne apre un quarto — prima si chiudono i browser FINTI dei due
  // bot la cui card resta comunque in attesa (le card sono entry: vivono
  // anche senza browser; quei due turni non eseguiranno mai l'azione) ----
  const pidsBrowser = () => {
    const out = spawnSync('/usr/bin/pgrep', ['-f', 'fake-browser-mcp'], { encoding: 'utf8' })
    return String(out.stdout ?? '').trim().split('\n').filter(Boolean).map(Number).filter((p) => Number.isInteger(p) && p !== process.pid).sort((a, b) => a - b)
  }
  const freeBrowserSlots = (keep) => {
    const pids = pidsBrowser()
    const toKill = keep > 0 ? pids.slice(keep) : pids
    for (const pid of toKill) {
      try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
    }
    return { totale: pids.length, chiusi: toKill.length }
  }
  for (const [bot, msg, marker] of [
    [turismo, 'modulo-museo: compila il modulo del museo (https://spa.example/login) con i miei dati della Cassaforte', 'modulo-museo'],
    [alloggio, 'verifica-alloggio: scrivi la mia email nel modulo di verifica (https://spa.example/prenota) e invialo', 'verifica-alloggio'],
    [archivio, 'fatture-archivio: scrivi il nome Rossi Srl nel modulo della pagina (https://spa.example/prenota) e invialo', 'fatture-archivio'],
    [solleciti, 'sollecito-rossi: manda la email di sollecito a Rossi Srl', 'sollecito-rossi']
  ]) {
    if (!(await selectBot(bot.name))) throw new Error(`selezione di ${bot.name} non riuscita`)
    await sendMessage(msg)
    // (era sleep(400)) il turno del bot parte dal messaggio RENDERizzato nella
    // chat: si aspetta quello, non l'orologio
    await sonda.attendi(`document.body.textContent.includes(${JSON.stringify(marker)})`, { entro: 10_000, motivo: `il messaggio ${marker} sia nella chat` }).catch(() => false)
  }
  // le prime 4 richieste (3 browser + la bozza)...
  const quattro = await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('4')`, { entro: 90_000, passo: 500, motivo: 'le prime 4 richieste in barra' }).catch(() => false)
  check('le prime 4 richieste nascono (fill, 2 siti, bozza)', quattro,
    (await sonda.eval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  // ...si libera posto per il browser del login (resta vivo quello di Turismo,
  // il primo aperto: la sua card si deciderà davvero)
  const freed = freeBrowserSlots(1)
  log('browser finti chiusi per il login (limite 3 per computer):', JSON.stringify(freed))
  // (era sleep(1000)) i browser finti chiusi devono essere DAVVERO andati: il
  // limite di 3 per computer conta i processi vivi
  {
    const fine = Date.now() + 5_000
    while (pidsBrowser().length > 1 && Date.now() < fine) await new Promise((r) => setTimeout(r, 100))
  }
  // prima il FIGLIO (quel turno finisce in fretta), poi il login (che mette
  // il turno in pausa sulla card: i messaggi dopo resterebbero in coda)
  for (const [msg, marker] of [
    ['compito-figlio: lancia l\'aiutante per il controllo della fattura', 'compito-figlio'],
    ['login-linkedin: accedi a LinkedIn (https://spa.example/login) col mio login della Cassaforte', 'login-linkedin']
  ]) {
    if (!(await selectBot(ricerche.name))) throw new Error('selezione di Ricerche non riuscita')
    await sendMessage(msg)
    // (era sleep(400)) come sopra: il messaggio renderizzato
    await sonda.attendi(`document.body.textContent.includes(${JSON.stringify(marker)})`, { entro: 10_000, motivo: `il messaggio ${marker} sia nella chat` }).catch(() => false)
  }

  // =========== 0. la richiesta del SOTTOAGENTE si rifiuta dal centro ===========
  const six = await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('6')`, { entro: 90_000, passo: 500, motivo: 'le 6 richieste in barra' }).catch(() => false)
  check('le 6 richieste ci sono tutte (5 + quella del sottoagente)', six,
    (await sonda.eval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  check('il centro si apre dalla voce della barra', await clickTestid('sidebar-approvals') &&
    await sonda.attendi(`!!document.querySelector('[data-testid="approvals-center"]')`, { entro: 5_000, motivo: 'il centro delle approvazioni' }).catch(() => false))
  check('la richiesta del sottoagente mostra il PADRE e «tramite un sottoagente»',
    await sonda.attendi(`[...document.querySelectorAll('[data-testid="approvals-center-card"]')].some((c) => c.textContent.includes('tramite un sottoagente') && c.textContent.includes('Ricerche'))`, { entro: 5_000, motivo: 'la card del sottoagente col padre' }).catch(() => false))
  check('si RIFIUTA dal centro la richiesta del sottoagente', await clickInCard('tramite un sottoagente', 'approval-deny'))
  const figlioChiuso = await sonda.attendi(`(await window.sandbot.listSubagents(${JSON.stringify(ricerche.id)})).every((s) => s.status !== 'running')`, { entro: 30_000, passo: 500, motivo: 'il turno del sottoagente si chiuda' }).catch(() => false)
  check('rifiutata dal centro, il turno del sottoagente si chiude', figlioChiuso)

  // =========== 1. la voce «Da approvare» con 5 ===========
  const five = await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, { entro: 30_000, passo: 500, motivo: 'la barra scenda a 5' }).catch(() => false)
  check('la voce «Da approvare» della barra mostra 5', five,
    (await sonda.eval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  const rows = five ? await sonda.rpc(`approvalsPendingAll()`) : []
  if (!five) {
    // diagnostica: cosa è successo nei turni
    for (const [nome, id] of [['Solleciti', solleciti.id], ['Alloggio', alloggio.id], ['Ricerche', ricerche.id]]) {
      const tail = (await sonda.rpc(`getEntries(${JSON.stringify(id)})`).catch(() => [])).slice(-16).map((e) => ({ k: e.kind, st: e.meta?.status, c: String(e.content).slice(0, 80) }))
      log('DEBUG entries', nome, JSON.stringify(tail))
    }
    log('DEBUG tool-results Ricerche:', JSON.stringify((await sonda.rpc(`getEntries(${JSON.stringify(ricerche.id)})`).catch(() => [])).filter((e) => e.kind === 'tool-result').map((e) => String(e.content).slice(0, 110))))
    const subs = await sonda.rpc(`listSubagents(${JSON.stringify(ricerche.id)})`).catch(() => [])
    for (const sub of subs) {
      const tail = (await sonda.rpc(`getEntries(${JSON.stringify(sub.id)})`).catch(() => [])).slice(-6).map((e) => ({ k: e.kind, st: e.meta?.status, c: String(e.content).slice(0, 60) }))
      log('DEBUG entries FIGLIO', sub.name ?? sub.id, JSON.stringify(tail))
    }
    const mcpFile = existsSync(mcpCallsFile) ? readFileSync(mcpCallsFile, 'utf8').trim() : '(nessuna chiamata)'
    log('DEBUG chiamate MCP ufficio:', mcpFile.slice(0, 300))
  }
  check('le 5 richieste sono quelle giuste (2 squadre + 1 bot singolo)', rows.length === 5 &&
    rows.filter((r) => r.squad?.id === wt.id).length === 2 &&
    rows.filter((r) => r.squad?.id === fm.id).length === 2 &&
    rows.filter((r) => r.squad === null).length === 1 &&
    rows.filter((r) => r.category === 'dati-tuoi').length === 2 &&
    rows.filter((r) => r.category === 'invio').length === 1 &&
    rows.filter((r) => r.category === 'sito-interattivo').length === 2,
    rows.map((r) => `${r.botName}:${r.category}`).join(','))

  // =========== 6 (prima delle decisioni). il riquadro nella chat principale ===========
  // B1 (fase beta10-correzioni): «Chiudi» deve chiudere DAVVERO il centro e
  // riportare la chat. Prima qui c'era un waitDom il cui risultato veniva
  // ignorato: la beta.10 disegnava il centro per sempre e la cattura 5
  // mostrava il centro al posto della chat
  check('«Chiudi» chiude il centro e torna alla chat (composer visibile)', await clickTestid('approvals-center-close') &&
    await sonda.attendi(`!document.querySelector('[data-testid="approvals-center"]') && !!document.querySelector('form textarea')`, { entro: 5_000, motivo: 'il centro chiuso e il composer' }).catch(() => false))
  // B1: dal centro RIAPERTO, il clic su un bot della barra laterale porta alla
  // SUA chat: composer di quel bot e centro assente
  const botViaSidebar = await clickTestid('sidebar-approvals') &&
    await sonda.attendi(`!!document.querySelector('[data-testid="approvals-center"]')`, { entro: 5_000, motivo: 'il centro riaperto' }).catch(() => false) &&
    await selectBot('Bot') &&
    await sonda.attendi(`!document.querySelector('[data-testid="approvals-center"]') && (document.querySelector('form textarea')?.placeholder ?? '').includes('Bot')`, { entro: 5_000, motivo: 'la chat del bot dal centro' }).catch(() => false)
  check('dal centro aperto, il clic su un bot della barra laterale porta alla sua chat', botViaSidebar)
  // A3 (fase approvazioni-chiare): in cima SOLO il riquadro ridotto «+N
  // altrove» — tutte le richieste sono di ALTRI bot (la chat è del bot Bot)
  const banner = await sonda.attendi(`!!document.querySelector('[data-testid="approvals-banner"]')`, { entro: 10_000, motivo: 'il riquadro in cima alla chat' }).catch(() => false)
  const bannerText = banner ? await sonda.eval(`return document.querySelector('[data-testid="approvals-banner"]').textContent`) : ''
  check('il riquadro in cima alla chat principale è RIDOTTO: «+5 altrove»', banner && bannerText.includes('+5 altrove') && bannerText.includes('Apri'), String(bannerText).slice(0, 160))
  check('la richiesta del bot aperto NON sta nel riquadro in cima (nessun «Decidi»)', banner && (bannerText.match(/Decidi/g) ?? []).length === 0, String(bannerText).slice(0, 200))
  // B1: la cattura 5 è la CHAT col riquadro — il centro non deve esserci nel
  // DOM al momento dello shot
  check('la cattura 5 mostra la chat col riquadro: il centro NON c\'è al momento dello shot', banner && !(await sonda.eval(`return document.querySelector('[data-testid="approvals-center"]') !== null`).catch(() => true)))
  await shot('5-chat-principale-riquadro.png')

  // =========== 2/3. il centro: gruppi e filtri ===========
  // A3: il riquadro ridotto É il bottone («+N altrove · Apri "Da approvare"»)
  const bannerOpened = await sonda.eval(`
    const b = document.querySelector('[data-testid="approvals-banner"] button')
    if (!b) return false
    b.click(); return true
  `).catch(() => false)
  check('«Apri «Da approvare»» del riquadro apre il centro', bannerOpened === true &&
    await sonda.attendi(`!!document.querySelector('[data-testid="approvals-center"]')`, { entro: 5_000, motivo: 'il centro dal riquadro' }).catch(() => false))
  const centerText = () => sonda.eval(`return document.querySelector('[data-testid="approvals-center"]').textContent`)
  let text = await centerText()
  check('i gruppi giusti: Weekend Torino · 2, Fatture marzo · 2, Ricerche · 1',
    text.includes('Weekend Torino') && text.includes('team · 2') &&
    text.includes('Fatture marzo') && text.includes('bot · 1') && text.includes('Ricerche'),
    String(text).slice(0, 300))
  check('i filtri con i conteggi: Tutte · 5, I tuoi dati · 2, Invii · 1, Siti · 2',
    text.includes('Tutte · 5') && text.includes('I tuoi dati · 2') && text.includes('Invii · 1') && text.includes('Siti · 2'))
  check('la bozza ha i bottoni di oggi: Invia, Modifica, Rifiuta',
    (await sonda.eval(`return [...document.querySelectorAll('[data-testid="approvals-center-card"]')].filter((c) => c.textContent.includes('sollecito') || c.textContent.includes('Fattura 214')).map((c) => [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|')).join(' ; ')`)).includes('Invia'))
  await shot('4-da-approvare-centro.png')
  // il filtro «Siti» lascia solo i 2 siti
  check('il filtro «Siti · 2» lascia solo i siti', await clickText('Siti · 2', { exact: true }) &&
    await sonda.attendi(`document.querySelectorAll('[data-testid="approvals-center-card"]').length === 2`, { entro: 5_000, motivo: 'solo le 2 card dei siti' }).catch(() => false))
  check('«Tutte · 5» torna tutto', await clickText('Tutte · 5', { exact: true }) &&
    await sonda.attendi(`document.querySelectorAll('[data-testid="approvals-center-card"]').length === 5`, { entro: 5_000, motivo: 'tutte le 5 card' }).catch(() => false))

  // =========== A1: il menu «Altre scelte ▾» del centro — le scelte del modello unico ===========
  const menuAperto = await openMenuInCard('Alloggio', 'approval-altre-scelte')
  const menuItems = menuAperto
    ? await sonda.eval(`return [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`)
    : []
  // il submit del modulo NON offre il grant di sito (copre navigazione e clic
  // non di conferma, mai le conferme): turno, sempre a <bot> e — in squadra —
  // la missione, le STESSE scelte della chat (modello unico A1)
  check('A1: «Altre scelte ▾» nel centro apre il menu del modello unico (turno, sempre a <bot>, missione)',
    menuAperto && menuItems.some((x) => x.includes('Per questo turno')) && menuItems.some((x) => x.includes('Consenti sempre a Alloggio')) && menuItems.some((x) => x.includes('Consenti per questa missione')),
    JSON.stringify(menuItems))
  // si chiude senza decidere (il tasto Esc)
  await sonda.tasto({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => undefined)
  // (era sleep(400)) si aspetta che il menu sia DAVVERO chiuso
  await sonda.attendi(`document.querySelectorAll('[role="menuitem"]').length === 0`, { entro: 3_000, motivo: 'il menu chiuso con Esc' }).catch(() => undefined)

  // =========== 8. «Rimanda» (solo la vista: il conteggio resta 5) ===========
  check('«Rimanda» toglie LA richiesta dalla vista', await clickInCard('Archivio', 'approval-snooze') &&
    await sonda.attendi(`![...document.querySelectorAll('[data-testid="approvals-center-card"]')].some((c) => c.textContent.includes('Archivio'))`, { entro: 5_000, motivo: 'la card di Archivio via dalla vista' }).catch(() => false))
  check('«Rimanda» è solo vista: la barra conta ancora 5', await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, { entro: 5_000, motivo: 'la barra conta ancora 5' }).catch(() => false))

  // =========== 4/5. la decisione dal centro sblocca il turno e chiude la card ===========
  check('si decide dal centro: «Consenti una volta» sulla card di Turismo', await clickInCard('Turismo', 'approval-allow-once'))
  const sbloccato = await sonda.attendi(`(await window.sandbot.getEntries(${JSON.stringify(turismo.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('Modulo del museo compilato'))`, { entro: 90_000, passo: 500, motivo: 'il turno di Turismo si sblocchi' }).catch(() => false)
  check('la decisione dal centro SBLLOCA il turno del bot', sbloccato)
  const cardDecisa = await sonda.attendi(`(await window.sandbot.getEntries(${JSON.stringify(turismo.id)})).some((e) => e.meta?.approvalId && e.meta?.status === 'allowed')`, { entro: 30_000, passo: 500, motivo: 'la card passi a decisa' }).catch(() => false)
  check('la card nella chat del bot è passata a decisa (allowed)', cardDecisa)
  check('il conteggio della barra scende a 4', await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('4')`, { entro: 15_000, passo: 500, motivo: 'la barra scenda a 4' }).catch(() => false))

  // =========== A3: la richiesta del bot aperto sta SOPRA il campo di scrittura ===========
  if (!(await selectBot('Alloggio'))) throw new Error('selezione di Alloggio non riuscita')
  const composerBox = await sonda.attendi(`!!document.querySelector('[data-testid="composer-approval"]')`, { entro: 5_000, motivo: 'il riquadro sopra il campo' }).catch(() => false)
  const composerText = composerBox ? await sonda.eval(`return document.querySelector('[data-testid="composer-approval"]').textContent`) : ''
  check('A3: la richiesta di Alloggio sta nel riquadro SOPRA il campo (frase + Consenti/Rifiuta/Altre scelte)',
    composerBox && composerText.includes('Alloggio') && composerText.includes('vuole') && composerText.includes('Consenti') && composerText.includes('Rifiuta') && composerText.includes('Altre scelte'),
    String(composerText).slice(0, 160))
  // R1 (fase ritocchi-beta18): una richiesta, un posto solo — il difetto
  // della cattura 1 era DUE «Consenti» (card + riquadro) con testi diversi
  const consentiInChat = await sonda.eval(`return [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Consenti').length`).catch(() => -1)
  check('R1: nella chat del bot UN solo bottone «Consenti» (la card pendente è compatta)', consentiInChat === 1, `${consentiInChat} Consenti`)
  const compatta = await sonda.attendi(`!!document.querySelector('[data-testid="approval-compact-row"]')`, { entro: 5_000, motivo: 'la riga compatta' }).catch(() => false)
  const compattaText = compatta ? await sonda.eval(`return document.querySelector('[data-testid="approval-compact-row"]').textContent`) : ''
  check('R1: la riga compatta nei messaggi («In attesa della tua scelta · qui sotto»)',
    compatta && compattaText.includes('In attesa della tua scelta') && compattaText.includes('qui sotto'), String(compattaText).slice(0, 80))
  check('R1: il riquadro NON mostra la stringa grezza dello strumento (caso browser_type con submit)',
    composerBox && !composerText.includes('browser_type') && composerText.includes('vuole usare Azioni nel browser del bot'),
    String(composerText).slice(0, 160))
  check('A3: il campo di scrittura resta usabile, con la richiesta in attesa',
    await sonda.attendi(`!!document.querySelector('form textarea') && !!document.querySelector('[data-testid="composer-approval"]')`, { entro: 5_000, motivo: 'campo e riquadro insieme' }).catch(() => false))
  const bannerAltrove = await sonda.eval(`return document.querySelector('[data-testid="approvals-banner"]')?.textContent ?? ''`)
  // Archivio è «Rimandata» (solo vista): nel riquadro ridotto contano le
  // ALTRE visibili — Solleciti e Ricerche
  check('A3: in cima solo «+2 altrove» (le altre visibili sono di altri bot)', bannerAltrove.includes('+2 altrove') && !bannerAltrove.includes('modulo di verifica'), bannerAltrove.slice(0, 120))
  await shot2('1-chat-richiesta-sopra-il-campo.png')
  await shot3('1-chat-riga-compatta-e-riquadro.png')

  // =========== A1+A2: «Consenti sempre a Alloggio» DAL CAMPO → la grant, il registro la dice ===========
  // R1: il menu del riquadro è quello del PEZZO UNICO (approval-altre-scelte,
  // le stesse voci della card e del centro)
  const menuComposer = await openMenu('approval-altre-scelte')
  const vociComposer = menuComposer
    ? await sonda.eval(`return [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`)
    : []
  check('A1: il menu del riquadro sopra il campo offre le STESSE scelte (turno, sempre a Alloggio, missione)',
    menuComposer && vociComposer.some((x) => x.includes('Consenti sempre a Alloggio')) && vociComposer.some((x) => x.includes('Per questo turno')) && vociComposer.some((x) => x.includes('Consenti per questa missione')),
    JSON.stringify(vociComposer))
  check('A1: la scelta «sempre» dal riquadro decide (il conteggio scende a 3)', await clickMenuItem('approval-choice-always') &&
    await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('3')`, { entro: 30_000, passo: 500, motivo: 'la barra scenda a 3' }).catch(() => false))
  const grantsDopo = await sonda.rpc(`grantsList()`)
  check('A2: la grant è NATA (Consentiti sempre la conterrà)', (grantsDopo ?? []).length === 1, JSON.stringify(grantsDopo)?.slice(0, 140))

  // =========== A2: il REGISTRO nel centro ===========
  check('A2: il centro si riapre', await clickTestid('sidebar-approvals') &&
    await sonda.attendi(`!!document.querySelector('[data-testid="approvals-center"]')`, { entro: 5_000, motivo: 'il centro riaperto' }).catch(() => false))
  check('A2: le schede «Richieste | Registro»', await sonda.attendi(`!!document.querySelector('[data-testid="approvals-tab-registro"]')`, { entro: 5_000, motivo: 'la scheda Registro' }).catch(() => false))
  check('A2: «Registro di oggi» (in fondo alle richieste) apre il Registro', await clickTestid('approvals-open-registro') &&
    await sonda.attendi(`!!document.querySelector('[data-testid="approvals-registro"]')`, { entro: 5_000, motivo: 'il Registro aperto' }).catch(() => false))
  // (era sleep(600)) le righe delle decisioni entrano in un attimo: si
  // aspetta che il pannello sia FERMO, poi si legge il testo
  await sonda.attendiStabile('[data-testid="approvals-registro"]', { entro: 4_000 }).catch(() => undefined)
  // C3 (fase linguaggio): i filtri del registro stanno nella BARRA del centro (approvals-filters), non più nel corpo
  const registroText = await sonda.eval(`return document.querySelector('[data-testid="approvals-registro"]')?.textContent ?? ''`)
  const barraFiltriText = await sonda.eval(`return document.querySelector('[data-testid="approvals-filters"]')?.textContent ?? ''`)
  check('A2: le decisioni complete — chi, scelta, da dove (Rifiutato dal centro, Consentito sempre dalla chat)',
    registroText.includes('Rifiutato') && registroText.includes('dal centro') && registroText.includes('Consentito sempre') && registroText.includes('dalla chat'),
    registroText.slice(0, 260))
  // i filtri con le righe (come il centro: gli a zero restano nascosti —
  // Scadute e Passate da sole nascono quando succedono, i loro modelli sono
  // nei test)
  check('A2: i filtri del registro (Approvate · N, Rifiutate · 1)',
    barraFiltriText.includes('Approvate') && barraFiltriText.includes('Rifiutate'),
    registroText.slice(0, 160))
  // «Consentiti sempre» con Revoca
  const grantsSez = await sonda.attendi(`!!document.querySelector('[data-testid="approvals-registro-grants"]')`, { entro: 5_000, motivo: 'la sezione Consentiti sempre' }).catch(() => false)
  const grantsText = grantsSez ? await sonda.eval(`return document.querySelector('[data-testid="approvals-registro-grants"]').textContent`) : ''
  check('A2: «Consentiti sempre» elenca la grant di Alloggio con Revoca',
    grantsSez && grantsText.includes('Alloggio') && grantsText.includes('Revoca'), grantsText.slice(0, 160))
  await shot2('2-centro-registro.png')
  check('A2: Revoca cancella la grant', await clickTestid('grant-revoke') &&
    await sonda.attendi(`(await window.sandbot.grantsList()).length === 0`, { entro: 10_000, passo: 500, motivo: 'la grant sia cancellata' }).catch(() => false))

  // =========== A2: revocata, il GATE chiede di nuovo — con DUE richieste dello stesso bot ===========
  if (!(await selectBot('Alloggio'))) throw new Error('selezione di Alloggio non riuscita (2)')
  // R1: PRIMA l'aiutante di Alloggio (il suo turno COMPLETA e la richiesta
  // resta in attesa contando per il bot aperto), POI la verifica che si
  // blocca sul submit: due richieste dello stesso bot nel riquadro
  await sendMessage('figlio-alloggio: lancia l\'aiutante per il controllo della camera e aspetta il suo permesso')
  const figliaInAttesa = await sonda.attendi(
    `(await window.sandbot.approvalsPendingAll()).some((r) => r.botId === ${JSON.stringify(alloggio.id)} && r.fromSubagent === true)`,
    { entro: 90_000, passo: 500, motivo: 'la richiesta dell\'aiutante di Alloggio' }).catch(() => false)
  check('R1: la richiesta dell\'aiutante di Alloggio è in attesa (conta per il bot aperto)', figliaInAttesa)
  await sendMessage('verifica-alloggio-2: scrivi di nuovo la mia email nel modulo (https://spa.example/prenota) e invialo')
  check('A2: revocata la grant, la STESSA azione torna a chiedere (+ l\'aiutante: conteggio a 5)',
    await sonda.attendi(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, { entro: 90_000, passo: 500, motivo: 'il conteggio torni a 5' }).catch(() => false),
    (await sonda.eval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))

  // =========== R1: il riquadro «1 di 2» con le frecce; decidere la prima mostra la seconda ===========
  const boxCount = await sonda.attendi(`!!document.querySelector('[data-testid="composer-approval-count"]')`, { entro: 10_000, motivo: 'il riquadro con il conteggio' }).catch(() => false)
  const stepText = boxCount ? await sonda.eval(`return document.querySelector('[data-testid="composer-approval-step"]').textContent`) : ''
  const cardText1 = boxCount ? await sonda.eval(`return document.querySelector('[data-testid="composer-approval-card"]').textContent`) : ''
  check('R1: due richieste dello stesso bot → «1 di 2» con le frecce, prima la più urgente (l\'aiutante, il più vecchio)',
    boxCount && stepText.includes('1 di 2') && cardText1.includes('tramite un sottoagente') && cardText1.includes('vuole eseguire un comando'),
    `${String(stepText).trim()} · ${String(cardText1).slice(0, 100)}`)
  const consentiDue = await sonda.eval(`return [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Consenti').length`).catch(() => -1)
  check('R1: con due richieste dello stesso bot resta UN solo «Consenti»', consentiDue === 1, `${consentiDue} Consenti`)
  const compactTwo = await sonda.eval(`return document.querySelectorAll('[data-testid="approval-compact-row"]').length`).catch(() => -1)
  check('R1: TUTTE le richieste del bot aperto sono righe compatte nei messaggi', compactTwo === 2, `${compactTwo} righe compatte`)
  // la freccia passa alla seconda (il submit del modulo)
  const wentNext = await clickTestid('composer-approval-next')
  const step2 = wentNext && await sonda.attendi(
    `document.querySelector('[data-testid="composer-approval-step"]')?.textContent.includes('2 di 2') && document.querySelector('[data-testid="composer-approval-card"]').textContent.includes('Azioni nel browser del bot')`,
    { entro: 5_000, motivo: 'la seconda richiesta nel riquadro' }).catch(() => false)
  check('R1: la freccia passa alla seconda (il submit del modulo, senza stringa grezza)', step2)
  await shot3('2-riquadro-1-di-2.png')
  // decidere la PRIMA mostra la SECONDA: si torna alla prima e si consente
  const wentPrev = await clickTestid('composer-approval-prev')
  const step1back = wentPrev && await sonda.attendi(`document.querySelector('[data-testid="composer-approval-step"]')?.textContent.includes('1 di 2')`, { entro: 5_000, motivo: 'tornati alla prima richiesta' }).catch(() => false)
  const decidedFirst = step1back && await clickTestid('approval-allow')
  const showsSecond = decidedFirst && await sonda.attendi(
    `!document.querySelector('[data-testid="composer-approval-count"]') && document.querySelector('[data-testid="composer-approval-card"]') !== null && document.querySelector('[data-testid="composer-approval-card"]').textContent.includes('Azioni nel browser del bot')`,
    { entro: 15_000, motivo: 'la seconda richiesta dopo la decisione' }).catch(() => false)
  check('R1: decisa la prima, il riquadro mostra la SECONDA (niente più frecce né «di 2»)', showsSecond)

  // =========== 9. nessun «approva tutto» ===========
  const approveAll = await sonda.eval(`return [...document.querySelectorAll('button')].filter((b) => /approva tutto|approve all/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') ?? ''))).length`)
  check('NESSUN bottone «approva tutto» nel DOM', approveAll === 0, `${approveAll} trovati`)
} catch (e) {
  failed++
  log('DEBUG risposte servite:', JSON.stringify(served))
  log('ERRORE FATALE:', e instanceof Error ? e.message : e)
  log('--- coda log app ---\n' + sonda.appLog().slice(-3000))
  results.push({ name: 'corsa completa senza errori fatali', ok: false, detail: String(e) })
} finally {
  // ---- pulizia K4: app giù, daemon via, cartelle via, 0 processi (il motore) ----
  const fine = await sonda.fine({ porta: portaDebug })
  check('pulizia K4: 0 cartelle sandbot-fase-centro-* rimaste', fine.cartelleRimaste.length === 0 && fine.conteggio === 0, `${fine.cartelleRimaste.length} cartelle: ${fine.cartelleRimaste.join(', ')}`)
  check('I1: 0 connessioni verso i servizi LLM locali veri (il registro è vuoto)', fine.tentativiLocali.length === 0, messaggioTentativiLocali(fine.tentativiLocali))
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const llamas = execSync('pgrep -x llama-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter((pid) => !llamaBaseline.has(pid))
  check('pulizia K4: 0 llama-server nati con la corsa', llamas.length === 0, `baseline ${llamaBaseline.size}, nuovi ${llamas.length}`)
  if (failed > 0) log('risposte servite (diagnostica):', JSON.stringify(served))
  await new Promise((r) => providerServer.close(r))
}

log(`CORSA r${run}: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
