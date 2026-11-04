// Fase impostazioni (I5): il titolo di pagina, SEMPRE in testa (il modello di
// Rakazo: pagina = titolo + 1–3 gruppi). Lo stesso font/size del titolo
// «Modelli» di oggi (font-display text-2xl); lo spazio a destra resta per la ✕
// del dialogo, che vive fuori (pr-12 come le pagine di oggi).
import type { ReactNode } from 'react'

export function SettingsPage({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-6 pr-12">
      <h2 className="font-display text-2xl">{title}</h2>
      <div className="max-w-3xl space-y-6">{children}</div>
    </div>
  )
}
