// Fase 17c (C1): i cataloghi compilati da `lingui compile` (output .mjs,
// con allowJs: false servono i tipi). Il contenuto è un record di messaggi
// nel formato compilato di Lingui.
declare module '*/messages.mjs' {
  export const messages: Record<string, unknown>
}
