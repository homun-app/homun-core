#!/usr/bin/env node
// Sonda della fase isolamento-locale (I2) — LA PULIZIA CONTA SOLO I LLAMA-SERVER
// DELLA CORSA. App VERA (out/, serve `npm run build` prima) su dati temporanei
// col motore comune (scripts/lib/sonda.mjs), come le altre sonde; nessun
// modello, nessun container, rete solo su 127.0.0.1. L'Ollama dell'utente
// non si tocca: non si accende, non si spegne, non si chiama.
//
// Il controllo di pulizia «0 llama-server nati con la corsa» contava TUTTI i
// llama-server del Mac (pgrep -x llama-server) meno quelli già in corsa
// all'inizio della sonda: un llama-server nato FUORI dalla corsa — per
// esempio il runner con cui l'Ollama dell'utente carica un modello mentre la
// sonda gira — era rosso per la sonda, che non c'entrava nulla (capitato
// nella corsa di fatto.mjs della fase linguaggio-ritocchi: «baseline 0,
// nuovi 1»). Ora un llama-server è della corsa in due modi (sonda.mjs):
// discende dall'app o da un daemon della sonda, oppure ha negli argomenti la
// radice della corsa o la HOME finta.
//
// I finti sono script node con quel nome di processo (il lanciatore è un
// link a node chiamato «llama-server»), su 127.0.0.1 porta 0, e vivono in una
// cartella FUORI dalla corsa. Due corse, come dice la spec:
//   1. un finto llama-server FUORI dalla corsa, vivo durante la sonda: il
//      VECCHIO controllo lo conta (è il rosso di prima, riprodotto qui), il
//      nuovo no;
//   2. un finto llama-server avviato dal DAEMON FINTO della corsa e lasciato
//      vivo — senza la radice negli argomenti, così lo prende SOLO la catena
//      dei padri — più uno con la radice negli argomenti: il nuovo controllo
//      prende entrambi e non quello fuori. È il caso che K4 deve vedere.
//
// A fine sonda: 0 finti vivi, la cartella dei finti cancellata, 0 cartelle
// sandbot-fase-isolamento-*, 0 processi. Se la sonda muore di colpo (SIGKILL)
// i finti se ne accorgono — controllano che la sonda sia viva — e spariscono
// da soli, con la cartella.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  avviaSonda, TMP_BASE, messaggioTentativiLocali, messaggioLlamaServer,
  fotografaLlamaServerDellaCorsa, llamaServerDellaCorsa
} from './lib/sonda.mjs'
import { findProbeDaemons } from './lib/probe-daemons.mjs'

const PREFIX = 'sandbot-fase-isolamento'
const T0 = Date.now()
const log = (...a) => console.log(`[${PREFIX}]`, `+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a)

let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  if (!ok) failed++
  log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const vivo = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** La riga di un processo — pid, padre e argomenti — come la legge il controllo di pulizia. */
const rigaDi = (pid) => {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  for (const riga of (out.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(riga)
    if (m && Number(m[1]) === pid) return { ppid: Number(m[2]), comando: m[3] }
  }
  return null
}

/** Il VECCHIO controllo, parola per parola: TUTTI i llama-server del Mac (nessuna base sottratta: la tiene chi lo usa). */
const pidiLlamaServer = () => {
  const out = spawnSync('/usr/bin/pgrep', ['-x', 'llama-server'], { encoding: 'utf8' })
  return (out.stdout ?? '').split('\n').filter(Boolean).map(Number).filter((p) => Number.isInteger(p) && p > 1)
}

const spegni = async (pid) => {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (!vivo(pid)) break
    try { process.kill(pid, sig) } catch { /* appena uscito */ }
    for (let i = 0; i < 30 && vivo(pid); i++) await sleep(100)
  }
  return !vivo(pid)
}

// ---- i FINTI: sorgenti scritti nella cartella dei finti al momento dell'avvio ----
// La configurazione passa dall'AMBIENTE (FINTO_*), non dagli argomenti: così
// gli argomenti restano quelli del finto e nessuno contiene la radice della
// corsa per sbaglio. FINTO_PADRONE è il pid della sonda.
const FINTO_LLAMA_SRC = `
// un finto llama-server: node, con quel nome di processo, su 127.0.0.1 porta 0
import { createServer } from 'node:http'
import { writeFileSync, rmSync } from 'node:fs'
const srv = createServer((req, res) => { res.writeHead(404); res.end() })
srv.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.FINTO_FILE_PORTA, JSON.stringify({ pid: process.pid, porta: srv.address().port }))
})
// senza la sonda (morta, anche di colpo) si spegne da solo e porta via la cartella dei finti
setInterval(() => {
  try { process.kill(Number(process.env.FINTO_PADRONE), 0) } catch {
    try { rmSync(process.env.FINTO_DIR, { recursive: true, force: true }) } catch { /* meglio possibile */ }
    process.exit(0)
  }
}, 500)
`

const FINTO_DAEMON_SRC = `
// un daemon FINTO della corsa: --homun-daemon negli argomenti e i dati della corsa
// nell'ambiente — findProbeDaemons lo trova come trova quello vero
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const srv = createServer((req, res) => { res.writeHead(404); res.end() })
srv.listen(0, '127.0.0.1', () => {
  // il llama-server parte come lo partirebbe il daemon vero, ma SENZA la radice
  // della corsa negli argomenti: lo prende solo la catena dei padri. Alla
  // SIGTERM il daemon esce e lo lascia vivo.
  spawn(join(process.env.FINTO_DIR, 'llama-server'), [join(process.env.FINTO_DIR, 'llama-server-finto.mjs')], {
    env: { PATH: process.env.PATH, FINTO_PADRONE: process.env.FINTO_PADRONE, FINTO_FILE_PORTA: process.env.FINTO_FILE_PORTA, FINTO_DIR: process.env.FINTO_DIR },
    stdio: 'ignore'
  })
})
`

/**
 * La cartella dei finti: mkdtemp nella base dei vincoli, con un ALTRO
 * prefisso da quello della corsa (la pulizia della corsa — e il suo conteggio
 * delle cartelle — guarda quelle col prefisso della sonda), con dentro il
 * lanciatore «llama-server» (un link a node) e i due sorgenti.
 */
const preparaFinti = () => {
  const dir = mkdtempSync(`${TMP_BASE}/sandbot-isolamento-finti-`)
  symlinkSync(process.execPath, join(dir, 'llama-server'))
  writeFileSync(join(dir, 'llama-server-finto.mjs'), FINTO_LLAMA_SRC)
  writeFileSync(join(dir, 'daemon-finto.mjs'), FINTO_DAEMON_SRC)
  return dir
}

/** L'ambiente dei finti; `filePorta` è il percorso INTERO del file in cui il finto scrive la sua porta. */
const ambienteFinti = (dir, filePorta) => ({
  PATH: process.env.PATH, FINTO_PADRONE: String(process.pid), FINTO_FILE_PORTA: filePorta, FINTO_DIR: dir
})

/** Un finto llama-server: `args` sono i SUOI argomenti (il nome del modello, per la seconda regola). */
const avviaFintoLlama = (dir, filePorta, args = []) =>
  spawn(join(dir, 'llama-server'), [join(dir, 'llama-server-finto.mjs'), ...args], { cwd: dir, env: ambienteFinti(dir, filePorta), stdio: 'ignore' })

/** Un daemon finto della corsa: --homun-daemon negli argomenti, i dati della corsa nell'ambiente. Il llama-server lo scrive in `filePorta`. */
const avviaDaemonFinto = (dir, data, filePorta) =>
  spawn(process.execPath, [join(dir, 'daemon-finto.mjs'), '--', '--homun-daemon'], {
    cwd: dir, env: { ...ambienteFinti(dir, filePorta), SANDBOT_TEST_USER_DATA: data }, stdio: 'ignore'
  })

/** Aspetta che un finto abbia scritto la sua porta (tetto 10 s): { pid, porta }. */
const aspettaFinto = async (file, cosa) => {
  const limite = Date.now() + 10_000
  while (Date.now() < limite) {
    if (existsSync(file)) {
      try {
        const letto = JSON.parse(readFileSync(file, 'utf8'))
        if (Number.isInteger(letto.pid) && Number.isInteger(letto.porta) && letto.porta > 0) return letto
      } catch { /* scritto a metà: si riprova */ }
    }
    await sleep(100)
  }
  throw new Error(`${cosa} non ha scritto la sua porta entro 10 s`)
}

/** I finti avviati dalla sonda in tutte le corse: a fine sonda devono essere tutti spenti. */
const fintiAvviati = []

/**
 * Una corsa: l'app vera del motore, i finti, la fine della corsa (`fine()`:
 * app e daemon spenti, cartelle cancellate) e i controlli — prima e dopo.
 * `daemonFinto`: se avviare anche il daemon finto della corsa (corsa 2).
 */
const corsa = async ({ titolo, daemonFinto }) => {
  log(`—— corsa «${titolo}» ——`)
  const s = await avviaSonda({ prefix: PREFIX, log })
  const dir = preparaFinti()
  const daSpegnere = []   // i finti, in ordine di avvio: a fine corsa si spengono al contrario
  try {
    await s.avvia()
    // la base del VECCHIO controllo: i llama-server già in corsa (letta prima dei finti)
    const base = new Set(pidiLlamaServer())

    // ---- un finto llama-server FUORI dalla corsa: lo avvia la sonda, non l'app ----
    const fileFuori = join(dir, 'porta-fuori.json')
    const fuori = avviaFintoLlama(dir, fileFuori)
    daSpegnere.push(fuori.pid)
    fintiAvviati.push(fuori.pid)
    const infoFuori = await aspettaFinto(fileFuori, 'il finto llama-server fuori dalla corsa')
    check('il finto llama-server FUORI dalla corsa è vivo durante la corsa — node con quel nome di processo, su porta 0 scelta dal sistema',
      pidiLlamaServer().includes(infoFuori.pid) && infoFuori.pid === fuori.pid,
      `pid ${infoFuori.pid}, porta ${infoFuori.porta}, llama-server del Mac: ${pidiLlamaServer().length} (base ${base.size})`)
    const rigaFuori = rigaDi(infoFuori.pid)
    check('… e non è della corsa: non discende dall\'app né da un daemon della sonda, e nei suoi argomenti non ci sono la radice della corsa né la HOME finta',
      rigaFuori !== null && rigaFuori.ppid === process.pid && !rigaFuori.comando.includes(s.tmp) && !rigaFuori.comando.includes(s.home),
      `padre ${rigaFuori?.ppid} (la sonda, pid ${process.pid}); app ${s.pid}; daemon della sonda: ${findProbeDaemons(PREFIX).map((d) => d.pid).join(', ') || 'nessuno'}`)
    const prima = llamaServerDellaCorsa({ prefix: PREFIX, radice: s.tmp, home: s.home, pidApp: s.pid })
    check('prima dello spegnimento il controllo nuovo non conta quello fuori dalla corsa',
      prima.length === 0, messaggioLlamaServer(prima) || 'nessun llama-server della corsa')

    let daemon = null
    let infoDalDaemon = null
    let infoConRadice = null
    if (daemonFinto) {
      // ---- il daemon FINTO della corsa avvia il suo llama-server e lo lascia vivo ----
      const fileDaemon = join(dir, 'porta-dal-daemon.json')
      daemon = avviaDaemonFinto(dir, s.data, fileDaemon)
      daSpegnere.push(daemon.pid)
      infoDalDaemon = await aspettaFinto(fileDaemon, 'il llama-server del daemon finto')
      daSpegnere.push(infoDalDaemon.pid)
      fintiAvviati.push(infoDalDaemon.pid)
      const trovati = findProbeDaemons(PREFIX).map((d) => d.pid)
      check('il daemon FINTO della corsa è un daemon della sonda (findProbeDaemons: --homun-daemon negli argomenti, i dati della corsa nell\'ambiente)',
        trovati.includes(daemon.pid), `daemon trovati: ${trovati.join(', ') || 'nessuno'}; il finto è ${daemon.pid}`)
      const rigaDalDaemon = rigaDi(infoDalDaemon.pid)
      check('il suo llama-server è vivo, con quel nome di processo, e nei suoi argomenti non ci sono né la radice della corsa né la HOME finta',
        pidiLlamaServer().includes(infoDalDaemon.pid) && rigaDalDaemon !== null && rigaDalDaemon.ppid === daemon.pid && !rigaDalDaemon.comando.includes(s.tmp) && !rigaDalDaemon.comando.includes(s.home),
        `pid ${infoDalDaemon.pid}, porta ${infoDalDaemon.porta}, padre ${rigaDalDaemon?.ppid}`)

      // ---- un finto con la radice della corsa negli argomenti: lo avvia la sonda ----
      const fileRadice = join(dir, 'porta-con-radice.json')
      const conRadice = avviaFintoLlama(dir, fileRadice, ['--model', join(s.tmp, 'modelli', 'finto.gguf')])
      daSpegnere.push(conRadice.pid)
      fintiAvviati.push(conRadice.pid)
      infoConRadice = await aspettaFinto(fileRadice, 'il finto llama-server con la radice negli argomenti')

      const vivoOra = llamaServerDellaCorsa({ prefix: PREFIX, radice: s.tmp, home: s.home, pidApp: s.pid })
      const dalDaemon = vivoOra.find((l) => l.pid === infoDalDaemon.pid)
      check('prima dello spegnimento il controllo nuovo conta quello del daemon della corsa: discende da lui',
        dalDaemon?.perche === 'discendente' && dalDaemon.da === daemon.pid, messaggioLlamaServer(vivoOra))
      check('… e quello con la radice della corsa negli argomenti (seconda regola), anche se non discende da nessuno della corsa',
        vivoOra.some((l) => l.pid === infoConRadice.pid && l.perche === 'argomenti'), `pid ${infoConRadice.pid}`)
      check('… e non quello fuori dalla corsa, nemmeno adesso',
        !vivoOra.some((l) => l.pid === infoFuori.pid), messaggioLlamaServer(vivoOra))
    }

    // ---- la fine della corsa: la fotografia la scatta fine() per primo ----
    // (qui la scatta anche la sonda, un istante prima, come fanno le sonde senza motore)
    const fotografia = fotografaLlamaServerDellaCorsa({ prefix: PREFIX, radice: s.tmp, home: s.home, pidApp: s.pid })
    const fine = await s.fine()

    // il VECCHIO controllo, dopo la corsa: tutti i llama-server del Mac meno la base
    const vecchi = pidiLlamaServer().filter((pid) => !base.has(pid))
    if (!daemonFinto) {
      check('il VECCHIO controllo lo contava: tutti i llama-server del Mac meno la base d\'inizio',
        vecchi.includes(infoFuori.pid), `baseline ${base.size}, nuovi ${vecchi.length}`)
      check('I2 — fuori dalla corsa: il controllo nuovo NON lo conta (la corsa non l\'ha mai avviato)',
        fine.llamaDellaCorsa.length === 0, messaggioLlamaServer(fine.llamaDellaCorsa) || 'nessun llama-server della corsa')
      check('il finto fuori dalla corsa è ancora VIVO a corsa finita: la pulizia della corsa non l\'ha toccato',
        vivo(infoFuori.pid) && pidiLlamaServer().includes(infoFuori.pid), `pid ${infoFuori.pid}`)
    } else {
      check('fine() ha chiuso il daemon finto della corsa',
        !vivo(daemon.pid), `pid ${daemon.pid}`)
      const rigaOrfano = rigaDi(infoDalDaemon.pid)
      check('il suo llama-server è rimasto VIVO, orfano (il padre uscito): la catena dei padri non lo dice più',
        vivo(infoDalDaemon.pid) && rigaOrfano !== null && rigaOrfano.ppid === 1 && !vivo(daemon.pid),
        `pid ${infoDalDaemon.pid}, padre ${rigaOrfano?.ppid}`)
      check('I2 — il caso che K4 deve vedere: il controllo nuovo PRENDE il llama-server lasciato vivo dal daemon della corsa',
        fine.llamaDellaCorsa.some((l) => l.pid === infoDalDaemon.pid), messaggioLlamaServer(fine.llamaDellaCorsa))
      check('I2 — e prende quello con la radice della corsa negli argomenti',
        fine.llamaDellaCorsa.some((l) => l.pid === infoConRadice.pid && l.perche === 'argomenti'), messaggioLlamaServer(fine.llamaDellaCorsa))
      check('I2 — e NON conta quello fuori dalla corsa',
        !fine.llamaDellaCorsa.some((l) => l.pid === infoFuori.pid), messaggioLlamaServer(fine.llamaDellaCorsa))
      // la regola di K4, parola per parola come la usano le sonde: qui è ROSSA, e il rosso dice chi
      check('la regola K4 («0 llama-server della corsa rimasti vivi») qui è ROSSA — è il caso che deve vedere',
        fine.llamaDellaCorsa.length !== 0, `KO pulizia K4: 0 llama-server della corsa rimasti vivi — ${messaggioLlamaServer(fine.llamaDellaCorsa)}`)
      // le sonde che non usano il motore chiamano le due funzioni da sole — la fotografia prima
      // dello spegnimento, l'elenco dopo — e devono trovare le stesse cose di fine()
      const daSole = llamaServerDellaCorsa({ prefix: PREFIX, radice: s.tmp, home: s.home, fotografia })
      check('le funzioni da sole (come le usano le sonde senza motore) danno lo stesso elenco di fine()',
        JSON.stringify(daSole.map((l) => [l.pid, l.perche])) === JSON.stringify(fine.llamaDellaCorsa.map((l) => [l.pid, l.perche])),
        `da sole: ${messaggioLlamaServer(daSole) || 'nessuno'}`)
    }
    check('I1: 0 connessioni verso i servizi LLM locali veri (il registro è vuoto)',
      fine.tentativiLocali.length === 0, messaggioTentativiLocali(fine.tentativiLocali))
    check(`pulizia: 0 cartelle ${PREFIX}-* rimaste`, fine.cartelleRimaste.length === 0 && fine.conteggio === 0, `${fine.cartelleRimaste.length} cartelle: ${fine.cartelleRimaste.join(', ')}`)
    check('pulizia: 0 daemon della sonda', findProbeDaemons(PREFIX).length === 0, `${findProbeDaemons(PREFIX).length} trovati`)
  } finally {
    // i finti della sonda si spengono al contrario (prima i figli, poi i padri), e la cartella va via
    for (const pid of daSpegnere.reverse()) await spegni(pid)
    rmSync(dir, { recursive: true, force: true })
  }
}

await corsa({ titolo: 'un llama-server fuori dalla corsa', daemonFinto: false })
await corsa({ titolo: 'un llama-server del daemon della corsa, lasciato vivo', daemonFinto: true })

const fintiVivi = fintiAvviati.filter(vivo)
const cartelleFinti = readdirSync(TMP_BASE).filter((n) => n.startsWith('sandbot-isolamento-finti-'))
check('pulizia: i finti sono tutti spenti e la cartella dei finti è cancellata',
  fintiVivi.length === 0 && cartelleFinti.length === 0,
  `finti avviati ${fintiAvviati.length}, vivi ${fintiVivi.length}; cartelle sandbot-isolamento-finti-* rimaste: ${cartelleFinti.length}`)

log(`CORSA: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
