// fase linguaggio-ritocchi (R1): il catalogo delle traduzioni SEMPRE
// allineato al codice. La pillola del tipo della Libreria diceva «g0mreA:
// Tutti i tipi» perché `npm run i18n:extract` non era stato lanciato: il
// codice conteneva `t\`Tipo\`` e il .po no, e nessun controllo lo vedeva.
// Lo stato dell'arte con Lingui è estrarre in CI e fallire se il risultato
// è diverso dal catalogo committato: qui l'estrazione la fa l'API di
// @lingui/cli IN MEMORIA (le stesse sorgenti di lingui.config.ts, gli
// stessi estrattori della CLI) e il confronto è solo lettura — nel repo
// non si scrive nulla, la guardia non aggiusta il catalogo.
//   · ogni messaggio che il codice contiene (t, msg, Trans, plural, select,
//     anche con le variabili: li prende tutti l'estrattore di Babel) deve
//     stare nei .po di it ED en;
//   · ogni voce dei .po deve essere ancora nel codice (è ciò che fa
//     --clean: una voce rimasta non è «prudente», è un catalogo che mente);
//   · il catalogo COMPILATO (messages.mjs) deve essere quello del .po:
//     si ricompila in memoria con createCompiledCatalog e si confronta
//     byte per byte col file committato.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { getConfig } from '@lingui/conf'
import { getCatalogs, createCompiledCatalog } from '@lingui/cli/api'
import { RADICE } from './sorgenti'

/** L'estrazione è costosa (Babel su tutte le sorgenti): una volta per corsa. */
let estratti: Promise<Record<string, unknown>> | null = null
const messaggiEstratti = () => (estratti ??= (async () => {
  const config = await getConfig({ configPath: join(RADICE, 'lingui.config.ts') })
  const catalogs = await getCatalogs(config)
  if (catalogs.length !== 1) throw new Error(`un solo catalogo atteso in lingui.config.ts, trovati ${catalogs.length}`)
  const messaggi = await catalogs[0]!.collect()
  if (messaggi === undefined) throw new Error('l\'estrazione non ha trovato nulla: configurazione o sorgenti illeggibili')
  return messaggi as Record<string, unknown>
})())

describe('il catalogo delle traduzioni è allineato al codice', () => {
  it('ogni messaggio del codice sta nei .po di it ed en (l\'estrazione di lingui, in memoria)', async () => {
    const config = await getConfig({ configPath: join(RADICE, 'lingui.config.ts') })
    const catalogs = await getCatalogs(config)
    const estratto = await messaggiEstratti()
    const problemi: string[] = []
    for (const locale of config.locales) {
      const letto = await catalogs[0]!.read(locale)
      if (letto === undefined) throw new Error(`il catalogo ${locale} non si legge`)
      const nelPo = new Set(Object.keys(letto))
      for (const id of Object.keys(estratto)) {
        if (!nelPo.has(id)) problemi.push(`${locale}: ${id} (${String((estratto[id] as { message?: string }).message ?? '?')})`)
      }
    }
    expect(problemi, 'messaggi nel codice assenti dal catalogo — manca `npm run i18n:extract`').toEqual([])
  }, 240_000)

  it('ogni voce dei .po è ancora nel codice (ciò che --clean toglierebbe)', async () => {
    const config = await getConfig({ configPath: join(RADICE, 'lingui.config.ts') })
    const catalogs = await getCatalogs(config)
    const estratto = new Set(Object.keys(await messaggiEstratti()))
    const problemi: string[] = []
    for (const locale of config.locales) {
      const letto = await catalogs[0]!.read(locale)
      if (letto === undefined) continue
      for (const id of Object.keys(letto)) {
        if (!estratto.has(id)) problemi.push(`${locale}: ${id}`)
      }
    }
    expect(problemi, 'voci del catalogo che il codice non contiene più — rilanciare extract le toglie').toEqual([])
  }, 240_000)

  it('il catalogo compilato (messages.mjs) è quello del .po', async () => {
    const config = await getConfig({ configPath: join(RADICE, 'lingui.config.ts') })
    const catalogs = await getCatalogs(config)
    const problemi: string[] = []
    for (const locale of config.locales) {
      const letto = await catalogs[0]!.read(locale)
      if (letto === undefined) continue
      const messaggi = Object.fromEntries(Object.entries(letto).map(([id, v]) => [id, v.translation ?? '']))
      // le stesse opzioni dello script i18n:compile del package.json
      const { source, errors } = createCompiledCatalog(locale, messaggi, { namespace: 'es', strict: false, pseudoLocale: '' })
      if (errors.length) problemi.push(`${locale}: ${errors.length} messaggi non compilano (${errors[0]!.id}: ${errors[0]!.error.message})`)
      const committato = readFileSync(join(RADICE, 'src', 'renderer', 'src', 'locales', locale, 'messages.mjs'), 'utf8')
      if (source !== committato) problemi.push(`${locale}: messages.mjs differs dal .po — manca \`npm run i18n:compile\``)
    }
    expect(problemi).toEqual([])
  }, 60_000)
})
