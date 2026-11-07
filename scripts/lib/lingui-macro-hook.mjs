// Fase token (T0): hook di risoluzione che devia '@lingui/core/macro' sullo
// stub runtime di fianco (scripts/lib/lingui-macro-stub.mjs). Lo registra
// scripts/turn-tokens.ts PRIMA degli import dinamici dei moduli del main:
// senza, la catena tools.ts → db.ts → ui-messages.ts non valuta fuori da
// vitest. Ogni altro specifier passa all'hook successivo (quello di tsx).
import { pathToFileURL } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier === '@lingui/core/macro' || specifier === '@lingui/macro') {
    return { url: pathToFileURL(new URL('./lingui-macro-stub.mjs', import.meta.url).pathname).href, shortCircuit: true }
  }
  return next(specifier, context)
}
