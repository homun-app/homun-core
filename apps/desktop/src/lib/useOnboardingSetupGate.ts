import { useEffect, useState } from "react";
import { coreBridge } from "./coreBridge";

export function useOnboardingSetupGate(): {
  showOnboarding: boolean;
  completeOnboarding: () => void;
} {
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const status = await coreBridge.setupStatus();
        if (status.needs_setup) setShowOnboarding(true);
      } catch {
        /* gateway not ready, retry on next interaction */
      }
    })();
  }, []);

  return {
    showOnboarding,
    completeOnboarding: () => setShowOnboarding(false),
  };
}
