import type { HostComputerState } from "./hostComputerState";

export const initialHostComputerState: HostComputerState;
export function reduceHostComputerEvent(
  state: HostComputerState,
  event: object,
): HostComputerState;
