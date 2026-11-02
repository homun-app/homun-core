// Id di build (fase rilascio, A2): electron-vite lo inietta a OGNI build
// (config `define`). La UI lo confronta con quello scritto dal daemon in
// daemon.json: dopo un aggiornamento il daemon VECCHIO va fatto uscire bene
// e rilanciato, non riusato. In vitest/sviluppo senza define vale 'test'.
export const APP_BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'test'
