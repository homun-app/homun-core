// C0.7 (fase linguaggio): il controllo dei temporanei della corsa di
// fatto.mjs, in funzioni PURE così la si prova da sola (il test
// scripts/__tests__/temporanei-fatto.test.ts l'ha vista ROSSA prima).
//
// La regola: la corsa ha una RADICE SUA (una fatto-* con mkdtemp nella base
// dei vincoli, passata come TMPDIR a tutti i passi) che a fine corsa deve
// essere VUOTA; nella T/ comune contano SOLO i prefissi del repo — tutto il
// resto (le zcode-bash-*, le socket znr*.sock, le atuin-hook-exec-* delle
// altre app) non è affare della corsa. I prefissi sono letti dal codice, non
// a memoria: tutto ciò che il repo scrive nella T/ comune comincia per
// sandbot- (i test con l'aiutante src/test-tmp.ts, la radice vitest
// sandbot-vitest-run-, i dati sandbot-vitest-data-, le sonde sandbot-fase-*,
// la galleria sandbot-galleria-, il censimento sandbot-esporta-inutilizzati-)
// più fatto- per la radice della corsa stessa.

/** I prefissi del repo nella T/ comune: ciò che la corsa può lasciare (e che NON deve restare). */
export const PREFISSI_REPO = ['sandbot-', 'fatto-']

/** Le voci di un elenco che portano un prefisso del repo. */
export function filtraRepo(nomi) {
  return nomi.filter((n) => PREFISSI_REPO.some((p) => n.startsWith(p)))
}

/**
 * Le NUOVE del repo nella T/ comune: l'intersezione fra le voci nuove della
 * corsa (presenti a fine e non all'inizio) e i prefissi del repo. Il resto —
 * di chiunque altro — non conta: un controllo che fallisce per colpa delle
 * altre app insegna a ignorarlo.
 */
export function nuoveDelRepo(prima, dopo) {
  const primaSet = new Set(prima)
  return filtraRepo(dopo.filter((n) => !primaSet.has(n))).sort()
}

/**
 * I RESIDUI della radice della corsa: l'elenco delle voci rimaste. A fine
 * corsa la radice deve essere VUOTA (poi si cancella): qualunque voce — file o
 * cartella — è un avanzo di un passo che ha scritto nella radice senza
 * pulire.
 */
export function residuiRadice(nomi) {
  return [...nomi].filter((n) => !n.startsWith('.')).sort()
}
