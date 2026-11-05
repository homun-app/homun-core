// Fase mcp-setup (M1): le variabili dei remotes del registro (`{var}` nell'URL
// e negli header) come moduli PURI condivisi fra main e renderer — il main
// risolve i template alla connessione, il renderer li mostra nel modulo di
// configurazione (campi, pulizia dei valori, validazione). Come
// resolvePluginUserConfig/unresolvedUserConfigKeys per i ${VAR} dei plugin:
// un `{var}` rimasto senza valore lascia needsAuth e il server NON parte
// (niente stringhe vuote, niente URL con le graffe).
/** La descrizione di una variabile del registro (da `remotes[].variables` o `headers[].variables`). */
export interface RegistryVarSpec {
  name: string
  description?: string
  placeholder?: string
  isRequired?: boolean
  isSecret?: boolean
  /** valore di default del registro: se c'è, la variabile non si chiede */
  default?: string
}

/** Un header del remote: nome, template del valore e le sue variabili. */
export interface RegistryHeaderSpec {
  name: string
  valueTemplate: string
  isRequired?: boolean
  isSecret?: boolean
  description?: string
  variables: RegistryVarSpec[]
}

/** Le variabili `{var}` di un template, in ordine di prima comparsa (puro). */
export function templateVarNames(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(/\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}/g)) {
    const name = m[1]!
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Sostituisce `{var}` coi valori (puro): le variabili senza valore RESTANO
 * letterali — sono loro che `missingTemplateVars` raccoglie e che lasciano
 * needsAuth sul server.
 */
export function fillTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}/g, (whole, name: string) =>
    values[name] !== undefined && values[name] !== '' ? values[name]! : whole
  )
}

/** Le variabili rimaste SENZA valore dopo fillTemplate (puro): il server non parte. */
export function missingTemplateVars(filled: string): string[] {
  return templateVarNames(filled)
}

/**
 * Una variabile dell'URL è obbligatoria se il registro la dichiara
 * `isRequired` OPPURE se compare nell'URL e non ha un default: un URL con un
 * buco non parte (M1.1, puro).
 */
export function urlVarIsRequired(spec: RegistryVarSpec, urlTemplate: string): boolean {
  if (spec.isRequired === true) return true
  if (spec.default !== undefined && spec.default !== '') return false
  return templateVarNames(urlTemplate).includes(spec.name)
}

// ---- la pulizia dei valori che l'utente incolla (M1.4 + M3, pura) ----

/**
 * Il valore destinato all'HOST dell'URL si ripulisce (puro): «https://chat.example.com/»
 * diventa «chat.example.com» (lo schema lo mette il template, come la barra
 * finale che non si vuole due volte).
 */
export function cleanHostValue(raw: string): string {
  return raw
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/^http:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** Il valore di una variabile SEGRETA: un «Bearer » già incollato si toglie, lo mette il template (puro). */
export function cleanSecretValue(raw: string): string {
  const t = raw.trim()
  return /^bearer\s+/i.test(t) ? t.replace(/^bearer\s+/i, '') : t
}

/**
 * L'errore di un valore destinato all'host dell'URL (puro, null = va bene):
 * niente `/` (un percorso non è un host), niente `@` (userinfo), niente
 * spazi; il valore deve dare un URL valido quando entra nel template.
 */
export function hostValueError(raw: string): string | null {
  const v = cleanHostValue(raw)
  if (!v) return 'vuoto'
  if (/\s/.test(v)) return 'spazi'
  if (v.includes('@')) return '@'
  if (v.includes('/')) return '/'
  return null
}

/**
 * La validazione vera di un URL RISOLTO (puro): https in produzione, http
 * SOLO col flag di test della verifica d'integrazione (come remoteUrlOk del
 * registro, ma qui vale per il renderer del modulo).
 */
export function resolvedUrlOk(url: string, allowHttpForTests = false): boolean {
  if (!/^https:\/\//.test(url)) return allowHttpForTests && /^http:\/\//.test(url)
  try {
    // eslint-disable-next-line no-new
    new URL(url)
    return true
  } catch {
    return false
  }
}

// ---- il RUOLO di una variabile nell'URL (R6, puro) ----

/** Il ruolo di una variabile del template: host, url intero, o testo. */
export type VarRole = 'host' | 'url' | 'text'

/**
 * R6 (puro): il ruolo di una variabile dipende dalla POSIZIONE nell'URL, non
 * dal nome — una `{base_url}` usata come URL intero (template `{base_url}/mcp`)
 * non va spogliata dello schema come un host.
 * - **host**: la variabile sta subito dopo `://` → pulizia e validazione di
 *   oggi (cleanHostValue/hostValueError), etichetta «Indirizzo del server X»;
 * - **url**: il template COMINCIA con `{var}` → il valore è un URL https
 *   (http solo col flag di test), lo schema NON si toglie, stessa etichetta;
 * - **text**: tutti gli altri casi → nessuna validazione da host, etichetta
 *   dal nome pulito.
 */
export function varRole(name: string, urlTemplate: string): VarRole {
  const v = `{${name}}`
  if (urlTemplate.includes(`://${v}`)) return 'host'
  if (urlTemplate.startsWith(v)) return 'url'
  return 'text'
}

// ---- le etichette umane del modulo (M3.1 + R6, pure) ----

/**
 * L'etichetta umana di una variabile (puro): host e url sono l'INDIRIZZO del
 * servizio («Indirizzo del server X»); gli altri il nome pulito in
 * maiuscoletto. R6: lo si capisce dalla POSIZIONE nel template (varRole),
 * non più dal nome. Torna una STRUTTURA, non testo: il componente la traduce
 * con Lingui («Indirizzo del server X» / il nome pulito così com'è).
 */
export function varLabel(name: string, serverName: string, urlTemplate = ''): { addressOf: string } | { plain: string } {
  const role = varRole(name, urlTemplate)
  if (role === 'host' || role === 'url') return { addressOf: serverName }
  const clean = name.replace(/[_-]+/g, ' ').trim()
  return { plain: clean.charAt(0).toUpperCase() + clean.slice(1) }
}

/**
 * Quando il pulsante del modulo è ATTIVO (puro, M3 + R6): tutti i campi
 * OBBLIGATORI non segreti sono pieni e VALIDI (secondo il RUOLO: host come
 * oggi, url un URL https — http solo col flag di test), e il token c'è quando
 * è la via obbligatoria (auth 'headers' e non ancora salvato).
 */
export function setupCanConnect(
  fields: Array<{ name: string; isRequired: boolean; isSecret: boolean; value?: string; saved?: boolean }>,
  values: Record<string, string>,
  opts: { tokenRequired: boolean; token: string; tokenSaved: boolean; urlTemplate?: string; allowHttpForTests?: boolean }
): boolean {
  for (const f of fields) {
    if (!f.isRequired) continue
    if (f.isSecret) {
      if (!f.saved) return false
      continue
    }
    const v = (values[f.name] ?? f.value ?? '').trim()
    if (!v) return false
    const role = varRole(f.name, opts.urlTemplate ?? '')
    if (role === 'host' && hostValueError(v)) return false
    if (role === 'url' && !resolvedUrlOk(v, opts.allowHttpForTests ?? false)) return false
  }
  if (opts.tokenRequired && !opts.tokenSaved && !opts.token.trim()) return false
  return true
}
