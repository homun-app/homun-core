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
