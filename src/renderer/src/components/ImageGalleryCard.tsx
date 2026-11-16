// Card della galleria (fase chat-limiti, CL3): le foto di una pagina letta
// con web_fetch nel turno, mostrate dal tool show_images. Le miniature si
// caricano dal protocollo dell'app (homun://app/media/<hash>.<ext> — vedi
// shared/chat-images): la chat NON contatta mai il sito remoto (privacy: il
// sito non deve vedere l'IP dell'utente). Sotto ogni miniatura il dominio di
// provenienza e il link alla pagina; un clic apre l'immagine grande.
import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import { galleryCardRows } from '../../../shared/chat-images'
import { CardShell } from './DecidedRow'

export function ImageGalleryCard({ entry }: { entry: TranscriptEntry }) {
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessagePayload, { type: 'images' }> | undefined
  const [zoom, setZoom] = useState<number | null>(null)
  if (!message) return null
  const rows = galleryCardRows(message.images)
  if (!rows.length) return null
  const zoomed = zoom !== null ? rows[zoom] : null
  return (
    <CardShell testid="image-gallery">
      {message.caption && <p className="text-sm text-foreground">{message.caption}</p>}
      <div className="mt-1 flex flex-wrap gap-2">
        {rows.map((r, i) => (
          <figure key={r.src} className="w-36">
            <button
              type="button"
              className="block w-full overflow-hidden rounded-[12px] bg-card transition hover:opacity-90"
              onClick={() => setZoom(i)}
              title={r.domain}
            >
              {/* il src è SEMPRE homun:// (galleryCardRows scarta tutto il resto) */}
              <img src={r.src} alt={r.alt} loading="lazy" className="h-24 w-full object-cover" />
            </button>
            <figcaption className="mt-1 flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
              <span className="truncate">{r.domain}</span>
              {r.pageUrl && (
                <a href={r.pageUrl} target="_blank" rel="noreferrer" className="shrink-0 underline decoration-dotted">
                  <Trans>pagina</Trans>
                </a>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(null)}
        >
          <img src={zoomed.src} alt={zoomed.alt} className="max-h-[85vh] max-w-full rounded-[12px]" onClick={(e) => e.stopPropagation()} />
          <p className="text-xs text-white/80" onClick={(e) => e.stopPropagation()}>
            {zoomed.domain}
            {zoomed.pageUrl && (
              <>
                {' · '}
                <a href={zoomed.pageUrl} target="_blank" rel="noreferrer" className="underline decoration-dotted">
                  <Trans>pagina</Trans>
                </a>
              </>
            )}
          </p>
        </div>
      )}
    </CardShell>
  )
}
