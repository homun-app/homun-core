/**
 * La modalità di autonomia della persona vive nel motore.
 *
 * L'ultima scelta (Autonomo / Con guardrail / Supervisionato) è il SUO default
 * per le conversazioni nuove in QUALSIASI browser: all'avvio la UI la rilegge
 * dal motore una volta pronto (senza sovrascrivere una scelta fatta in questa
 * sessione), e a ogni cambio la riscrive (best effort, come la lingua).
 */
import { useEffect, useRef, type Dispatch, SetStateAction } from "react";
import type {
  AutonomyLevel,
  ConversationPreferences,
} from "@/components/builder/conversation-preferences";
import { fetchEngineAutonomy, setEngineAutonomy } from "@/lib/engine-preferences-client";

export function useEngineAutonomyPreference(
  ready: boolean,
  setPreferences: Dispatch<SetStateAction<ConversationPreferences>>,
): (level: AutonomyLevel) => void {
  const applied = useRef(false);
  useEffect(() => {
    if (!ready || applied.current) return;
    applied.current = true;
    void fetchEngineAutonomy().then((level) => {
      if (level) setPreferences((current) => ({ ...current, autonomyLevel: level }));
    });
  }, [ready, setPreferences]);
  return function changeAutonomyLevel(level: AutonomyLevel) {
    setPreferences((current) => ({ ...current, autonomyLevel: level }));
    void setEngineAutonomy(level);
  };
}
