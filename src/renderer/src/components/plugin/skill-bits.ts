// C0 (fase linguaggio): i pezzi in comune dei file della skill (editor,
// dettaglio di plugin, anteprima del catalogo) — erano le costanti in cima a
// SkillsWindow.tsx, smontato: un file per cosa, e questi sono delle cose
// condivise, non una finestra.
import type { useLingui } from '@lingui/react/macro'

/** L'i18n di un problema di validazione (S1): l'id del catalogo, con i valori. */
export function issueText(i: { uiId: string; values?: Record<string, string | number> }, i18n: { _(m: unknown, values?: Record<string, unknown>): string }): string {
  return i18n._({ id: i.uiId }, i.values)
}

/** «‹ Indietro» in cima a un foglio: testo grigio, in una casa alta 32 (un bottone, non una riga di testo da 18 px). */
export const BACK = 'flex h-control-sm items-center gap-1 text-small text-muted-foreground transition hover:text-foreground'

/** La piastrella davanti al nome di una skill del catalogo o di un plugin (40: il logo delle testate di scheda). */
export const TILE = 'grid size-10 shrink-0 place-items-center rounded-surface bg-muted text-muted-foreground'
