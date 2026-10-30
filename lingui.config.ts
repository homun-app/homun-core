// Fase 17a (L1): i cataloghi di Lingui. La lingua sorgente è l'italiano —
// i testi curati di oggi restano nel codice e sono la verità; l'inglese è
// una traduzione. Gli id sono hash del testo, quindi sourceLocale decide
// solo cosa sta scritto nel codice. `lineNumbers: false` così uno
// spostamento di righe non riscrive i cataloghi.
// Fase 17c (C1): nel catalogo entrano ANCHE i testi U del daemon e del main
// (src/shared/ui-messages.ts, con id espliciti): un solo .po per lingua, la
// stessa catena di strumenti del renderer.
import { formatter } from '@lingui/format-po'

export default {
  sourceLocale: 'it',
  locales: ['it', 'en'],
  catalogs: [
    {
      path: 'src/renderer/src/locales/{locale}/messages',
      include: ['src/renderer/src', 'src/shared', 'src/main', 'src/daemon'],
      exclude: ['**/locales/**', '**/__tests__/**', '**/*.test.*']
    }
  ],
  format: formatter({ lineNumbers: false })
}
