/** Shared helpers for simulated routine state (Fonte: simulazione). */
import type { SpaceRoutine } from "@/components/builder/ConversationSpace";

/**
 * Routines whose work matches go on pause: the origin work was archived or
 * deleted, or its agent was removed. Executions already created stay.
 */
export function pausedRoutines(
  routines: SpaceRoutine[],
  matches: (routine: SpaceRoutine) => boolean,
): SpaceRoutine[] {
  return routines.map((routine) => (matches(routine) ? { ...routine, active: false } : routine));
}
