// E1 (fase mcp-env): l'euristica del nome di variabile «segreto» — la usano
// il form del renderer e lo split del daemon: UNA sola verità condivisa.
const SECRET_NAME_RE = /TOKEN|KEY|SECRET|PASSWORD|AUTH/i

/** Il nome contiene TOKEN, KEY, SECRET, PASSWORD o AUTH → segreto di default. */
export function envNameLooksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name)
}
