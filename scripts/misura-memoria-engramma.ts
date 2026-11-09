// Fase memoria-engramma (M9): i numeri su un utente vero SIMULATO — 1 000
// memorie a file (fase 4) da migrare e 5 000 messaggi di conversazione da
// indicizzare nella cella storia. Gli STESSI moduli del demone
// (migrateLegacyMemories, backfillStory), il motore VERO da vendor/engramma,
// una cartella dati temporanea (mai quella vera). Senza modello: la misura
// del motore senza download (testo+grafo), come al primo avvio.
//
// Uso: npx tsx scripts/misura-memoria-engramma.ts
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

register(new URL('./lib/lingui-macro-hook.mjs', import.meta.url))
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-misura-memoria-')
const DATA = join(TMP, 'data')
const { setDataDir, createAgent, appendEntry } = await import('../src/main/store/db')
setDataDir(DATA)
const { openMemoryEngine, closeMemoryEngine, memoryEngine } = await import('../src/main/memory/engine')
const { migrateLegacyMemories } = await import('../src/main/memory/migrate')
const { backfillStory } = await import('../src/main/memory/history-store')
const { serializeMemory } = await import('../src/main/agent/memory')

const WORDS = 'progetto cliente riunione report fattura viaggio treno Milano Roma budget lunedì martedì preferenza caffè tè vegetariano palestra libro film musica scadenza contratto avvocato medico dentista banca mutuo assicurazione auto bici gatto cane figlio scuola compleanno regalo ristorante pizza sushi'.split(' ')
const sentence = (i: number, n = 14): string => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 13) % WORDS.length]).join(' ') + ` numero ${i}`

// 5 bot, 1000 memorie: 800 dei bot (160 a testa), 200 condivise
const agents = Array.from({ length: 5 }, (_, i) => createAgent(`Bot ${i + 1}`))
let n = 0
for (const a of agents) {
  const dir = join(DATA, 'agents', a.id, 'memory')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 160; i++, n++) {
    writeFileSync(join(dir, `mem_${n.toString(16).padStart(12, '0')}.md`), serializeMemory({
      id: `mem_${n.toString(16).padStart(12, '0')}`, content: sentence(n), tier: i % 5 === 0 ? 'core' : 'log',
      scope: 'agent', source: i % 3 === 0 ? 'user' : 'agent', createdAt: 1700000000000 + n * 60_000, updatedAt: 1700000000000 + n * 60_000
    }))
  }
}
const userDir = join(DATA, 'user', 'memory')
mkdirSync(userDir, { recursive: true })
for (let i = 0; i < 200; i++, n++) {
  writeFileSync(join(userDir, `mem_${n.toString(16).padStart(12, '0')}.md`), serializeMemory({
    id: `mem_${n.toString(16).padStart(12, '0')}`, content: sentence(n), tier: i % 4 === 0 ? 'core' : 'log',
    scope: 'user', source: 'user', createdAt: 1700000000000 + n * 60_000, updatedAt: 1700000000000 + n * 60_000
  }))
}

// 5000 messaggi: 2500 dell'utente e 2500 risposte finali, con rumore (tool) in mezzo
let m = 0
for (let i = 0; i < 2500; i++) {
  const a = agents[i % agents.length]!
  appendEntry({ agentId: a.id, kind: 'message', role: 'user', content: sentence(100_000 + m++, 18) })
  appendEntry({ agentId: a.id, kind: 'tool-result', role: 'system', content: 'risultato di un tool che NON entra nella storia' })
  appendEntry({ agentId: a.id, kind: 'send-message', role: 'assistant', content: sentence(100_000 + m++, 22), meta: { final: true } })
}

const st = await openMemoryEngine({ dataDir: DATA })
if (!st.available) throw new Error('motore non disponibile: ' + st.error)
const t0 = Date.now()
const mig = await migrateLegacyMemories(agents.map((a) => a.id))
const migMs = Date.now() - t0
const t1 = Date.now()
const story = await backfillStory(agents.map((a) => a.id))
const storyMs = Date.now() - t1
// una ricerca come quella del bot (correzioni C2: la storia per bot, il
// default è il bot che parla)
const engine = await memoryEngine()
const tq = Date.now()
const hits = await engine.search([`storia-${agents[0]!.id}`], { text: 'treno per Milano martedì', k: 10, mode: 'text', graphHops: 1 })
const searchMs = Date.now() - tq
await closeMemoryEngine()
console.log(JSON.stringify({
  memorie: { file: 1000, migrate: mig.migrated, avvisi: mig.warnings.length, ms: migMs },
  storia: { messaggi: 5000, indicizzati: story.indexed, ms: storyMs },
  ricerca_storia_ms: searchMs, hit: hits.length
}, null, 2))
rmSync(TMP, { recursive: true, force: true })
