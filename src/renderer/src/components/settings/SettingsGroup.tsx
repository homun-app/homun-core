// Fase impostazioni (I5): il gruppo — etichetta piccola grigia sopra una
// scheda (fondo tenue, niente bordi duri) le cui righe sono divise da filetti
// sottili. `footer` è la frase grigia sotto la scheda (per esempio il consiglio
// delle riserve).
//
// Fase design (DS4, Impostazioni): le misure sono quelle di DS1. L'etichetta
// è l'intestazione di gruppo del sistema — text-caption grigia, peso 500, in
// tono normale: PRIMA era 13 px, e nelle finestre di chat in MAIUSCOLETTO con
// le lettere spaziate (DS1: «nessun maiuscoletto da nessuna parte»). È un h3:
// è un'intestazione, sotto il titolo (h2) della sezione.
// La scheda ha il raggio delle superfici (rounded-surface, 14: prima 16) e il
// suo fondo; la si ritaglia ai suoi angoli (overflow-hidden), così il fondo
// tenue dell'hover di una riga larga quanto la scheda non sporge dagli angoli
// arrotondati. Le distanze sono quelle di Section: 12 px (gap-section-head)
// dall'etichetta alla scheda e dalla scheda al footer — prima 6, e l'etichetta
// sembrava incollata alla scheda. Il footer è la riga grigia di DS1
// (text-small).
// `card` (classi in più per la scheda) non c'è più: non lo passava nessuno.
import type { ReactNode } from 'react'

export function SettingsGroup({ label, children, footer }: {
  label?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-section-head">
      {label !== undefined && <h3 className="text-caption font-medium text-muted-foreground">{label}</h3>}
      <div className="overflow-hidden rounded-surface bg-muted/60">{children}</div>
      {footer !== undefined && <p className="text-small text-muted-foreground">{footer}</p>}
    </section>
  )
}
