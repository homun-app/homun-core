import type { Locator, Page } from "playwright-core";

export type BrowserRef = {
  ref: string;
  role: string;
  name: string;
};

export type BrowserSnapshot = {
  targetId: string;
  url: string;
  snapshot: string;
  refs: BrowserRef[];
  refLocators: Map<string, Locator>;
};

const INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[role='button']",
  "[contenteditable='true']",
].join(", ");

export async function createSnapshot(page: Page, targetId: string): Promise<BrowserSnapshot> {
  const refs: BrowserRef[] = [];
  const refLocators = new Map<string, Locator>();
  const lines: string[] = [];
  const title = await page.title().catch(() => "");
  const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();

  if (title) {
    lines.push(`title: ${title}`);
  }
  if (bodyText) {
    lines.push(bodyText);
  }

  const locator = page.locator(INTERACTIVE_SELECTOR);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }
    const ref = `e${refs.length + 1}`;
    const role = await resolveRole(item);
    const name = await resolveName(item);
    refs.push({ ref, role, name });
    refLocators.set(ref, item);
    lines.push(`[ref=${ref}] ${role}: ${name}`);
  }

  return {
    targetId,
    url: page.url(),
    snapshot: lines.join("\n"),
    refs,
    refLocators,
  };
}

async function resolveRole(locator: Locator): Promise<string> {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tag === "input" || tag === "textarea") {
    return "textbox";
  }
  if (tag === "select") {
    return "combobox";
  }
  if (tag === "a") {
    return "link";
  }
  return "button";
}

async function resolveName(locator: Locator): Promise<string> {
  return (
    (await locator.getAttribute("aria-label").catch(() => null)) ??
    (await locator.getAttribute("name").catch(() => null)) ??
    (await locator.textContent().catch(() => null)) ??
    ""
  ).trim();
}
