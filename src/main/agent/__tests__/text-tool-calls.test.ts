// Fase locale (L1): il recupero delle chiamate ai tool scritte come TESTO
// grezzo. Le fixture sono gli 8 blocchi VERI dei dump L1
// (/var/folders/…/T/l1-{Qwen3.5-4B,LFM3-1.7B}-Q4_K_M.json, cerca "<tool_call>"):
// chiamate GIUSTE che llama-server non ha riconosciuto e che arrivavano
// all'utente come testo. Il parser è PURO: riconosce il formato XML
// (<function=x>/<parameter=y>) e quello Hermes (JSON in <tool_call>), accetta
// solo nomi nel catalogo del turno e restituisce il testo fuori dai blocchi.
import { describe, expect, it } from 'vitest'
import { parseTextToolCalls, stripTextToolCallBlocks, hasRawToolCallBlocks } from '../text-tool-calls'

/** il catalogo del turno: nucleo + gruppi non ancora attivi (nomi interni) */
const KNOWN = new Set([
  'read-file', 'web_search', 'web_fetch', 'search_connectors', 'find_tools',
  'run-command', 'browser_open', 'browser_type', 'fill_credential', 'send_to_user',
  // LE1: i nomi underscore delle fixture con backtick negli argomenti
  'run_command', 'write_file'
])

// ---- LE1: i blocchi con backtick/recinti NEGLI ARGOMENTI (le fixture dei
// dump qui sotto e la tabella del lexer li usano) ----
const BACKTICK_SHELL =
  '<tool_call>\n<function=run_command>\n<parameter=command>\necho `date`\n</parameter>\n</function>\n</tool_call>'
const BACKTICK_WRITE_FILE =
  '<tool_call>\n<function=write_file>\n<parameter=path>\n/workspace/app/README.md\n</parameter>\n<parameter=content>\n# Titolo\n\nAvvia con `npm i` poi:\n\n```bash\nnpm run dev\n```\n</parameter>\n</function>\n</tool_call>'
const BACKTICK_HERMES =
  '<tool_call>\n{"name":"run_command","arguments":{"command":"echo `x`"}}\n</tool_call>'
/** il blocco APERTO in coda con un backtick nell'argomento (il 4° caso LE1) */
const BACKTICK_APERTO =
  '<tool_call>\n<function=run_command>\n<parameter=command>\nls `pwd`\n</parameter>\n</function>'

// ---- le 8 fixture VERI dei dump (casi 17, 21, 23, 29, 32, 33, 34, 45) ----
const FIXTURES: Array<{ caseId: string; text: string; calls: Array<{ name: string; args: Record<string, unknown> }> }> = [
  {
    caseId: '17 (LFM3)',
    text: '<tool_call>\n<function=read-file>\n<parameter=path>\n/workspace/.sandbot/shells/sh-eval0001.log\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'read-file', args: { path: '/workspace/.sandbot/shells/sh-eval0001.log' } }]
  },
  {
    caseId: '21 (LFM3)',
    text: '<tool_call>\n<function=web_search>\n<parameter=query>\nAstro framework strengths limitations\n</parameter>\n<parameter=max_results>\n10\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'web_search', args: { query: 'Astro framework strengths limitations', max_results: 10 } }]
  },
  {
    caseId: '23 (LFM3)',
    text: '<tool_call>\n<function=web_fetch>\n<parameter=url>\nhttps://www.timeanddate.com/worldclock/json/tokyo.html\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'web_fetch', args: { url: 'https://www.timeanddate.com/worldclock/json/tokyo.html' } }]
  },
  {
    caseId: '29 (Qwen)',
    text: '<tool_call>\n<function=search_connectors>\n<parameter=query>\nNotion\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'search_connectors', args: { query: 'Notion' } }]
  },
  {
    caseId: '32 (LFM3)',
    text: '<tool_call>\n<function=web_search>\n<parameter=query>\ngen 10 feb 14 mar 9 vendite\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'web_search', args: { query: 'gen 10 feb 14 mar 9 vendite' } }]
  },
  {
    caseId: '33 (LFM3)',
    text: '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'find_tools', args: { group: 'browser' } }]
  },
  {
    // il 34 porta DUE blocchi nella stessa risposta
    caseId: '34 (Qwen)',
    text: '<tool_call>\n<function=find_tools>\n<parameter=group>\ncredentials\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=run-command>\n<parameter=command>\nfill_credential "login_eval2"\n</parameter>\n</function>\n</tool_call>',
    calls: [
      { name: 'find_tools', args: { group: 'credentials' } },
      { name: 'run-command', args: { command: 'fill_credential "login_eval2"' } }
    ]
  },
  {
    caseId: '45 (LFM3)',
    text: '<tool_call>\n<function=browser_open>\n<parameter=url>\nhttps://sora.com/\n</parameter>\n</function>\n</tool_call>',
    calls: [{ name: 'browser_open', args: { url: 'https://sora.com/' } }]
  },
  // ---- LE1: le fixture con BACKTICK o RECINTI NEGLI ARGOMENTI — i casi più
  // comuni in assoluto (comandi di shell e file markdown) e proprio quelli
  // senza copertura: è per questo che la regressione LD3 è passata ----
  {
    // un comando di shell con sostituzione `…`
    caseId: 'LE1 (shell)',
    text: BACKTICK_SHELL,
    calls: [{ name: 'run_command', args: { command: 'echo `date`' } }]
  },
  {
    // un write_file il cui content È markdown: span inline (`npm i`) e recinto
    caseId: 'LE1 (write_file markdown)',
    text: BACKTICK_WRITE_FILE,
    calls: [{
      name: 'write_file',
      args: { path: '/workspace/app/README.md', content: '# Titolo\n\nAvvia con `npm i` poi:\n\n```bash\nnpm run dev\n```' }
    }]
  },
  {
    // il formato Hermes con un backtick dentro il JSON
    caseId: 'LE1 (Hermes)',
    text: BACKTICK_HERMES,
    calls: [{ name: 'run_command', args: { command: 'echo `x`' } }]
  }
]

describe('fase locale (L1): parseTextToolCalls — le 8 fixture vere dei dump', () => {
  for (const f of FIXTURES) {
    it(`caso ${f.caseId}: ${f.calls.map((c) => c.name).join(' + ')}`, () => {
      const r = parseTextToolCalls(f.text, KNOWN)
      expect(r.calls).toEqual(f.calls.map((c) => ({ name: c.name, arguments: JSON.stringify(c.args) })))
      // il blocco NON resta nel testo rimasto fuori
      expect(r.text).not.toContain('<tool_call>')
      expect(r.text).not.toContain('<function=')
    })
  }
})

describe('fase locale (L1): parseTextToolCalls — formati e bordi', () => {
  it('testo misto: il testo attorno ai blocchi si conserva, i blocchi no', () => {
    const text = 'Devo cercare gli strumenti del browser.\n<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>\nPoi apro la pagina.'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([{ name: 'find_tools', arguments: JSON.stringify({ group: 'browser' }) }])
    expect(r.text).toContain('Devo cercare gli strumenti del browser.')
    expect(r.text).toContain('Poi apro la pagina.')
    expect(r.text).not.toContain('<tool_call>')
  })

  it('più blocchi (il caso 34 sono due, qui tre) nell’ordine', () => {
    const blk = (n: string, p: string, v: string) => `<tool_call>\n<function=${n}>\n<parameter=${p}>\n${v}\n</parameter>\n</function>\n</tool_call>`
    const r = parseTextToolCalls([blk('web_search', 'query', 'a'), blk('web_fetch', 'url', 'https://x.example'), blk('find_tools', 'group', 'browser')].join('\n'), KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['web_search', 'web_fetch', 'find_tools'])
  })

  it('valori JSON: numeri, booleani e oggetti; stringhe con a capo restano stringhe', () => {
    const text =
      '<tool_call>\n<function=browser_type>\n<parameter=ref>\ne6\n</parameter>\n<parameter=text>\nriga uno\nriga due\n</parameter>\n<parameter=submit>\ntrue\n</parameter>\n<parameter=delay>\n250\n</parameter>\n</function>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ ref: 'e6', text: 'riga uno\nriga due', submit: true, delay: 250 })
  })

  it('un oggetto JSON come valore si mantiene oggetto', () => {
    const text = '<tool_call>\n<function=send_to_user>\n<parameter=text>\nciao\n</parameter>\n<parameter=meta>\n{"a": 1, "b": ["x"]}\n</parameter>\n</function>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ text: 'ciao', meta: { a: 1, b: ['x'] } })
  })

  it('formato Hermes <tool_call>{"name":…,"arguments":{…}}</tool_call>', () => {
    const text = 'Cerco subito.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "novità Astro", "max_results": 5}}\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([{ name: 'web_search', arguments: JSON.stringify({ query: 'novità Astro', max_results: 5 }) }])
    expect(r.text.trim()).toBe('Cerco subito.')
  })

  it('Hermes con "parameters" al posto di "arguments"', () => {
    const r = parseTextToolCalls('<tool_call>\n{"name": "find_tools", "parameters": {"group": "browser"}}\n</tool_call>', KNOWN)
    expect(r.calls[0]).toEqual({ name: 'find_tools', arguments: JSON.stringify({ group: 'browser' }) })
  })

  it('nome NON nel catalogo: il blocco resta COM’È nel testo, nessuna chiamata', () => {
    const text = 'Ecco.\n<tool_call>\n<function=strumento_inventato>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([])
    expect(r.text).toContain('<function=strumento_inventato>')
    expect(r.text).toContain('Ecco.')
  })

  it('un blocco riconosciuto e uno sconosciuto: si esegue solo il primo, il secondo resta', () => {
    const text =
      '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=sconosciuto>\n<parameter=q>\nz\n</parameter>\n</function>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['find_tools'])
    expect(r.text).toContain('<function=sconosciuto>')
    expect(r.text).not.toContain('<function=find_tools>')
  })

  it('bloco MALFORMATO (function mai chiuso): resta com’è, nessun crash', () => {
    const text = '<tool_call>\n<function=web_search>\n<parameter=query>\nx\n</parameter>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([])
    expect(r.text).toContain('<tool_call>')
  })

  it('testo senza blocchi: nessuna chiamata, testo identico', () => {
    const r = parseTextToolCalls('Risposta normale dell\'assistente.', KNOWN)
    expect(r.calls).toEqual([])
    expect(r.text).toBe('Risposta normale dell\'assistente.')
  })

  it('accetta anche i nomi delle FACCIATE (browser/document/task/memory) come il loop', () => {
    const r = parseTextToolCalls('<tool_call>\n<function=browser>\n<parameter=action>\nopen\n</parameter>\n<parameter=url>\nhttps://x.example\n</parameter>\n</function>\n</tool_call>', new Set([...KNOWN, 'browser', 'document', 'task', 'memory']))
    expect(r.calls[0]!.name).toBe('browser')
  })
})

describe('fase locale (L1.3): stripTextToolCallBlocks — la consegna non contiene MAI blocchi grezzi', () => {
  it('toglie i blocchi anche quando il nome è sconosciuto (non si consegna XML grezzo)', () => {
    const text = 'Ti serve questo:\n<tool_call>\n<function=sconosciuto>\n<parameter=q>\nz\n</parameter>\n</function>\n</tool_call>\nFatto.'
    const out = stripTextToolCallBlocks(text)
    expect(out).not.toContain('<tool_call>')
    expect(out).not.toContain('<function=')
    expect(out).toContain('Ti serve questo:')
    expect(out).toContain('Fatto.')
  })

  it('un testo tutto blocco diventa vuoto (→ il loop usa il recupero normale)', () => {
    expect(stripTextToolCallBlocks(FIXTURES[0]!.text).trim()).toBe('')
  })

  it('toglie anche un frammento orfano <function=…> senza chiusura', () => {
    const out = stripTextToolCallBlocks('risposta\n<function=web_search>\n<parameter=query>\nx')
    expect(out).not.toContain('<function=')
    expect(out).toContain('risposta')
  })

  it('hasRawToolCallBlocks: vero per <tool_call> e per <function=, falso altrimenti', () => {
    expect(hasRawToolCallBlocks('x <tool_call> y')).toBe(true)
    expect(hasRawToolCallBlocks('x <function=web_search>')).toBe(true)
    expect(hasRawToolCallBlocks('la tag &lt;tool_call&gt; citata')).toBe(false)
    expect(hasRawToolCallBlocks('normale')).toBe(false)
  })

  it('il testo pulito di un messaggio normale resta identico', () => {
    expect(stripTextToolCallBlocks('Ciao, ecco la risposta.')).toBe('Ciao, ecco la risposta.')
  })
})

// ---- fase locale correzioni (LC3): blocco senza chiusura e blocchi nel codice ----

describe('fase locale correzioni (LC3): il blocco aperto in fondo si recupera, il codice è testo', () => {
  // la prova della spec: il modello si ferma all'EOS prima della </tool_call>
  const APERTO = 'Apro il browser.\n<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>'

  it('blocco APERTO in fondo (nessuna </tool_call>) con function completa: la chiamata si recupera', () => {
    const r = parseTextToolCalls(APERTO, KNOWN)
    expect(r.calls).toEqual([{ name: 'find_tools', arguments: JSON.stringify({ group: 'browser' }) }])
    expect(r.text).toContain('Apro il browser.')
    expect(r.text).not.toContain('<tool_call>')
    expect(r.text).not.toContain('<function=')
  })

  it('blocco aperto SENZA </function>: resta testo (niente chiamata), la consegna lo ripulisce come oggi', () => {
    const text = 'Ora cerco.\n<tool_call>\n<function=web_search>\n<parameter=query>\ngatto'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([])
    expect(r.text).toContain('<tool_call>')
    expect(stripTextToolCallBlocks(text)).not.toContain('<tool_call>')
    expect(stripTextToolCallBlocks(text)).toContain('Ora cerco.')
  })

  it('il blocco DENTRO un recinto di codice NON si esegue: è testo («ecco il formato»)', () => {
    const text = 'Il formato è questo:\n```\n<tool_call>\n<function=run-command>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>\n```\nChiaro?'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([]) // NON eseguito
    expect(r.text).toContain('<function=run-command>') // resta testo, tutto
    expect(r.text).toContain('Il formato è questo:')
    // e la PULIZIA della consegna non lo tocca: è contenuto voluto
    expect(stripTextToolCallBlocks(text)).toContain('<function=run-command>')
    // la consegna pulisce SOLO fuori dal recinto (qui fuori non c'è niente da togliere)
    expect(stripTextToolCallBlocks(text)).toContain('Chiaro?')
  })

  it('un blocco nel codice e uno FUORI nello stesso testo: si recupera solo quello fuori', () => {
    const text = 'Ecco due cose.\n```\n<tool_call>\n<function=run-command>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\n```\nMa questa la faccio davvero:\n<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>'
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls).toEqual([{ name: 'find_tools', arguments: JSON.stringify({ group: 'browser' }) }])
    expect(r.text).toContain('<function=run-command>') // quello nel recinto resta
    expect(r.text).not.toMatch(/<function=find_tools>/)
  })

  it('i recinti di TILDE (~~~) fanno recinto come i backtick', () => {
    const text = '~~~\n<tool_call>\n<function=run-command>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\n~~~'
    expect(parseTextToolCalls(text, KNOWN).calls).toEqual([])
    expect(stripTextToolCallBlocks(text)).toContain('<tool_call>')
  })

  it('recinto MAI chiuso: fa recinto fino alla fine del testo', () => {
    const text = 'Esempio:\n```\n<tool_call>\n<function=run-command>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\n(e il testo finisce qui, senza chiusura'
    expect(parseTextToolCalls(text, KNOWN).calls).toEqual([])
    expect(stripTextToolCallBlocks(text)).toContain('<function=run-command>')
  })

  it('hasRawToolCallBlocks: il blocco SOLO nel recinto non è «grezzo» da pulire', () => {
    expect(hasRawToolCallBlocks('```\n<tool_call>\nx\n</tool_call>\n```')).toBe(false)
    expect(hasRawToolCallBlocks('prima un recinto:\n```\n<function=x>\n```\ne POI un blocco vero <tool_call>')).toBe(true)
  })
})

// ---- fase locale correzioni 2 (LD3): una menzione di <tool_call> non ingoia il blocco vero ----

describe('fase locale correzioni 2 (LD3): una menzione di <tool_call> non ingoia il blocco vero', () => {
  // il blocco VERO di tutti i casi della tabella (find_tools, come i dump)
  const VERO = '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>'
  // il blocco APERTO in coda (il modello si è fermato prima della chiusura)
  const APERTO = '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>'

  it('menzione DENTRO un recinto + blocco vero fuori: il blocco si recupera (prima la regex partiva nel recinto e moriva sulla </tool_call> fuori)', () => {
    const text = '```\n<tool_call> ecco\n```\n' + VERO
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['find_tools'])
    expect(r.text).toContain('<tool_call> ecco') // la menzione nel recinto resta
  })

  it('menzione nel codice INLINE + blocco vero: la chiamata si recupera e il testo citato NON si tocca', () => {
    const text = 'usa `<tool_call>` così\n' + VERO
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['find_tools'])
    expect(r.text).toContain('usa `<tool_call>` così')
    // e la PULIZIA protegge lo span inline come il recinto (prima diventava «usa `»)
    const clean = stripTextToolCallBlocks(text)
    expect(clean).toContain('usa `<tool_call>` così')
    expect(clean).not.toContain('<function=find_tools>')
    expect(hasRawToolCallBlocks('usa `<tool_call>` così, ecco il formato')).toBe(false)
  })

  it('blocco chiuso con nome SCONOSCIUTO + blocco APERTO vero in coda: si recupera l\'aperto (prima il controllo guardava il PRIMO <tool_call>)', () => {
    const text = '<tool_call>\n<function=strumento_inventato>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>\n' + APERTO
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['find_tools']) // solo l'aperto vero
    expect(r.text).toContain('<function=strumento_inventato>') // lo sconosciuto resta
  })

  it('menzione nel recinto NON chiusa + blocco APERTO vero: l\'aperto si recupera lo stesso', () => {
    const text = '```\n<tool_call>\n```\n' + APERTO
    const r = parseTextToolCalls(text, KNOWN)
    expect(r.calls.map((c) => c.name)).toEqual(['find_tools'])
    expect(r.text).toContain('<tool_call>') // la menzione nel recinto resta testo
  })
})

// ---- fase locale correzioni 3 (LE1): il LESSORE — un solo passaggio da
// sinistra a destra. Le zone protette si calcolavano anche DENTRO i blocchi
// veri: un backtick o un recinto dentro un <parameter> spezzava il blocco e
// la chiamata si perdeva (la pulizia consegnava l'argomento all'utente).
// Ora fuori da un blocco vince il costrutto che COMINCIA PRIMA, e un
// <tool_call> consuma il blocco intero QUALUNQUE cosa contenga. La tabella
// unified: i 4 casi LE1, i 4 di LD3, i 3 di LC3 e gli 8 blocchi veri dei
// dump (più le fixture LE1 con backtick negli argomenti) ----

describe('fase locale correzioni 3 (LE1): il lexer — i backtick DENTRO un blocco sono argomenti', () => {
  // il blocco VERO di tutti i casi LD3/LC3 (find_tools, come i dump)
  const VERO = '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>\n</tool_call>'
  // il blocco APERTO in coda (il modello si è fermato prima della chiusura)
  const APERTO = '<tool_call>\n<function=find_tools>\n<parameter=group>\nbrowser\n</parameter>\n</function>'
  // un blocco chiuso con nome SCONOSCIUTO (deve restare nel testo)
  const SCONOSCIUTO = '<tool_call>\n<function=strumento_inventato>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>'

  type Row = {
    id: string
    text: string
    calls: Array<{ name: string; args: Record<string, unknown> }>
    /** frasi che DEVONO restare nel testo fuori dai blocchi */
    textHas?: string[]
    /** frammenti che NON devono restare nel testo fuori dai blocchi */
    textHasNot?: string[]
    /** frasi che NON devono arrivare ALL'UTENTE dalla pulizia della consegna */
    cleanHas?: string[]
    cleanHasNot?: string[]
  }

  const TABLE: Row[] = [
    // — i 4 casi della tabella LE1 (su a83facd7 erano PERSI: la pulizia
    //   consegnava il contenuto dell'argomento all'utente) —
    {
      id: 'LE1 · run_command con backtick nell’argomento (echo `date`)',
      text: BACKTICK_SHELL,
      calls: [{ name: 'run_command', args: { command: 'echo `date`' } }],
      textHasNot: ['<tool_call>', '<function='],
      cleanHasNot: ['echo `date`', '<tool_call>']
    },
    {
      id: 'LE1 · write_file con content markdown (span `npm i` e recento ```bash)',
      text: BACKTICK_WRITE_FILE,
      calls: [{ name: 'write_file', args: { path: '/workspace/app/README.md', content: '# Titolo\n\nAvvia con `npm i` poi:\n\n```bash\nnpm run dev\n```' } }],
      textHasNot: ['<tool_call>', '<function=', 'Titolo'],
      cleanHasNot: ['npm i', 'npm run dev', '<tool_call>']
    },
    {
      id: 'LE1 · Hermes con backtick dentro il JSON (echo `x`)',
      text: BACKTICK_HERMES,
      calls: [{ name: 'run_command', args: { command: 'echo `x`' } }],
      textHasNot: ['<tool_call>', '"name"'],
      cleanHasNot: ['echo `x`', '<tool_call>']
    },
    {
      id: 'LE1 · blocco APERTO in coda con ls `pwd`',
      text: BACKTICK_APERTO,
      calls: [{ name: 'run_command', args: { command: 'ls `pwd`' } }],
      textHasNot: ['<tool_call>', '<function='],
      cleanHasNot: ['`pwd`', '<tool_call>']
    },
    // — i 4 casi di LD3: una menzione di <tool_call> non ingoia il blocco vero —
    {
      id: 'LD3 · menzione DENTRO un recinto + blocco vero fuori',
      text: '```\n<tool_call> ecco\n```\n' + VERO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['<tool_call> ecco'],
      textHasNot: ['<function=find_tools>']
    },
    {
      id: 'LD3 · menzione nel codice INLINE + blocco vero',
      text: 'usa `<tool_call>` così\n' + VERO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['usa `<tool_call>` così'],
      textHasNot: ['<function=find_tools>'],
      cleanHas: ['usa `<tool_call>` così']
    },
    {
      id: 'LD3 · blocco chiuso SCONOSCIUTO + blocco APERTO in coda',
      text: SCONOSCIUTO + '\n' + APERTO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['<function=strumento_inventato>']
    },
    {
      id: 'LD3 · menzione nel recinto NON chiusa + blocco APERTO in coda',
      text: '```\n<tool_call>\n```\n' + APERTO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['<tool_call>']
    },
    // — i casi LC3: il blocco aperto in coda, il codice è testo —
    {
      id: 'LC3 · blocco APERTO in coda con function completa',
      text: 'Apro il browser.\n' + APERTO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['Apro il browser.'],
      textHasNot: ['<tool_call>', '<function=']
    },
    {
      id: 'LC3 · blocco DENTRO un recinto NON eseguito (è testo voluto)',
      text: 'Il formato è questo:\n```\n<tool_call>\n<function=run-command>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>\n```\nChiaro?',
      calls: [],
      textHas: ['<function=run-command>', 'Il formato è questo:', 'Chiaro?'],
      cleanHas: ['<function=run-command>']
    },
    {
      id: 'LC3 · recinto con blocco + blocco VERO fuori: si recupera solo quello fuori',
      text: 'Ecco due cose.\n```\n<tool_call>\n<function=run-command>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\n```\nMa questa la faccio davvero:\n' + VERO,
      calls: [{ name: 'find_tools', args: { group: 'browser' } }],
      textHas: ['<function=run-command>', 'Ma questa la faccio davvero:'],
      textHasNot: ['<function=find_tools>']
    },
    // — gli 8 blocchi VERI dei dump + le 3 fixture LE1 (backtick negli
    //   argomenti): erano proprio i casi senza copertura —
    ...FIXTURES.map((f): Row => ({
      id: `dump/LE1 · caso ${f.caseId}: ${f.calls.map((c) => c.name).join(' + ')}`,
      text: f.text,
      calls: f.calls,
      textHasNot: ['<tool_call>', '<function=']
    }))
  ]

  for (const row of TABLE) {
    it(row.id, () => {
      const r = parseTextToolCalls(row.text, KNOWN)
      expect(r.calls).toEqual(row.calls.map((c) => ({ name: c.name, arguments: JSON.stringify(c.args) })))
      for (const s of row.textHas ?? []) expect(r.text).toContain(s)
      for (const s of row.textHasNot ?? []) expect(r.text).not.toContain(s)
      const clean = stripTextToolCallBlocks(row.text)
      for (const s of row.cleanHas ?? []) expect(clean).toContain(s)
      for (const s of row.cleanHasNot ?? []) expect(clean).not.toContain(s)
      // dove il testo recuperato non contiene più tag, non c'è nulla di grezzo
      if (row.textHasNot?.includes('<tool_call>')) expect(hasRawToolCallBlocks(r.text)).toBe(false)
    })
  }
})
