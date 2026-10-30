// Limiti e costanti dei tool web (fase 11, punto 2) — condivisi da main,
// eval e test: qui niente dipendenze, solo numeri e testi.
export const WEB_FETCH_MAX_CHARS = 20_000
export const WEB_FETCH_TIMEOUT_MS = 20_000
export const WEB_FETCH_MAX_BYTES = 3 * 1024 * 1024
export const WEB_FETCH_MAX_REDIRECTS = 5
export const WEB_FETCH_CACHE_MS = 15 * 60_000
export const WEB_SEARCH_DEFAULT_RESULTS = 5
export const WEB_SEARCH_MAX_RESULTS = 10
// fase 15 (S1): timeout di OGNI chiamata ai provider di ricerca (keyless e no)
export const WEB_SEARCH_TIMEOUT_MS = 15_000
/** User-agent onesto di ogni richiesta web di SandBot (ricerca e lettura). */
export const SANDBOT_USER_AGENT = 'Homun/0.1.0'
