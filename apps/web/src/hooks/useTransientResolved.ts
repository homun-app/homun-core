/**
 * Esito breve di una condizione risolta («Connessione ripristinata»):
 * compare quando lo stato attivo sparisce e svanisce da solo, senza
 * lasciare tracce nello storico della conversazione.
 */
import { useEffect, useRef, useState } from "react";

/**
 * Il passo puro della transizione: ogni episodio attivo produce UN solo
 * esito, nell'istante in cui sparisce — né al montaggio spento, né di
 * nuovo finché la condizione non torna attiva.
 */
export function nextResolvedEpisode(
  seen: boolean,
  active: boolean,
): { seen: boolean; resolved: boolean } {
  if (active) return { seen: true, resolved: false };
  if (!seen) return { seen, resolved: false };
  return { seen: false, resolved: true };
}

export function useTransientResolved(active: boolean, ms = 6000): boolean {
  const [resolved, setResolved] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    const next = nextResolvedEpisode(seen.current, active);
    seen.current = next.seen;
    setResolved(next.resolved);
    if (!next.resolved) return;
    const timer = setTimeout(() => setResolved(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return resolved;
}
