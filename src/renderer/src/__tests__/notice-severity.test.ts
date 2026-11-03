// R1 (fase app — ritocchi): la tabella delle severità copre TUTTI gli id
// usati come notice. Il test legge il codice COME TESTO (AST di
// @babel/parser, come il test di coerenza ipc — niente import da 'electron')
// e ricostruisce quali messaggi del catalogo UI finiscono in una entry
// kind:'notice': ogni id trovato DEVE stare nella tabella, così una notice
// nuova va classificata subito (altrimenti il test fallisce).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { noticeSeverity, NOTICE_SEVERITY } from '../lib/notice-severity'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Un nodo dell'AST di babel, con accesso pragmatico ai campi (come la guardia D4). */
type AnyNode = Record<string, any>

const parseTs = (code: string): AnyNode => parse(code, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as AnyNode

/** Visita l'AST (senza i rami di posizione, come la guardia D4). */
function visit(node: AnyNode, fn: (n: AnyNode) => void): void {
  fn(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c === 'object' && c.type) visit(c as AnyNode, fn)
    } else if (child && typeof child === 'object' && child.type) {
      visit(child as AnyNode, fn)
    }
  }
}

/** I file .ts di src/main e src/daemon (niente test). */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name.includes('.test.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** La mappa chiave UI → id del catalogo (queueFull → notice.queueFull). */
function uiKeyToId(code: string): Map<string, string> {
  const map = new Map<string, string>()
  visit(parseTs(code), (n) => {
    if (n.type !== 'ObjectProperty') return
    if (!n.key?.name || n.value?.type !== 'CallExpression' || n.value.callee?.name !== 'msg') return
    const first: AnyNode | undefined = n.value.arguments?.[0]
    if (first?.type !== 'ObjectExpression') return
    for (const prop of first.properties ?? []) {
      if (prop.type !== 'ObjectProperty' || prop.key?.name !== 'id') continue
      if (prop.value?.type === 'StringLiteral' && typeof prop.value.value === 'string') map.set(n.key.name, prop.value.value)
    }
  })
  return map
}

/**
 * Gli id del catalogo usati come notice in un file: si seguono i punti di
 * emissione (uiSystemEntry(…,'notice',…), appendLocalNotice, la lambda
 * locale notice(…) di api.ts e gli oggetti letterali kind:'notice' col loro
 * meta.ui), risolvendo anche le const locali che alimentano meta.ui.
 */
function noticeUiKeys(code: string): Set<string> {
  const ast = parseTs(code)
  // le const locali: NAME → chiavi UI referite dall'inizializzatore
  const consts = new Map<string, Set<string>>()
  const uiKeysOf = (expr: AnyNode | undefined, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>()
    if (!expr) return out
    visit(expr, (n) => {
      // il punto d'ingresso è la chiamata ui(UI.chiave, {…}): la chiave è il
      // PRIMO ARGOMENTO (MemberExpression su UI), non il callee
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'ui') {
        const first: AnyNode | undefined = n.arguments?.[0]
        if (first?.type === 'MemberExpression' && first.object?.name === 'UI' && typeof first.property?.name === 'string') {
          out.add(first.property.name)
        }
      }
      if (n.type === 'Identifier' && consts.has(n.name) && !seen.has(n.name)) {
        seen.add(n.name)
        for (const k of consts.get(n.name)!) out.add(k)
      }
    })
    return out
  }
  // prima passata: le const (anche quelle che si riferiscono ad altre const)
  visit(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || !n.id?.name || !n.init) return
    consts.set(n.id.name, uiKeysOf(n.init))
  })
  // seconda passata: i punti di emissione via chiamata
  const used = new Set<string>()
  visit(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'Identifier') return
    const args: AnyNode[] = n.arguments ?? []
    if (n.callee.name === 'uiSystemEntry') {
      // uiSystemEntry(agentId, 'notice', …) — il kind deve dire 'notice'
      if (args[1]?.type === 'StringLiteral' && args[1].value === 'notice') {
        for (const k of uiKeysOf(args[2])) used.add(k)
      }
    } else if (n.callee.name === 'appendLocalNotice' || n.callee.name === 'notice') {
      for (const k of uiKeysOf(args[1] ?? args[0])) used.add(k)
    }
  })
  // terza passata: gli oggetti letterali con kind:'notice' (il loro meta.ui)
  visit(ast, (n) => {
    if (n.type !== 'ObjectExpression') return
    let isNotice = false
    let uiExpr: AnyNode | undefined
    for (const prop of n.properties ?? []) {
      if (prop.type !== 'ObjectProperty') continue
      if (prop.key?.name === 'kind' && prop.value?.type === 'StringLiteral' && prop.value.value === 'notice') isNotice = true
      if (prop.key?.name === 'meta' && prop.value?.type === 'ObjectExpression') {
        for (const m of prop.value.properties ?? []) {
          if (m.type === 'ObjectProperty' && m.key?.name === 'ui') uiExpr = m.value
        }
      }
    }
    if (isNotice && uiExpr) for (const k of uiKeysOf(uiExpr)) used.add(k)
  })
  return used
}

describe('R1 — noticeSeverity: la tabella copre tutti gli id usati come notice', () => {
  const catalog = uiKeyToId(readFileSync(join(ROOT, 'src/shared/ui-messages.ts'), 'utf8'))
  const usedIds = new Set<string>()
  for (const dir of ['src/main', 'src/daemon']) {
    for (const file of tsFiles(join(ROOT, dir))) {
      for (const key of noticeUiKeys(readFileSync(file, 'utf8'))) {
        const id = catalog.get(key)
        expect(id, `${file}: chiave UI.${key} senza id nel catalogo`).toBeDefined()
        usedIds.add(id!)
      }
    }
  }

  it('ogni id usato come notice sta nella tabella (nessuna notice non classificata)', () => {
    const missing = [...usedIds].filter((id) => !(id in NOTICE_SEVERITY))
    expect(missing, 'id usati come notice ma fuori dalla tabella delle severità').toEqual([])
  })

  it('la tabella non ha voci marce: ogni id classificato è davvero usato come notice', () => {
    const stale = Object.keys(NOTICE_SEVERITY).filter((id) => !usedIds.has(id))
    expect(stale, 'id in tabella che non vengono più usati come notice').toEqual([])
  })

  it('i punti di emissione trovati sono quelli veri (una trentina di id, non uno di più né di meno)', () => {
    expect([...usedIds].sort()).toEqual([
      'notice.agentBusyDiscard',
      'notice.agentBusyQueued',
      'notice.approvalExpired',
      'notice.awayLine',
      'notice.boxMigrated',
      'notice.boxMigratedFailed',
      'notice.boxPreparing',
      'notice.configureProviderFirst',
      'notice.deniedByPermissions',
      'notice.imagesNotSeen',
      'notice.modelEmpty',
      'notice.modelError',
      'notice.modelFallback',
      'notice.modelFallbackRoute',
      'notice.modelNotResponding',
      'notice.modelRouteCooled',
      'notice.noRoutinesToResume',
      'notice.onboardingWaitingProvider',
      'notice.ownModelUnavailable',
      'notice.queueFull',
      'notice.resume',
      'notice.routineModelUnavailable',
      'notice.routineSkipped',
      'notice.routinesResumed',
      'notice.stepsLimit',
      'notice.taskCancelled',
      'notice.toolLoop',
      'notice.wakeNudge',
      'rpc.draftBlocked',
      'rpc.draftNoVia',
      'rpc.draftSendError',
      'rpc.draftViaRejected'
    ])
  })

  it('casi chiave: draftSendError → error, agentBusyQueued → info, migrazione del box → info', () => {
    expect(noticeSeverity('rpc.draftSendError')).toBe('error')
    expect(noticeSeverity('notice.agentBusyQueued')).toBe('info')
    expect(noticeSeverity('notice.boxMigrated')).toBe('info')
    expect(noticeSeverity('notice.boxMigratedFailed')).toBe('info')
  })

  it('senza id, o con id fuori tabella → info (mai rosso per default)', () => {
    expect(noticeSeverity(undefined)).toBe('info')
    expect(noticeSeverity('')).toBe('info')
    expect(noticeSeverity('notice.sconosciutaDalFuturo')).toBe('info')
  })

  it('le tre severità sono tutte rappresentate fra le notice usate', () => {
    const severities = new Set([...usedIds].map((id) => noticeSeverity(id)))
    expect(severities).toEqual(new Set(['info', 'warning', 'error']))
  })
})
