// C1 (fase linguaggio): AppLogo — il logo di una app del catalogo, pezzo
// D'IDENTITÀ del catalogo ui/ (viene da AppsWindow via components/plugin/).
// Il file del catalogo (o un data: URL) oppure, quando manca, l'iniziale su
// una piastrella tenue. La MISURA la dà chi lo rende, con `className`:
// size-8 nelle righe e size-10 nelle testate di scheda (DS1), e la taglia
// dell'iniziale. Il raggio e il fondo del tema scuro sono di lib/app-logos,
// in un posto solo. Niente emoji al posto del logo: chi non ha un file
// mostra l'iniziale.
import { catalogLogoUrl, LOGO_CLASS, LOGO_TILE_CLASS } from '../../lib/app-logos'

export function AppLogo({ logo, name, className = 'size-10 text-reading' }: { logo: string | null; name: string; className?: string }) {
  const url = catalogLogoUrl(logo)
  if (url || logo?.startsWith('data:')) {
    return <img src={url ?? logo!} alt="" className={`${LOGO_CLASS} ${className}`} />
  }
  return (
    <span className={`grid place-items-center ${LOGO_TILE_CLASS} ${className}`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
