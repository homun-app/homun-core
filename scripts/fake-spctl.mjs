#!/usr/bin/env node
// OB6 (fase onboarding-b): lo SPCTL FINTO — risponde a
// `--assess --type install <pkg>` con l'esito scelto dall'env:
//   SANDBOT_TEST_SPCTL_RESULT=ok (default)  accettato (esce 0, in silenzio
//                                             come il vero)
//   SANDBOT_TEST_SPCTL_RESULT=ko            rifiutato (esce 3)
// Nessuno spctl vero, nessun Gatekeeper: decide la sonda.
const argv = process.argv.slice(2)
const die = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code) }

if (argv[0] !== '--assess' || argv[1] !== '--type' || argv[2] !== 'install') {
  die(64, 'fake spctl: uso --assess --type install <pkg>')
}
if (process.env.SANDBOT_TEST_SPCTL_RESULT === 'ko') {
  die(3, 'fake spctl: rejected (the package is rejected by Gatekeeper)')
}
process.exit(0)
