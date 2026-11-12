// G3 (fase guida): le parti PURE del passo «Tu» — il nome del bot principale
// come lo salva la guida (spazi ai bordi tolti, tetto di 40 caratteri, vuoto
// = «Bot», il nome con cui il daemon lo ha creato).
export const GUIDE_NAME_MAX = 40

/** Il nome predefinito del bot principale (lo stesso del daemon). */
export const GUIDE_NAME_FALLBACK = 'Bot'

/**
 * (PURA) Il nome da salvare: spazi ai bordi tolti, al massimo 40 caratteri,
 * vuoto → «Bot». Il campo della guida porta il valore GREZZO (maxLength 40
 * in UI): la normalizzazione sta qui, in un punto solo.
 */
export function guideNameOf(raw: string): string {
  const t = raw.trim().slice(0, GUIDE_NAME_MAX)
  return t || GUIDE_NAME_FALLBACK
}
