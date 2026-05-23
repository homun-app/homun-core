import type { Locator, Page } from "playwright-core";
import { BrowserAutomationError } from "../contracts.js";

export type BrowserActRequest =
  | {
      kind: "click";
      targetId: string;
      ref: string;
    }
  | {
      kind: "fill";
      targetId: string;
      fields: Array<{ ref: string; value: string }>;
    }
  | {
      kind: "type";
      targetId: string;
      ref: string;
      text: string;
      submit?: boolean;
    }
  | {
      kind: "wait";
      targetId: string;
      text?: string;
      timeoutMs?: number;
    };

export async function executeAction(
  page: Page,
  refs: Map<string, Locator>,
  action: BrowserActRequest,
): Promise<{ ok: true; url: string }> {
  switch (action.kind) {
    case "click": {
      await requireRef(refs, action.ref).click();
      return { ok: true, url: page.url() };
    }
    case "fill": {
      for (const field of action.fields) {
        await requireRef(refs, field.ref).fill(field.value);
      }
      return { ok: true, url: page.url() };
    }
    case "type": {
      const locator = requireRef(refs, action.ref);
      await locator.fill(action.text);
      if (action.submit) {
        await locator.press("Enter");
      }
      return { ok: true, url: page.url() };
    }
    case "wait": {
      if (action.text) {
        await page.getByText(action.text).waitFor({ timeout: action.timeoutMs ?? 20_000 });
      } else {
        await page.waitForTimeout(Math.min(action.timeoutMs ?? 500, 30_000));
      }
      return { ok: true, url: page.url() };
    }
  }
}

export function requireRef(refs: Map<string, Locator>, ref: string): Locator {
  const locator = refs.get(ref);
  if (!locator) {
    throw new BrowserAutomationError({
      code: "BROWSER_STALE_REF",
      message: "ref is stale; take a fresh snapshot",
      retryable: true,
    });
  }
  return locator;
}
