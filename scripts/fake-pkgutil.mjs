#!/usr/bin/env node
// OB6 (fase onboarding-b): il PKGUTIL FINTO — risponde a
// `--check-signature <pkg>` con l'esito scelto dall'env:
//   SANDBOT_TEST_PKGUTIL_RESULT=ok (default)  firmato con un certificato
//                                             Developer ID di Apple, catena
//                                             fidata (esce 0, come il vero)
//   SANDBOT_TEST_PKGUTIL_RESULT=ko            nessuna firma (esce 1)
// Nessun pkgutil vero, nessuna firma calcolata: è il server della sonda che
// serve il pacchetto FINTO su 127.0.0.1 e questo script che ne conferma
// l'autenticità finta. La foglia porta un Team ID FINTO e marcato: quello
// vero lo fissa l'utente dopo la prova dal vivo.
const argv = process.argv.slice(2)
const out = (s) => { process.stdout.write(`${s}\n`) }
const die = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code) }

if (argv[0] !== '--check-signature') die(64, 'fake pkgutil: uso --check-signature <pkg>')
const pkg = argv[1] ?? ''

if (process.env.SANDBOT_TEST_PKGUTIL_RESULT === 'ko') {
  out(`Package "${pkg.split('/').pop() ?? ''}":`)
  out('   Status: no signature')
  die(1, 'fake pkgutil: the package is not signed')
}

out(`Package "${pkg.split('/').pop() ?? ''}":`)
out('   Status: signed by a developer certificate issued by Apple for distribution')
// OBR3: la riga della notarizzazione è quella VERA di pkgutil («Notarization:
// trusted by the Apple notary service») — la vecchia riga inventata «Status:
// Trusted by the Apple notary service» il parse di produzione non la accetta più
out('   Notarization: trusted by the Apple notary service')
out('   Certificate Chain:')
// OBV6: la foglia È quella vera vista dal vivo — il Team ID lo conosciamo
out('    1. Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)')
out('       SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
out('       Expires: 2028-01-01 00:00:00 +0000')
out('    2. Developer ID Certification Authority')
out('       Expires: 2036-01-01 00:00:00 +0000')
out('    3. Apple Root CA')
out('       Expires: 2040-01-01 00:00:00 +0000')
process.exit(0)
