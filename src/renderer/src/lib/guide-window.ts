// OAC1 (fase guida): cosa mostra la finestra, da UNA funzione pura sullo
// status dell'onboarding. La guida si vede quando è APERTA (guideOpen, lo
// dice lo stato), NON quando «serve»; e se il daemon ha già detto needed ma
// lo stato non è ancora nato, la finestra CARICA — mai la shell vuota che
// lampeggia un istante prima della guida.
import type { OnboardingStatus } from '../../../shared/types'

export type GuideWindow = 'loading' | 'guide' | 'shell'

/**
 * (PURA) La vista della finestra per lo status dell'onboarding:
 * - 'loading': status ignoto, oppure needed con stato NON ancora nato (splash);
 * - 'guide': la guida è aperta (guideOpen, qualunque sia la storia della chat);
 * - 'shell': la chat normale.
 */
export function guideWindowState(status: OnboardingStatus | null): GuideWindow {
  if (!status) return 'loading'
  if (status.needed && status.state === null) return 'loading'
  return status.guideOpen ? 'guide' : 'shell'
}
