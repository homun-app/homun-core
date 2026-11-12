// OA1 (fase onboarding-a): la race del primo avvio sta nel main —
// index.ts creava «Bot» con createAgent PRIMA che il daemon eseguisse
// l'onboarding, e maybeStartOnboarding vedendo un agente si spegneva.
// Il bot principale lo crea SOLO il daemon (dentro l'onboarding): questa
// guardia blocca ogni ritorno di createAgent nel main UI (l'RPC agents:create
// vive nel daemon; il main si limita ad aprire la finestra).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAIN_INDEX = fileURLToPath(new URL('../index.ts', import.meta.url))

describe('OA1: il main non crea agenti (il bot principale nasce solo dal daemon)', () => {
  it('src/main/index.ts non chiama createAgent né importa listAgents per la corsa del primo avvio', () => {
    const src = readFileSync(MAIN_INDEX, 'utf8')
    expect(src, 'createAgent deve restare fuori dal main UI: il bot lo crea solo il daemon')
      .not.toMatch(/\bcreateAgent\s*\(/)
    expect(src, 'nemmeno l\'import di createAgent deve tornare nel main UI')
      .not.toMatch(/import[^\n]*\bcreateAgent\b/)
  })
})
