// Fase token (T0): stub RUNTIME delle macro di Lingui per eseguire i moduli
// del main fuori da vitest (scripts/turn-tokens.ts gira con tsx, che non ha il
// babel-plugin di Lingui). Le macro vengono trasformate solo sotto
// vitest/babel: qui servono SOLO le firme che lasciano valutare i moduli (il
// testo italiano di partenza), non la traduzione — lo script conta caratteri.
export default {}
export const t = (m) => (typeof m === 'object' && m !== null ? m.message : m)
export const msg = (m) => (typeof m === 'object' && m !== null ? m.message : m)
export const ph = (m) => m
export const defineMessage = (m) => m
export const plural = (a) => (a && typeof a === 'object' ? (a.other ?? a.one ?? '') : '')
export const select = (a) => (a && typeof a === 'object' ? Object.values(a)[0] ?? '' : '')
export const selectOrdinal = (a) => (a && typeof a === 'object' ? (a.other ?? '') : '')
