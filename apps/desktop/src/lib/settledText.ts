// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./settledText.mjs";

export const nextSettledValue = implementation.nextSettledValue as (input: {
  current: string;
  settled: string | undefined;
  elapsedMs: number;
  quietMs: number;
}) => string;
