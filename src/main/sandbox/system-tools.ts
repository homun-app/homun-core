// OBR1 (fase onboarding-b-rafforzamenti): gli strumenti DI SISTEMA si
// chiamano col loro PERCORSO ASSOLUTO, mai per nome nel PATH. Un PATH che
// contiene cartelle scrivibili dall'utente (Homebrew, ~/bin) può mettere
// davanti un falso pkgutil o spctl che dice sempre OK, o un falso osascript
// che mostra una sua finestra per la password. Le quattro costanti stanno
// QUI, in un solo modulo, e il test system-tools.test.ts le blocca; in
// produzione si usano SOLO queste (gli override SANDBOT_TEST_* valgono per
// le prove e sono ignorati dall'app impacchettata, come sempre).
export const SYSTEM_PKGUTIL = '/usr/sbin/pkgutil'
export const SYSTEM_SPCTL = '/usr/sbin/spctl'
export const SYSTEM_OPEN = '/usr/bin/open'
export const SYSTEM_OSASCRIPT = '/usr/bin/osascript'
