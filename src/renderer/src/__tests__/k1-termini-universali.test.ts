// K1 (fase team-bot): i termini universali non si traducono — in italiano si
// dice «Team» (come «Plugin», «Skill», «Bot»). La guardia copre i DUE piani
// dove il testo vive: i cataloghi (msgstr di it ed en) e i sorgenti (le
// macro visibili t`…` / msg`…` / <Trans>…</Trans> del renderer + le stringhe
// `message:` dei messaggi a id esplicito di shared/main/daemon). Le chiavi e
// il codice restano quelli di oggi (la categoria 'squadra', gli id
// group.nowCoordinates…): cambia solo quello che l'utente legge.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePo } from './po-helper'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('K1: «Team» al posto di «Squadra/Squadre» nei testi visibili', () => {
  it('il catalogo IT non ha più nessun msgstr con «squadr…»', () => {
    const bad: string[] = []
    for (const [id, str] of parsePo('it')) {
      if (/squadr/i.test(str)) bad.push(`${id} → ${str}`)
    }
    expect(bad).toEqual([])
  })

  it('il catalogo EN nemmeno (le traduzioni usano team)', () => {
    const bad: string[] = []
    for (const [id, str] of parsePo('en')) {
      if (/squadr/i.test(str)) bad.push(`${id} → ${str}`)
    }
    expect(bad).toEqual([])
  })

  it('i sorgenti del renderer non hanno «Squadr…» nelle macro di testo visibile', () => {
    const bad: string[] = []
    for (const f of ['components/Sidebar.tsx', 'components/TeamChat.tsx', 'components/ApprovalsQueue.tsx', 'components/ApprovalsCenter.tsx', 'components/RightPanel.tsx', 'components/TeamAutonomySheet.tsx']) {
      const src = read(`../${f}`)
      // i tre canali del testo visibile nel codice: macro t`…`/msg`…` e <Trans>
      const macros = src.match(/(?:t|msg)`[^`]*[Ss]quadr[^`]*`/g) ?? []
      const trans = src.match(/<Trans>[^<]*[Ss]quadr[^<]*<\/Trans>/g) ?? []
      if (macros.length || trans.length) bad.push(`${f}: ${[...macros, ...trans].join(' | ')}`)
    }
    expect(bad).toEqual([])
  })

  it('l\'etichetta di gruppo del centro è tradotta e dice «team · N» (non un literal)', () => {
    const src = read('../components/ApprovalsCenter.tsx')
    // il gruppo squadra e il gruppo bot passano ENTRAMBI dalla macro msg`…`
    // (un template literal nudo non si traduce: in inglese restava «squadra · 2»)
    expect(src).toMatch(/g\.kind === 'squad' \? i18n\.t\(msg`team · /)
    expect(src).toMatch(/: i18n\.t\(msg`bot · /)
    expect(src).not.toMatch(/\? `squadra · /)
    expect(src).not.toMatch(/: `bot · /)
  })

  it('i messaggi a id esplicito (daemon e main) dicono «team» in italiano', () => {
    const src = read('../../../shared/ui-messages.ts')
    const bad = src.match(/message:\s*'[^']*[Ss]quadr[^']*'/g) ?? []
    expect(bad).toEqual([])
  })
})
