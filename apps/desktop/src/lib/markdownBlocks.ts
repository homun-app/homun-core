// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./markdownBlocks.mjs";

export interface MarkdownBlockSlice {
  key: string;
  text: string;
  closed: boolean;
}

export const splitMarkdownBlocks = implementation.splitMarkdownBlocks as (
  text: string,
) => MarkdownBlockSlice[];
