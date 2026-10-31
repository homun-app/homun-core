// Fase 17c (C1/C9): il formattatore dei testi U — formatUi/ui/UiError, la
// lingua dell'interfaccia (uiLanguage) e la coerenza del catalogo UI: ogni
// id presente in ENTRAMBI i .po con gli stessi segnaposto {…} (i plurali e
// le select ICU compresi). I .po si leggono col po-helper della 17a.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUi, ui, UiError } from '../../shared/ui-text'
import { UI } from '../../shared/ui-messages'
import { uiLanguage, uiError, uiText } from '../ui-language'
import { setSetting } from '../store/db'
import { messages as itMessages } from '../../renderer/src/locales/it/messages.mjs'
import { messages as enMessages } from '../../renderer/src/locales/en/messages.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// parser .po minimale (msgid → msgstr), come po-helper della 17a
function parsePo(path: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = readFileSync(path, 'utf8').split('\n')
  let msgid: string[] | null = null
  let msgstr: string[] = []
  const flush = (): void => {
    if (msgid) out.set(msgid.join(''), msgstr.join(''))
    msgid = null
    msgstr = []
  }
  for (const line of lines) {
    if (line.startsWith('msgid ')) {
      flush()
      msgid = [line.slice(6).replace(/^"|"$/g, '')]
    } else if (line.startsWith('msgstr ')) {
      msgstr = [line.slice(7).replace(/^"|"$/g, '')]
    } else if (line.startsWith('"') && msgid) {
      ;(msgstr.length ? msgstr : msgid).push(line.trim().replace(/^"|"$/g, ''))
    }
  }
  flush()
  return out
}

/** I segnaposto {name} di un messaggio ICU (select/plural annidati compresi). */
function placeholders(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)(?:,[^,]+,(?:[^{}]|\{[^{}]*\})*|[}]|\})/g)) {
    out.add(m[1]!)
  }
  // forma semplice {x}
  for (const m of text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) out.add(m[1]!)
  return out
}

describe('fase 17c (C1): formatUi e il catalogo UI', () => {
  it('formatUi: it/en con valori, plurali e select', () => {
    expect(formatUi(ui(UI.queueFull), 'it')).toBe('Coda piena: messaggio scartato.')
    expect(formatUi(ui(UI.queueFull), 'en')).toBe('Queue full: message discarded.')
    expect(formatUi(ui(UI.agentBusyQueued, { position: 2 }), 'it')).toBe('Agente occupato: messaggio in coda (posizione 2).')
    expect(formatUi(ui(UI.agentBusyQueued, { position: 2 }), 'en')).toBe('Agent busy: message queued (position 2).')
    // plurali ICU
    expect(formatUi(ui(UI.routinesResumed, { count: 1 }), 'it')).toBe('Routine riattivata: 1.')
    expect(formatUi(ui(UI.routinesResumed, { count: 3 }), 'it')).toBe('Routine riattivate: 3.')
    expect(formatUi(ui(UI.routinesResumed, { count: 1 }), 'en')).toBe('Routine resumed: 1.')
    // select ICU (card del browser, motivo per codice)
    const click = formatUi(ui(UI.cardBrowserAsk, {
      tool: 'browser_click', target: 'element', element: 'button "Paga"', url: 'https://x.example',
      typed: 'no', reasonKind: 'commit', name: 'Paga ora', role: 'button'
    }), 'it')
    expect(click).toContain('su button "Paga" in https://x.example')
    expect(click).toContain('un’azione che invia, compra o impegna')
    const clickEn = formatUi(ui(UI.cardBrowserAsk, {
      tool: 'browser_click', target: 'element', element: 'button "Pay"', url: 'https://x.example',
      typed: 'no', reasonKind: 'commit', name: 'Pay now', role: 'button'
    }), 'en')
    expect(clickEn).toContain('an action that sends, buys or commits')
  })

  // fase 17c correzioni (D1): la bolla dell'apertura di una routine a trigger
  it('formatUi: open.triggerEvent in it ed en (select sul kind, item opzionale)', () => {
    const emailIt = formatUi(ui(UI.openTriggerEvent, { title: 'Posta', kind: 'newEmail', item: 'Fattura', withItem: 'yes' }), 'it')
    expect(emailIt).toBe('Routine "Posta" avviata: nuova email — Fattura')
    const emailEn = formatUi(ui(UI.openTriggerEvent, { title: 'Mail', kind: 'newEmail', item: 'Invoice', withItem: 'yes' }), 'en')
    expect(emailEn).toBe('Routine "Mail" started: new email — Invoice')
    const backIt = formatUi(ui(UI.openTriggerEvent, { title: 'Rientri', kind: 'presenceReturn', withItem: 'no' }), 'it')
    expect(backIt).toBe('Routine "Rientri" avviata: l’utente è appena tornato al computer')
    const backEn = formatUi(ui(UI.openTriggerEvent, { title: 'Returns', kind: 'presenceReturn', withItem: 'no' }), 'en')
    expect(backEn).toBe('Routine "Returns" started: the user just came back to the computer')
  })

  it('formatUi: id sconosciuto ricade sull’id stesso (mai crash)', () => {
    expect(formatUi({ id: 'no.such.id' }, 'it')).toBe('no.such.id')
    expect(formatUi({ id: 'no.such.id', values: { a: 1 } }, 'en')).toBe('no.such.id')
  })

  it('uiLanguage: ui.activeLanguage valida vince, altrimenti en', () => {
    setSetting('ui.activeLanguage', 'en')
    expect(uiLanguage()).toBe('en')
    setSetting('ui.activeLanguage', 'it')
    expect(uiLanguage()).toBe('it')
    setSetting('ui.activeLanguage', 'francese')
    expect(uiLanguage()).toBe('en')
  })

  it('uiText/uiError: la lingua dell’interfaccia al momento della chiamata', () => {
    setSetting('ui.activeLanguage', 'en')
    expect(uiText(UI.notifyDone, { agent: 'Bot' })).toBe('Bot replied')
    const e = uiError(UI.rpcTaskNotFound)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toBe('Task not found')
    setSetting('ui.activeLanguage', 'it')
    expect(uiError(UI.rpcTaskNotFound).message).toBe('Task non trovato')
  })

  it('UiError: message inglese per il modello + UiText per la UI', () => {
    const e = new UiError('connector installation not available in this context', ui(UI.rpcInstallUnavailable))
    expect(e.message).toBe('connector installation not available in this context')
    expect(formatUi(e.uiText, 'it')).toContain('installazione dei connettori non disponibile')
    expect(formatUi(e.uiText, 'en')).toContain('connector installation not available')
  })

  it('OGNI id di UI esiste in entrambi i .po con gli stessi segnaposto', () => {
    const catIt = parsePo(join(ROOT, 'renderer/src/locales/it/messages.po'))
    const catEn = parsePo(join(ROOT, 'renderer/src/locales/en/messages.po'))
    const missing: string[] = []
    const mismatch: string[] = []
    for (const [key, descriptor] of Object.entries(UI)) {
      const id = (descriptor as { id: string }).id
      const it = catIt.get(id)
      const en = catEn.get(id)
      if (!it || !en) {
        missing.push(id)
        continue
      }
      const phIt = placeholders(it)
      const phEn = placeholders(en)
      if (phIt.size !== phEn.size || [...phIt].some((p) => !phEn.has(p))) {
        mismatch.push(`${id}: it {${[...phIt]}} vs en {${[...phEn]}}`)
      }
    }
    expect(missing).toEqual([])
    expect(mismatch).toEqual([])
  })

  it('i cataloghi compilati contengono gli id del catalogo UI', () => {
    const itIds = new Set(Object.keys(itMessages))
    const enIds = new Set(Object.keys(enMessages))
    for (const descriptor of Object.values(UI)) {
      const id = (descriptor as { id: string }).id
      expect(itIds.has(id), `it mancante: ${id}`).toBe(true)
      expect(enIds.has(id), `en mancante: ${id}`).toBe(true)
    }
  })
})
