// Fase impostazioni (I5): il gruppo — etichetta piccola grigia sopra una
// scheda (fondo tenue di oggi, rounded-2xl, niente bordi duri) le cui righe
// sono divise da filetti sottili. `footer` è la frase grigia sotto la scheda
// (per esempio il consiglio delle riserve); `card` aggiunge classi alla
// scheda (la griglia dei riquadri di Uso e costi).
import type { ReactNode } from 'react'

export function SettingsGroup({ label, children, footer, card }: {
  label?: ReactNode
  children: ReactNode
  footer?: ReactNode
  card?: string
}) {
  return (
    <section className="block">
      {label !== undefined && <p className="mb-1.5 text-[13px] text-muted-foreground">{label}</p>}
      <div className={`rounded-2xl bg-muted/60 ${card ?? ''}`}>{children}</div>
      {footer !== undefined && <p className="mt-1.5 text-[13px] text-muted-foreground">{footer}</p>}
    </section>
  )
}
