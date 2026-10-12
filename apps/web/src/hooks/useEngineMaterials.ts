/**
 * Engine material source of the global search index (Fonte: motore).
 * A failed load surfaces as status "unavailable" with the client's typed
 * error, which the search states in its footer — never a silent empty,
 * never simulated data.
 */

import { useEffect, useRef, useState } from "react";
import { type EngineMaterialsState, probeEngineMaterials } from "@/lib/engine-material-library";
import { subscribeMaterialChanges } from "@/lib/project-materials-lifecycle";

export function useEngineMaterials(
  projects: Array<{ id: string }>,
  /** Engine connectivity; every transition re-probes (drop, restart). */
  engineOnline: boolean,
): EngineMaterialsState {
  const [state, setState] = useState<EngineMaterialsState>({ items: [], status: "loading" });
  const projectKey = JSON.stringify([...new Set(projects.map((p) => p.id))].sort());
  const scopeRef = useRef(projectKey);
  useEffect(() => {
    const scopeChanged = scopeRef.current !== projectKey;
    scopeRef.current = projectKey;
    let active = true;
    const reload = () => {
      // A same-scope refresh keeps the current items; a new scope starts clean.
      if (active && scopeChanged) setState({ items: [], status: "loading" });
      probeEngineMaterials(JSON.parse(projectKey) as string[]).then((next) => {
        if (active) setState(next);
      });
    };
    const stop = subscribeMaterialChanges(reload);
    reload();
    return () => {
      active = false;
      stop();
    };
  }, [projectKey, engineOnline]);
  return state;
}
