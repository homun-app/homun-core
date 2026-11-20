// AH5/AH6 (fase aiutanti): l'USCITA DI RETE dei COMANDI del box — PURA.
//
// Apple container: la rete del box è DEDICATA e nasce `--internal`
// (appleNetworkCreateArgv: host-only), sia homun-box (bridge) sia
// homun-box-isolated (none) → i comandi NON escono su internet ('none'). Il
// browser del bot esce dal proxy controllato, ma quello non è run-command.
//
// Docker: il box sta sulla rete `bridge` DI DOCKER (dockerBoxCreateArgv:
// `--network bridge`), la rete predefinita del runtime, che fa NAT
// (masquerade) verso internet attraverso l'host → i comandi ESCONO
// direttamente ('direct'). La modalità none non ha interfaccia → 'none' per
// entrambi i motori.
//
// 'none' → dopo contenuti non fidati il comando nel box NON torna a chiedere
// (non può far uscire niente) e il prompt/descrizione dicono che per il web ci
// sono web_fetch e il browser. 'direct' → tutto come oggi.
export type ShellEgress = 'none' | 'direct'

/** L'uscita di rete dei comandi del box, dato il motore e la modalità di rete. */
export function boxShellEgress(engine: 'apple-container' | 'docker', network: 'bridge' | 'none'): ShellEgress {
  if (network === 'none') return 'none'
  return engine === 'apple-container' ? 'none' : 'direct'
}

/**
 * N1 (fase mcp-egress-sicurezza): il motore GARANTISCE che il proxy di uscita
 * è l'unica via? Solo con 'none' (rete interna del box) il recinto dei server
 * npm è un muro; con 'direct' il processo può aprire connessioni proprie e
 * l'allowlist del proxy resta un consiglio.
 */
export function npmEgressGuaranteedBy(egress: ShellEgress): boolean {
  return egress === 'none'
}

/**
 * N1: la frase del rifiuto, in parole (bot, card e foglio del server). Con
 * Docker il computer isolato ha internet libero: i server npm non verificati
 * non partono.
 */
export const NPM_SERVERS_EGRESS_REFUSED =
  'With the Docker engine the isolated computer has unrestricted internet: unverified npm servers do not start. Use the Apple engine, or import the server from Cursor, Claude or Zcode.'

/**
 * AH6 (fase aiutanti): la riga UNICA che dice al modello che i comandi del
 * box non escono su internet — nella descrizione di run-command e nel prompt.
 */
export const BOX_NO_INTERNET_LINE =
  'In this computer commands have no internet: for the web use web_fetch or the browser.'

/**
 * AH6 (fase aiutanti): la nota in coda al result di un comando del box che
 * fallisce con un errore di nome o di rete (l'utente vede «Could not resolve
 * host» tre volte di fila, il modello non sa perché). PURA.
 */
export const BOX_NO_INTERNET_NOTE =
  '[note: the bot computer has no internet for commands: use web_fetch or the browser]'

const NETWORK_ERROR_RE =
  /Could not resolve host|Temporary failure in name resolution|Network is unreachable/i

/** La nota in coda SOLO se l'output contiene un errore di nome/rete. PURA. */
export function withNoInternetNote(output: string): string {
  return NETWORK_ERROR_RE.test(output) ? `${output}\n${BOX_NO_INTERNET_NOTE}` : output
}
