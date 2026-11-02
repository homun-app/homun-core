// Fase 16c correzioni (R1): il test di coerenza dei canali IPC. La prova dal
// vivo della 16c ha trovato tre RPC chiamate dal preload ma NON inoltrate da
// ipc.ts («No handler registered»: la prova della chiave, la ricerca nel
// registro MCP, l'Attività globale). I test unitari non potevano vederlo
// perché chiamano il daemon direttamente: qui si legge il codice COME TESTO
// (AST di @babel/parser, come la guardia D4 — niente import da 'electron')
// e si verifica la catena intera:
//   preload invoke ⊆ (canali inoltrati di ipc.ts ∪ canali gestiti dal main)
//   canali inoltrati ⊆ handler della mappa RPC di src/daemon/api.ts
// Niente elenchi di eccezioni a mano: i canali locali sono quelli che ipc.ts
// registra davvero con ipcMain.handle (dialoghi, notifiche, LaunchAgent…).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

interface Node {
  type: string
  [k: string]: unknown
}

const parseTs = (code: string): Node => parse(code, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node

/** Visita l'AST (senza i rami di posizione, come la guardia D4). */
function visit(node: Node, fn: (n: Node, parents: Node[]) => void, parents: Node[] = []): void {
  const next = [...parents, node]
  fn(node, next)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    const child = (node as Record<string, unknown>)[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c === 'object' && (c as Node).type) visit(c as Node, fn, next)
    } else if (child && typeof child === 'object' && (child as Node).type) {
      visit(child as Node, fn, next)
    }
  }
}

/** Il primo argomento (stringa) di ogni ipcRenderer.invoke('<canale>', …). */
export function preloadInvokeChannels(code: string): string[] {
  const out: string[] = []
  visit(parseTs(code), (n, parents) => {
    if (n.type !== 'CallExpression') return
    const callee = n.callee as Node | undefined
    if (callee?.type !== 'MemberExpression') return
    const prop = callee.property as { name?: string } | undefined
    const obj = callee.object as { name?: string } | undefined
    if (obj?.name !== 'ipcRenderer' || prop?.name !== 'invoke') return
    const arg = (n.arguments as Node[] | undefined)?.[0]
    if (arg?.type === 'StringLiteral') out.push((arg as unknown as { value: string }).value)
  })
  return out
}

/** I canali registrati da ipc.ts: l'array DAEMON_RPC_CHANNELS + gli ipcMain.handle locali. */
export function ipcRegisteredChannels(code: string): { forwarded: string[]; local: string[] } {
  const forwarded: string[] = []
  const local: string[] = []
  visit(parseTs(code), (n, parents) => {
    // 1) l'array esportato DAEMON_RPC_CHANNELS: ['a:b', …,] as const
    if (n.type === 'VariableDeclarator' && (n.id as { name?: string })?.name === 'DAEMON_RPC_CHANNELS') {
      const init = n.init as Node | undefined
      if (init?.type === 'TSAsExpression') {
        const arr = (init as { expression?: Node }).expression
        if (arr?.type === 'ArrayExpression') {
          for (const el of (arr.elements ?? []) as Node[]) if (el?.type === 'StringLiteral') forwarded.push((el as unknown as { value: string }).value)
        }
      }
    }
    // 2) gli handler locali: ipcMain.handle('<canale>', …)
    if (n.type === 'CallExpression') {
      const callee = n.callee as Node | undefined
      if (callee?.type !== 'MemberExpression') return
      const obj = callee.object as { name?: string } | undefined
      const prop = callee.property as { name?: string } | undefined
      if (obj?.name !== 'ipcMain' || prop?.name !== 'handle') return
      const arg = (n.arguments as Node[] | undefined)?.[0]
      if (arg?.type === 'StringLiteral') local.push((arg as unknown as { value: string }).value)
    }
    void parents
  })
  return { forwarded, local }
}

/** Le chiavi dell'oggetto RESTITUITO da buildApiMethods (la mappa delle RPC). */
export function daemonRpcChannels(code: string): string[] {
  const out: string[] = []
  visit(parseTs(code), (n) => {
    // solo il return DIRETTO nel corpo di buildApiMethods: i return annidati
    // dentro gli handler sono risposte, non canali
    if (n.type !== 'FunctionDeclaration') return
    if ((n.id as { name?: string })?.name !== 'buildApiMethods') return
    const body = (n.body as { body?: Node[] }).body ?? []
    for (const stmt of body) {
      if (stmt.type !== 'ReturnStatement') continue
      const arg = (stmt.argument as Node | undefined)
      if (arg?.type !== 'ObjectExpression') continue
      for (const prop of (arg.properties ?? []) as Node[]) {
        if (prop.type !== 'ObjectProperty') continue
        const key = prop.key as Node | undefined
        if (key?.type === 'StringLiteral') out.push((key as unknown as { value: string }).value)
        else if (key?.type === 'Identifier') out.push((key as unknown as { name: string }).name)
      }
    }
  })
  return out
}

describe('fase 16c correzioni (R1): coerenza preload → ipc.ts → daemon', () => {
  const preload = preloadInvokeChannels(read('src/preload/index.ts'))
  const { forwarded, local } = ipcRegisteredChannels(read('src/main/ipc.ts'))
  const daemon = daemonRpcChannels(read('src/daemon/api.ts'))

  it('la sanità della lettura: i tre elenchi non sono vuoti e non hanno doppioni', () => {
    // la lettura del codice vede davvero i canali (altrimenti il test passerebbe
    // per disgrazia su tre elenchi vuoti)
    expect(preload.length).toBeGreaterThan(80)
    expect(forwarded.length).toBeGreaterThan(80)
    expect(daemon.length).toBeGreaterThan(80)
    expect(new Set(preload).size).toBe(preload.length)
    expect(new Set(forwarded).size).toBe(forwarded.length)
    expect(new Set(daemon).size).toBe(daemon.length)
  })

  it('ogni canale invocato dal preload è inoltrato al daemon o gestito dal main', () => {
    // niente eccezioni a mano: i canali "locali" sono quelli che ipc.ts
    // registra DAVVERO (dialoghi del Mac, notifiche di test, lingua, avvio
    // all'accesso, import dei file trascinati)
    const missing = preload.filter((c) => !forwarded.includes(c) && !local.includes(c))
    expect(missing, `canali del preload senza handler nel main: ${missing.join(', ')}`).toEqual([])
  })

  it('ogni canale inoltrato ha un handler nella mappa RPC del daemon', () => {
    // l'inoltro 1:1 di ipc.ts chiama client.call(ch, args): un canale senza
    // handler nel daemon risponderebbe errore a ogni chiamata
    const missing = forwarded.filter((c) => !daemon.includes(c))
    expect(missing, `canali inoltrati senza RPC nel daemon: ${missing.join(', ')}`).toEqual([])
  })

  it('i canali gestiti SOLO dal main non finiscono nell\'elenco inoltrato', () => {
    // dialog:pick-image & co. dipendono da finestre e dialoghi: non devono
    // MAI passare al daemon (guardia contro un copia-incolla sventato)
    const both = local.filter((c) => forwarded.includes(c))
    expect(both).toEqual([])
  })

  it('le tre RPC della 16c sono inoltrate (la regressione che le ha perse)', () => {
    for (const ch of ['providers:probe', 'activity:global', 'connectors:search-registry']) {
      expect(forwarded).toContain(ch)
      expect(preload).toContain(ch)
      expect(daemon).toContain(ch)
    }
  })
})
