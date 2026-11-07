// Fase eval-deboli (D1): la coercizione degli argomenti dei tool — modulo
// PURO. I modelli scrivono i primitivi come stringhe ("true", "60") e i
// controlli di prodotto (input.background === true, input.kill === true)
// falliscono in silenzio. Prima di eseguire, i primitivi si CONVERTONO verso
// il tipo dichiarato nello schema JSON del tool (come coerceTypes di Ajv e
// validateToolArguments di pi-ai, ma senza mai lanciare errori: qui si
// converte e basta). L'input non si tocca mai: in uscita un oggetto NUOVO.

/** Un sotto-schema JSON (type può essere stringa o array di stringhe). */
export type ToolArgSchema = Record<string, unknown> | undefined

/** I tipi dichiarati da uno schema ([] se non li dichiara). */
function typesOf(s: ToolArgSchema): string[] {
  if (!s) return []
  const t = s.type
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  return []
}

/**
 * Converte UN valore stringa verso il tipo dichiarato (pura): "true"/"false"
 * con trim e maiuscole indifferenti → booleano; stringa numerica finita →
 * numero (per integer solo se intera). Ogni altro valore, e le stringhe dove
 * lo schema dice string, restano invariate.
 */
function coercePrimitive(value: string, s: ToolArgSchema): string | boolean | number {
  const types = typesOf(s)
  if (types.length === 0) return value
  const trimmed = value.trim()
  if (types.includes('boolean')) {
    const lower = trimmed.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }
  if (types.includes('number') || types.includes('integer')) {
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      const n = Number(trimmed)
      if (!types.includes('integer') || Number.isInteger(n)) return n
    }
  }
  return value
}

/** Converte un valore qualunque contro il suo (sotto-)schema: scende in properties e items. */
function coerceValue(value: unknown, s: ToolArgSchema): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return coercePrimitive(value, s)
  if (!s) return value
  if (Array.isArray(value)) {
    const items = s.items as ToolArgSchema
    if (!items || typeof items !== 'object') return value
    let changed = false
    const out = value.map((x) => {
      const c = coerceValue(x, items)
      if (c !== x) changed = true
      return c
    })
    return changed ? out : value
  }
  if (typeof value === 'object') return coerceObject(value as Record<string, unknown>, s)
  return value
}

/** Converte le chiavi di un oggetto contro le properties dello schema (le chiavi fuori schema restano). */
function coerceObject(obj: Record<string, unknown>, schema: ToolArgSchema): Record<string, unknown> {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (!props || typeof props !== 'object') return obj
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const c = props[k] ? coerceValue(v, props[k]) : v
    if (c !== v) changed = true
    out[k] = c
  }
  return changed ? out : obj
}

/**
 * coerceToolArgs (pura, D1): converte i primitivi scritti come stringhe verso
 * il tipo dichiarato nello schema JSON del tool. Converte SOLO dove lo schema
 * dichiara boolean, number o integer (anche dentro oggetti e array, e coi tipi
 * in array tipo ['boolean','null']); tutto il resto — le stringhe dove lo
 * schema dice string, i valori che non si convertono, le chiavi fuori schema e
 * null — resta invariato. Senza schema restituisce l'input identico; con lo
 * schema restituisce un oggetto NUOVO (l'input non si modifica mai) e se
 * nulla cambia restituisce l'oggetto di partenza.
 */
export function coerceToolArgs(
  args: Record<string, unknown>,
  schema: ToolArgSchema
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return args
  return coerceObject(args, schema)
}
