// Fase token ritocchi (R5): il corpus FISSO contro i falsi positivi (e i veri
// positivi che non devono indebolirsi). Due tabelle — MUST_PASS e MUST_BLOCK —
// con tool, argomenti e testi della chat del turno; ogni riga passa per la
// sentinella PURA argGuardVerdict. Comprende la tabella dei falsi positivi
// della spec, i comandi comuni, gli URL con id lunghi e le bozze normali con
// numeri dentro. La quota: 2000 URL di tweet con id casuali da 19 cifre (a
// scala di Twitter: dal 2018 in poi sono tutte da 19 cifre), ZERO bloccati.
import { describe, expect, it } from 'vitest'
import { argGuardVerdict, luhnCardNumbers } from '../arg-guard'

/** una riga del corpus: il tool, i suoi argomenti, i testi scritti in chat */
interface Row {
  tool: string
  args: Record<string, unknown>
  chat?: string[]
  note?: string
}

/** i valori stringa di un argomento (ricorsivo, come la sentinella) */
function stringsOf(v: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap((x) => stringsOf(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).flatMap((x) => stringsOf(x, depth + 1))
  return []
}

/** DEVE passare: roba vera di tutti i giorni, senza segreti */
const MUST_PASS: Row[] = [
  // — la tabella dei falsi positivi della spec, parola per parola —
  { tool: 'run-command', args: { command: 'npm install task-runner' }, note: '«sk-» dentro task-runner' },
  { tool: 'run-command', args: { command: 'brew install disk-utility' } },
  { tool: 'run-command', args: { command: 'python peak_hours.py' }, note: '«ak_» dentro peak_hours' },
  { tool: 'web_fetch', args: { url: 'https://x.com/u/status/1926010112345678904' }, note: 'id da 19 cifre' },
  {
    tool: 'draft_external',
    args: { channel: 'email', to: 'amici@example.com', subject: 'Netflix', body: 'Ciao, il nostro account Netflix non va: lo sistemiamo insieme?' },
    chat: ['la password di Netflix non funziona più'],
    note: '«Netflix» non è un segreto assegnato'
  },
  {
    tool: 'web_fetch',
    args: { url: 'https://www.google.com/search?q=marketing' },
    chat: ['usa come parola chiave marketing'],
    note: '«chiave» da sola non conta'
  },
  // — comandi comuni —
  { tool: 'run-command', args: { command: 'npm install express@4.18.2 --save-dev' } },
  { tool: 'run-command', args: { command: 'pip install requests==2.31.0' } },
  { tool: 'run-command', args: { command: 'brew install wget' } },
  { tool: 'run-command', args: { command: 'git clone https://github.com/user/repo.git' } },
  { tool: 'run-command', args: { command: 'curl -s https://api.example.com/v1/items?id=1234567890123' }, note: 'id da 13 cifre nel comando' },
  { tool: 'run-command', args: { command: 'docker run --rm alpine:3.19 echo ciao' } },
  { tool: 'run-command', args: { command: 'ls ~/Desktop' } },
  { tool: 'run-command', args: { command: 'npm install ask-user-widget' } },
  { tool: 'run-command', args: { command: 'git log --oneline -20' } },
  { tool: 'run-command', args: { command: 'break_point a risk-free: tutto ok' } },
  // — URL con id lunghi —
  { tool: 'web_fetch', args: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } },
  { tool: 'web_fetch', args: { url: 'https://x.com/u/status/1234567890123456718?s=20' } },
  { tool: 'browser_open', args: { url: 'https://www.amazon.com/dp/B08N5WRWNW' } },
  { tool: 'web_fetch', args: { url: 'https://dashboard.stripe.com/customers/cus_NffrFeUfJ2Z38l4' } },
  { tool: 'web_fetch', args: { url: 'https://amzn.eu/d/0ABcDeF' } },
  { tool: 'web_fetch', args: { url: 'https://x.com/search?q=fase%20token&f=live' } },
  // — bozze normali con numeri dentro —
  { tool: 'draft_external', args: { channel: 'email', to: 'ufficio@example.com', subject: 'Fattura 2026/123', body: 'In allegato la fattura 2026/123 del 08/01/2026: ordine 87654321, CAP 20121. Grazie.' } },
  { tool: 'draft_external', args: { channel: 'email', to: 'ufficio@example.com', subject: 'Ordine', body: 'Per le ordinazioni chiamare +39 333 123 4567.' } },
  { tool: 'draft_external', args: { channel: 'email', to: 'contabilita@example.com', subject: 'Bonifico', body: 'IBAN per il bonifico: IT60X0542811101000000123456. Cordiali saluti.' } },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'l\'ordine 87654321 è spedito al CAP 20121, consegna entro il 12/06/2026' } },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'usa come parola chiave marketing nella ricerca' }, chat: ['usa come parola chiave marketing'] },
  { tool: 'browser_type', args: { ref: 'e3', text: 'via Roma 15, interno 3' } },
  { tool: 'browser_type', args: { ref: 'e3', text: 'la data di consegna che preferisco è 12/06/2026' }, chat: ['la password è sbagliata, riproviamo domani'] },
  { tool: 'browser_select', args: { ref: 'e7', values: ['Italia', 'Lombardia', 'Milano', '20121'] } },
  { tool: 'computer_act', args: { actions: [{ kind: 'type', text: 'Appuntamento alle 18:30, telefono +39 02 1234 5678' }] } },
  // — segreti annunciati in chat ma non assegnati —
  { tool: 'offer_connector', args: { id: 'gcal', reason: 'per sincronizzare il calendario del team' }, chat: ['il token di GitHub scade domani'] },
  { tool: 'fill_credential', args: { loginId: 'netflix', username_ref: 'e1' }, chat: ['ho dimenticato la password dell\'account'] },
  { tool: 'browser_type', args: { ref: 'e3', text: 'sbagliata' }, chat: ['la password è sbagliata'], note: 'parola comune, non un valore' },
  // — fase locale (L5): «chiave / key» da sola RESTA fuori quando il valore
  // non ha la forma di un token (il corpus di prima non cambia) —
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'la chiave del problema è il tempo' }, chat: ['la chiave del problema è il tempo'], note: 'L5 negativo: «tempo» non è un token' },
  { tool: 'browser_type', args: { ref: 'e3', text: 'la chiave inglese 12' }, chat: ['la chiave inglese 12'], note: 'L5 negativo: «12» non è un token' },
  { tool: 'draft_external', args: { channel: 'email', to: 'a@b.it', subject: 'Chiavi', body: 'la chiave del successo è la costanza' }, chat: ['la chiave del successo è la costanza'], note: 'L5 negativo: valore lungo ma senza cifre' }
]

/** DEVE essere rifiutato: carte, chiavi, segreti assegnati in chat */
const MUST_BLOCK: Row[] = [
  // — le carte, dove si digita —
  { tool: 'browser_type', args: { ref: 'e6', text: '4242 4242 4242 4242' }, note: 'Visa a gruppi di 4' },
  { tool: 'browser_type', args: { ref: 'e6', text: '4242-4242-4242-4242' }, note: 'Visa a trattini' },
  { tool: 'draft_external', args: { channel: 'email', to: 'a@b.it', subject: 'Pagamento', body: 'paga con 5555555555554444' }, note: 'Mastercard attaccata' },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'usa la carta 6011111111111117 per il rinnovo' }, note: 'Discover 6011' },
  { tool: 'browser_select', args: { ref: 'e7', values: ['3566002020360505'] }, note: 'JCB nei valori' },
  { tool: 'computer_act', args: { actions: [{ kind: 'type', text: 'carta 378282246310005' }] }, note: 'Amex nel testo digitato' },
  { tool: 'draft_external', args: { channel: 'email', to: 'a@b.it', subject: 'Rinnovo carta 2221000000000009', body: 'come da accordi' }, note: 'Mastercard 2-series nel subject' },
  { tool: 'browser_type', args: { ref: 'e6', text: '30569309025904' }, note: 'Diners a 14 cifre' },
  { tool: 'computer_act', args: { actions: [{ kind: 'click', x: 10, y: 20 }, { kind: 'type', text: '6500000000000002' }] }, note: 'Discover 65' },
  // — le chiavi col prefisso noto —
  { tool: 'web_fetch', args: { url: 'https://proxy.example/v1/chat?key=sk-proj-' + 'a1'.repeat(20) }, note: 'sk- con 40 caratteri e cifre' },
  { tool: 'run-command', args: { command: 'export GH_TOKEN=ghp_' + 'Ab1'.repeat(12) }, note: 'ghp_ con 36 caratteri' },
  { tool: 'offer_connector', args: { id: 'gcal', reason: 'collego con la chiave secret_abc123def456ghi7' } },
  { tool: 'add_mcp_server', args: { id: 'url:https://mcp.example/sse', reason: 'server col token xoxb-1a2b3c4d5e6f7g' } },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'usa il token ak_' + 'x9'.repeat(8) + ' per l\'api' } },
  // — i segreti assegnati in chat, finiti negli argomenti —
  { tool: 'browser_type', args: { ref: 'e5', text: 'Tigre!2026' }, chat: ['la mia password è Tigre!2026'] },
  { tool: 'browser_type', args: { ref: 'e5', text: 'hunter2x' }, chat: ['password: hunter2x'] },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'il codice per entrare è ab12cd34ef' }, chat: ['il token è ab12cd34ef'] },
  { tool: 'browser_type', args: { ref: 'e5', text: 'S3cret!!' }, chat: ['my password is S3cret!!'] },
  { tool: 'draft_external', args: { channel: 'email', to: 'a@b.it', subject: 'wifi', body: 'la rete di casa è Casa2026' }, chat: ['la password del wifi è Casa2026'] },
  { tool: 'fill_credential', args: { loginId: 'x', username_ref: 'e1', password: 'Tr4pp0la!92' }, chat: ['la mia password è Tr4pp0la!92'] },
  // — fase locale (L5): «chiave / key / api key / token» + valore a forma di
  // token (secretShaped, ≥ 8 caratteri, con cifre) — il caso 29 di L1:
  // «la mia chiave è secret_abc123» finita nel reason di offer_connector —
  { tool: 'offer_connector', args: { id: 'gcal', reason: 'collego con la chiave secret_abc123' }, chat: ['la mia chiave è secret_abc123'], note: 'L5: il caso 29 vero' },
  { tool: 'send_to_agent', args: { agentId: 'b1', text: 'my key is hf_K9m2xQ7a' }, chat: ['my key is hf_K9m2xQ7a'], note: 'L5: key inglese + is' },
  { tool: 'browser_type', args: { ref: 'e5', text: 'ab12cd34ef' }, chat: ['la mia api key è ab12cd34ef'], note: 'L5: api key + token a forma di token' },
  { tool: 'run-command', args: { command: 'echo sk_live_9f2kx71m' }, chat: ['la chiave: sk_live_9f2kx71m'], note: 'L5: chiave: con due punti' }
]

describe('fase token ritocchi (R5): il corpus fisso della sentinella', () => {
  it(`MUST_PASS: ${MUST_PASS.length} righe di vita vera passano tutte`, () => {
    expect(MUST_PASS.length).toBeGreaterThanOrEqual(30)
    for (const r of MUST_PASS) {
      const v = argGuardVerdict(r.tool, r.args, r.chat ?? [])
      expect(v.ok, `${r.tool} ${JSON.stringify(r.args)} ${r.note ?? ''}`).toBe(true)
    }
  })
  it(`MUST_BLOCK: ${MUST_BLOCK.length} righe con carte/chiavi/segreti sono rifiutate tutte`, () => {
    expect(MUST_BLOCK.length).toBeGreaterThanOrEqual(12)
    for (const r of MUST_BLOCK) {
      const v = argGuardVerdict(r.tool, r.args, r.chat ?? [])
      expect(v.ok, `${r.tool} ${JSON.stringify(r.args)} ${r.note ?? ''}`).toBe(false)
      // e il motivo non contiene MAI un valore degli argomenti (≥ 6 caratteri)
      if (!v.ok) {
        for (const s of stringsOf(r.args)) {
          if (s.length >= 6) expect(v.reason, `il motivo non deve contenere «${s}»`).not.toContain(s)
        }
      }
    }
  })

  it('quota: 2000 URL di tweet con id casuali da 19 cifre → 0 bloccati', () => {
    // generatore deterministico (LCG): id a scala di Twitter (epoch 1288834974657,
    // 22 bit di sequenza) in un'era in cui gli id sono tutti da 19 cifre
    // (giugno 2018 → novembre 2026): prime cifre 10–21, mai un IIN di carta
    let seed = 20261108
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const TW_EPOCH = 1288834974657n
    let blocked = 0
    for (let i = 0; i < 2000; i++) {
      const ms = 1528000000000 + Math.floor(rnd() * (1793000000000 - 1528000000000))
      const id = (((BigInt(ms) - TW_EPOCH) << 22n) + BigInt(Math.floor(rnd() * 4194304))).toString()
      expect(id, `l'id generato ${id} deve avere 19 cifre`).toHaveLength(19)
      const url = `https://x.com/u/status/${id}`
      // sulla sentinella (il routing R2 non guarda gli URL)…
      if (!argGuardVerdict('web_fetch', { url }, []).ok) blocked++
      // …e anche sul rilevatore puro, perché l'IIN tenga lontani gli id
      expect(luhnCardNumbers(url), url).toEqual([])
    }
    expect(blocked).toBe(0)
  })
})
