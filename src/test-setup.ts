// N2 (fase 13 correzioni 3): rete di sicurezza della corsa vitest — NESSUN
// test arriva alla home dell'utente. dataDir() di store/db ripiega su
// ~/.sandbot/data quando non è impostata (SANDBOT_DATA_DIR o setDataDir):
// dopo un test che apriva il DB vero senza cartella dati, lì erano finiti
// sandbot.db e i file WAL. Qui l'env punta a una temporanea PER TUTTA la
// corsa, cancellata alla fine (afterAll di ogni file + uscita del processo:
// rmSync force è idempotente). I test che vogliono una loro cartella la
// impostano come sempre — setDataDir vince su ogni env.
import { afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'sandbot-vitest-data-'
const current = process.env.SANDBOT_DATA_DIR
if (!current?.includes(PREFIX) || !existsSync(current)) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX))
  process.env.SANDBOT_DATA_DIR = dir
  const clean = () => rmSync(dir, { recursive: true, force: true })
  afterAll(clean) // fine del file di test (un worker per file, in forks)
  process.on('exit', clean) // se il processo muore prima dell'afterAll
}

// fase 17c (C1): la lingua dell'interfaccia dei test è l'italiano — i testi
// salvati del daemon restano italiani come prima della 17c. La scrivono i
// file che la usano (dopo il loro setDataDir), NON qui: aprire il DB in un
// setup globale anticiperebbe il singleton di store/db e romperebbe i test
// di migrazione che creano un DB vecchio nella LORO cartella dati.
