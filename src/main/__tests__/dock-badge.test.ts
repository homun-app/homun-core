// A3 (fase approvazioni-chiare): il NUMERO sull'icona del Dock = richieste
// in attesa (app.dock.setBadge). Funzione pura + guardia sul wiring: l'IPC
// del main e la chiamata dal renderer. MAI notifiche o badge veri nei test:
// qui solo il modello e il sorgente.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const { dockBadgeOf } = await import('../dock-badge')

describe('A3: il testo del badge del Dock (puro)', () => {
  it('0 richieste → NESSUN badge (stringa vuota)', () => {
    expect(dockBadgeOf(0)).toBe('')
  })
  it('il conteggio → il numero (1, 5, 42)', () => {
    expect(dockBadgeOf(1)).toBe('1')
    expect(dockBadgeOf(5)).toBe('5')
    expect(dockBadgeOf(42)).toBe('42')
  })
  it('oltre 99 si ferma a «99+» (il Dock non è un contatore infinito)', () => {
    expect(dockBadgeOf(100)).toBe('99+')
    expect(dockBadgeOf(1000)).toBe('99+')
  })
})

describe('A3: il wiring del badge (guardie sul sorgente)', () => {
  it('il main registra l\'IPC app:dock-badge e chiama app.dock.setBadge', () => {
    const src = read('../ipc.ts')
    expect(src).toContain("'app:dock-badge'")
    expect(src).toMatch(/app\.dock\?\.setBadge/)
    expect(src).toContain('dockBadgeOf')
  })

  it('il preload espone setDockBadge e lo store lo chiama col conteggio delle pendenti', () => {
    const preload = read('../../preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('app:dock-badge'")
    const store = read('../../renderer/src/store.ts')
    expect(store).toMatch(/setDockBadge\(.*approvalsAll/)
  })
})
