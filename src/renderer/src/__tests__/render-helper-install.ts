// RV (fase beta.2) — SUPPORTO AI TEST DEL RENDERER SENZA DOM: questo repo non
// ha jsdom né Testing Library (e i vincoli della fase vietano i download), ma
// i componenti si rendono DAVVERO con react-dom/server in ambiente node.
// Questo modulo va IMPORTATO PER PRIMO nel file di test: definisce
// window.sandbot PRIMA che src/renderer/src/store.ts (che lo legge al
// caricamento) venga valutato dalla catena degli import statici.
//
// L'api finta registra OGNI chiamata ( metodo, argomenti ) e risolve una
// Promise; i test possono decidere la risposta di un metodo con stubApiMethod.
type FakeHandler = (...args: unknown[]) => unknown

export interface FakeApiCall {
  method: string
  args: unknown[]
}

const calls: FakeApiCall[] = []
const handlers = new Map<string, FakeHandler>()

function makeFn(method: string): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => {
    calls.push({ method, args })
    const h = handlers.get(method)
    const r = h ? h(...args) : undefined
    return r instanceof Promise ? r : Promise.resolve(r)
  }
}

const api: unknown = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (typeof prop === 'symbol') return undefined
      return makeFn(prop)
    }
  }
)

const g = globalThis as unknown as {
  window?: { sandbot: unknown; innerWidth: number; localStorage?: unknown }
}
// store.ts legge (window as …).sandbot al CARICAMENTO del modulo: qui window
// c'è già, con l'api finta (innerWidth come nel default dello store)
g.window = { sandbot: api, innerWidth: 1280 }

/** Tutte le chiamate fatte all'api finta, in ordine. */
export const fakeApiCalls = calls

/** Decide la risposta di un metodo (i valori di ritorno sincroni vengono impacchettati). */
export function stubApiMethod(method: string, fn: FakeHandler): void {
  handlers.set(method, fn)
}

/** Le chiamate a un metodo dato (comodo per asserire una settingsSet). */
export function callsOf(method: string): FakeApiCall[] {
  return calls.filter((c) => c.method === method)
}
