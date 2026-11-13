#!/usr/bin/env node
// OB6 (fase onboarding-b): l'OPEN FINTO — finge la finestra dell'Installer
// di macOS: registra la chiamata (`-a Installer <pkg>`, una riga JSON per
// chiamata su $SANDBOT_TEST_OPEN_LOG) e «installa» DOPO un ritardo: copia la
// CLI finta di container nella cartella del PATH di prova
// ($SANDBOT_TEST_OPEN_CLI_SRC → $SANDBOT_TEST_OPEN_INSTALL_DIR), come
// farebbe il pacchetto di Apple mettendola in /usr/local/bin. Come il VERO
// `open`, questo script ESCE SUBITO: l'installazione avviene in un processo
// STACCATO (l'utente che installa dopo un po'), così il daemon non resta ad
// aspettare né va in timeout. NESSUN `open` vero, NESSUN Installer vero,
// NESSUNA password: tutto finto, su cartelle temporanee della sonda.
import { appendFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const die = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code) }

// il processo staccato: aspetta il ritardo e copia la CLI (il timer tiene
// vivo il processo; si esce SOLO a copia fatta). OBD5 (fase
// onboarding-b-dettagli): questo figlio NON è un «open» e NON si registra
// nel log — prima ricadeva nel codice qui sotto e aggiungeva una riga con
// pkg = sorgente della CLI, e il conteggio degli open della sonda ballava
// con una corsa di millisecondi (OB-c3 cadeva a intermittenza)
if (argv[0] === '--__install') {
  const [, delayRaw, cliSrc, installDir] = argv
  const delay = Number(delayRaw)
  setTimeout(() => {
    try {
      copyFileSync(cliSrc, join(installDir, 'container'))
      process.exit(0)
    } catch (e) {
      process.stderr.write(`fake open: installazione finta non riuscita: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    }
  }, Number.isFinite(delay) && delay >= 0 ? delay : 800)
} else if (argv[0] !== '-a' || argv[1] !== 'Installer') {
  die(64, 'fake open: uso -a Installer <pkg>')
} else {
  const pkg = argv[2] ?? ''
  const delay = process.env.SANDBOT_TEST_OPEN_DELAY_MS ?? '800'
  const cliSrc = process.env.SANDBOT_TEST_OPEN_CLI_SRC
  const installDir = process.env.SANDBOT_TEST_OPEN_INSTALL_DIR

  // la registrazione PRIMA di tutto: la sonda prova che l'open C'È STATO
  // (o che NON c'è stato, quando la verifica fallisce)
  if (process.env.SANDBOT_TEST_OPEN_LOG) {
    try {
      appendFileSync(process.env.SANDBOT_TEST_OPEN_LOG, `${JSON.stringify({ at: Date.now(), app: 'Installer', pkg })}\n`)
    } catch { /* best-effort */ }
  }

  // «l'utente ha dato la password e l'Installer ha installato»: come il vero
  // open, si esce SUBITO; l'installazione avviene DOPO, staccato
  if (cliSrc && installDir) {
    const child = spawn(process.execPath, [process.argv[1] ?? '', '--__install', delay, cliSrc, installDir], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  }
  process.exit(0)
}
