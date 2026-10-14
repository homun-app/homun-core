/**
 * Il markup renderizzato di un avviso visto dal lato dell'invariante
 * «dettagli tecnici»: il testo grezzo può esistere solo dentro il blocco
 * `<details>`, che di default sta chiuso.
 */

/** Il markup senza i blocchi `<details>…</details>`: ciò che l'utente vede. */
export function outsideDetailsBlock(markup: string): string {
  return markup.replace(/<details[\s\S]*?<\/details>/g, "");
}

/** Il primo blocco `<details>…</details>` del markup, o null se assente. */
export function detailsBlock(markup: string): string | null {
  const match = /<details[\s\S]*?<\/details>/.exec(markup);
  return match ? match[0] : null;
}

/** Il blocco è chiuso di default: nessun attributo `open` nel tag di apertura. */
export function detailsIsClosed(details: string): boolean {
  return !/^<details[^>]*\sopen(?:[\s=>]|>)/.test(details);
}
