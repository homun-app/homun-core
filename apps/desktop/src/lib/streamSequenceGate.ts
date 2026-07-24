// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./streamSequenceGate.mjs";

export interface SequencedStreamEvent {
  request_id: string;
  seq?: number;
}

export interface StreamSequenceGate {
  accept(event: SequencedStreamEvent): boolean;
  clear(requestId: string): void;
  size(): number;
}

export const createStreamSequenceGate = implementation.createStreamSequenceGate as (
  maxEntries?: number,
) => StreamSequenceGate;
