/**
 * Esito breve di una condizione risolta («Connessione ripristinata»):
 * compare quando lo stato attivo sparisce e svanisce da solo, senza
 * lasciare tracce nello storico della conversazione.
 */
import { useEffect, useRef, useState } from "react";

export function useTransientResolved(active: boolean, ms = 6000): boolean {
  const [resolved, setResolved] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      setResolved(false);
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    setResolved(true);
    const timer = setTimeout(() => setResolved(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return resolved;
}
