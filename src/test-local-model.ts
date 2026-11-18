// C3 (fase ci-temporanei): i modelli locali si cercano in UN posto solo per
// gli skipIf dei test. La variabile SOLO-TEST SANDBOT_TEST_NO_LOCAL_MODELS=1
// li fa risultare ASSENTI, come sul runner della CI: là ~/.cache/engramma/
// models manca e i describe.skipIf saltano i file per intero. La imposta
// npm run test:ci-sim, così la simula sul Mac (dove i modelli ci sono) salta
// gli stessi file e vede quello che vede la CI.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Il modello di embedding locale, come lo guardano i test e la sezione modelli. */
export const LOCAL_EMBED_MODEL = join(
  homedir(), '.cache', 'engramma', 'models', 'granite-embedding-97m-multilingual-r2',
)

/** true se il modello locale c'è — a meno che la prova della CI non lo nasconda. */
export const hasLocalEmbedModel = (): boolean =>
  process.env.SANDBOT_TEST_NO_LOCAL_MODELS !== '1' && existsSync(LOCAL_EMBED_MODEL)
