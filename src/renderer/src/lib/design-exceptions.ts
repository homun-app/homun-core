// Fase design (DS6): le ECCEZIONI della guardia sul sorgente
// (__tests__/design-guard.test.ts). Le regole valgono per tutto il renderer;
// OGNI eccezione vive qui, con il motivo. La guardia fallisce se un'esenzione
// è morta (non copre più nulla): così l'elenco non marcisce.
//
// Sta qui anche, PROVVISORIO, l'elenco delle pagine non ancora migrate a DS4:
// la guardia non le guarda finché non tocca a loro. A ogni commit di DS4 la
// sua pagina esce dall'elenco; a fine DS4 l'elenco è vuoto (lo impone un test)
// e da lì non ci sono più aree fuori dalla guardia.

export type DesignRule =
  | 'text-arbitrary'
  | 'text-tailwind'
  | 'spacing-arbitrary'
  | 'radius-arbitrary'
  | 'radius-other'
  | 'width-px'
  | 'uppercase-tracking'
  | 'emoji'

export interface DesignException {
  /** nome corto, per il REPORT */
  id: string
  rule: DesignRule
  /** ciò che l'esenzione toglie dal testo PRIMA di applicare la regola (globale: tutte le occorrenze) */
  pattern: RegExp
  /** il motivo: perché questa eccezione resta */
  reason: string
}

export const DESIGN_EXCEPTIONS: readonly DesignException[] = [
  {
    id: 'colore-con-var',
    rule: 'text-arbitrary',
    // `text-[var(--…)]` è un COLORE dato con una variabile, non una dimensione
    pattern: /\btext-\[var\(--[a-z0-9-]+\)\]/g,
    reason: 'text-[var(--…)] è un colore letto da una variabile del tema (per esempio il testo della bolla dell’utente), non una dimensione di testo.'
  }
]

/**
 * Aree del renderer NON ancora migrate al sistema (relative a
 * src/renderer/src, con la barra finale): la guardia le salta. PROVVISORIO
 * fino a fine DS4.
 */
export const MIGRATION_PENDING: readonly string[] = [
  'components/',
  'lib/',
  'App.tsx',
  'main.tsx',
  'sidebar-utils.ts',
  'store.ts',
  'theme.ts'
]
