// Fase impostazioni (I5): il gruppo — etichetta piccola grigia sopra le RIGHE
// A FILO, divise da filetti sottili. `footer` è la frase grigia sotto.
//
// Fase design (DS4): l'etichetta è l'intestazione di gruppo del sistema —
// text-caption grigia, peso 500, in tono normale: PRIMA era 13 px, e nelle
// finestre di chat in MAIUSCOLETTO con le lettere spaziate (DS1: «nessun
// maiuscoletto da nessuna parte»). È un h3: è un'intestazione, sotto il
// titolo (h2) della sezione. Le distanze sono quelle di Section: 12 px
// (gap-section-head) dall'etichetta alle righe e dalle righe al footer. Il
// footer è la riga grigia di DS1 (text-small).
//
// C3 (fase linguaggio): NESSUN riquadro grigio attorno alle righe — le
// Impostazioni usano le STESSE righe delle pagine (il modello ListGroup: il
// gruppo si riconosce dal titolo, la riga dal segno). La scheda col fondo
// tenue esce; restano l'etichetta e le righe a filo (divide-y).
import type { ReactNode } from 'react'

export function SettingsGroup({ label, children, footer }: {
  label?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-section-head">
      {label !== undefined && <h3 className="text-caption font-medium text-muted-foreground">{label}</h3>}
      <div className="divide-y divide-border/50">{children}</div>
      {footer !== undefined && <p className="text-small text-muted-foreground">{footer}</p>}
    </section>
  )
}
