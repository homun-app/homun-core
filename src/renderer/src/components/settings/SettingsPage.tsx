// Fase impostazioni (I5): la pagina di una sezione — titolo + gruppi, lo
// stesso modello di sempre (pagina = titolo + 1–3 gruppi).
//
// Fase design (DS4, Impostazioni): il TITOLO non lo fa più la pagina. Era in
// testa al contenuto che scorre, con 48 px vuoti a destra (pr-12) per la ✕ e
// una colonna di 768 px scritta a mano (max-w-3xl): la colonna non era
// centrata e la barra di scorrimento nasceva dentro. Ora il titolo della
// sezione e la ✕ stanno nella riga FERMA del dialogo (Settings.tsx), alla
// stessa larghezza del contenuto (PageColumn), e la pagina è soltanto il suo
// ritmo: i gruppi a 32 px l'uno dall'altro (gap-section, la distanza fra
// sezioni di DS1 — prima 24). È un contenitore a blocchi: dentro c'è la
// colonna del dialogo (PageColumn), che decide quanto è larga.
import type { ReactNode } from 'react'

export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-section">{children}</div>
}
