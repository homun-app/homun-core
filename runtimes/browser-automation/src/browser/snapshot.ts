import type { Locator, Page } from "patchright-core";

export type BrowserRef = {
  ref: string;
  role: string;
  name: string;
  refsMode?: "aria" | "locator";
};

export type BrowserSnapshot = {
  targetId: string;
  url: string;
  snapshot: string;
  refs: BrowserRef[];
  refLocators: Map<string, Locator>;
  refsMode: "aria" | "locator";
  snapshotFormat: "ai" | "legacy";
  stats: {
    lines: number;
    chars: number;
    refs: number;
  };
};

export type BrowserSnapshotOptions = {
  snapshotFormat?: "ai" | "legacy";
  refsMode?: "aria" | "locator";
  mode?: "efficient";
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  timeoutMs?: number;
  maxChars?: number;
  urls?: boolean;
};

// Role grouping follows the OpenClaw browser snapshot contract (MIT) so our
// model-facing snapshots stay compatible with the same observe/act loop.
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "application",
  "directory",
  "document",
  "generic",
  "grid",
  "group",
  "ignored",
  "list",
  "menu",
  "menubar",
  "none",
  "presentation",
  "row",
  "rowgroup",
  "table",
  "tablist",
  "toolbar",
  "tree",
  "treegrid",
]);

const INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[role='button']",
  "[contenteditable='true']",
].join(", ");

export async function createSnapshot(
  page: Page,
  targetId: string,
  options?: BrowserSnapshotOptions,
): Promise<BrowserSnapshot> {
  const snapshotFormat = options?.snapshotFormat ?? "ai";
  if (snapshotFormat === "ai") {
    const aiSnapshot = await createAiSnapshot(page, targetId, options).catch(() => undefined);
    if (aiSnapshot) {
      return aiSnapshot;
    }
  }
  return await createLegacySnapshot(page, targetId);
}

async function enrichPageAccessibility(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nextButtons = document.querySelectorAll(
      "button.next-month, button.ui-datepicker-next, .next-month button, [class*='next-month']"
    );
    for (const btn of nextButtons) {
      if (!btn.getAttribute("aria-label")) {
        btn.setAttribute("aria-label", "Mese successivo");
      }
    }

    const prevButtons = document.querySelectorAll(
      "button.prev-month, button.ui-datepicker-prev, .prev-month button, [class*='prev-month']"
    );
    for (const btn of prevButtons) {
      if (!btn.getAttribute("aria-label")) {
        btn.setAttribute("aria-label", "Mese precedente");
      }
    }

    const allButtons = document.querySelectorAll("button");
    for (const btn of allButtons) {
      const text = btn.textContent ? btn.textContent.trim() : "";
      const hasAriaLabel = btn.getAttribute("aria-label");

      if (!text && !hasAriaLabel) {
        const className = btn.className || "";
        if (className.includes("close") || className.includes("dismiss")) {
          btn.setAttribute("aria-label", "Chiudi");
        } else if (className.includes("search")) {
          btn.setAttribute("aria-label", "Cerca");
        }
      }
    }
  }).catch(() => undefined);
}

async function createAiSnapshot(
  page: Page,
  targetId: string,
  options?: BrowserSnapshotOptions,
): Promise<BrowserSnapshot> {
  await enrichPageAccessibility(page);
  const timeout = Math.max(500, Math.min(60_000, Math.floor(options?.timeoutMs ?? 5_000)));
  const ariaSnapshot = await page.ariaSnapshot({ mode: "ai", timeout });
  const roleOptions = roleSnapshotOptions(options);
  const builtSnapshot = roleOptions
    ? buildRoleSnapshotFromAiSnapshot(ariaSnapshot, roleOptions)
    : { snapshot: ariaSnapshot, refs: refsFromAiSnapshot(ariaSnapshot) };
  const rawSnapshot = options?.urls
    ? appendSnapshotUrls(builtSnapshot.snapshot, await collectSnapshotUrls(page))
    : builtSnapshot.snapshot;
  const limit =
    typeof options?.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : undefined;
  const snapshot =
    limit && rawSnapshot.length > limit
      ? `${rawSnapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`
      : rawSnapshot;
  const refs = roleOptions ? refsFromAiSnapshot(snapshot) : builtSnapshot.refs;
  const refLocators = new Map<string, Locator>();
  for (const ref of refs) {
    refLocators.set(ref.ref, page.locator(`aria-ref=${ref.ref}`));
  }
  return {
    targetId,
    url: page.url(),
    snapshot,
    refs,
    refLocators,
    refsMode: "aria",
    snapshotFormat: "ai",
    stats: snapshotStats(snapshot, refs.length),
  };
}

function refsFromAiSnapshot(snapshot: string): BrowserRef[] {
  const refs = new Map<string, BrowserRef>();
  for (const line of snapshot.split("\n")) {
    const match = line.match(/^\s*-\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?.*\[ref=([^\]\s]+)\]/);
    if (!match) {
      continue;
    }
    const [, role, name = "", ref] = match;
    if (!refs.has(ref)) {
      refs.set(ref, {
        ref,
        role: role.toLowerCase(),
        name,
        refsMode: "aria",
      });
    }
  }
  return [...refs.values()];
}

type RoleSnapshotOptions = {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
};

function roleSnapshotOptions(options?: BrowserSnapshotOptions): RoleSnapshotOptions | null {
  if (
    options?.mode !== "efficient" &&
    options?.interactive !== true &&
    options?.compact !== true &&
    typeof options?.depth !== "number"
  ) {
    return null;
  }
  return {
    interactive: options?.interactive ?? options?.mode === "efficient",
    compact: options?.compact ?? options?.mode === "efficient",
    maxDepth: typeof options?.depth === "number" && Number.isFinite(options.depth) ? options.depth : undefined,
  };
}

function buildRoleSnapshotFromAiSnapshot(
  aiSnapshot: string,
  options: RoleSnapshotOptions,
): { snapshot: string; refs: BrowserRef[] } {
  const refs = new Map<string, BrowserRef>();
  const lines: string[] = [];
  for (const line of aiSnapshot.split("\n")) {
    const parsed = parseSnapshotLine(line);
    if (!parsed) {
      if (!options.interactive) {
        lines.push(line);
      }
      continue;
    }
    if (options.maxDepth !== undefined && parsed.depth > options.maxDepth) {
      continue;
    }
    const role = parsed.role.toLowerCase();
    if (options.interactive && !INTERACTIVE_ROLES.has(role)) {
      continue;
    }
    if (options.compact && STRUCTURAL_ROLES.has(role) && !parsed.name && !parsed.ref) {
      continue;
    }
    if (parsed.ref) {
      refs.set(parsed.ref, {
        ref: parsed.ref,
        role,
        name: parsed.name ?? "",
        refsMode: "aria",
      });
    }
    lines.push(line);
  }
  return {
    snapshot: lines.join("\n") || (options.interactive ? "(no interactive elements)" : "(empty)"),
    refs: [...refs.values()],
  };
}

function parseSnapshotLine(line: string):
  | { depth: number; role: string; name?: string; ref?: string }
  | null {
  const match = line.match(/^(\s*)-\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?(.*)$/);
  if (!match) {
    return null;
  }
  const [, indent, role, name, suffix] = match;
  const ref = suffix.match(/\[ref=([^\]\s]+)\]/)?.[1];
  return {
    depth: Math.floor(indent.length / 2),
    role,
    ...(name ? { name } : {}),
    ...(ref ? { ref } : {}),
  };
}

type SnapshotUrlEntry = {
  text: string;
  url: string;
};

async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  return await page
    .evaluate(() => {
      const seen = new Set<string>();
      const entries: SnapshotUrlEntry[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
        if (!href || seen.has(href)) {
          continue;
        }
        const text =
          (anchor.textContent || anchor.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || href;
        seen.add(href);
        entries.push({ text, url: href });
        if (entries.length >= 100) {
          break;
        }
      }
      return entries;
    })
    .catch(() => []);
}

function appendSnapshotUrls(snapshot: string, urls: SnapshotUrlEntry[]): string {
  if (!urls.length) {
    return snapshot;
  }
  const lines = urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`);
  return `${snapshot}\n\nLinks:\n${lines.join("\n")}`;
}

async function createLegacySnapshot(page: Page, targetId: string): Promise<BrowserSnapshot> {
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
    refs.push({ ref, role, name, refsMode: "locator" });
    refLocators.set(ref, item);
    lines.push(`[ref=${ref}] ${role}: ${name}`);
  }

  const snapshot = lines.join("\n");
  return {
    targetId,
    url: page.url(),
    snapshot,
    refs,
    refLocators,
    refsMode: "locator",
    snapshotFormat: "legacy",
    stats: snapshotStats(snapshot, refs.length),
  };
}

function snapshotStats(snapshot: string, refs: number): BrowserSnapshot["stats"] {
  return {
    lines: snapshot ? snapshot.split("\n").length : 0,
    chars: snapshot.length,
    refs,
  };
}

async function resolveRole(locator: Locator): Promise<string> {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tag === "input" || tag === "textarea") {
    const inputType = await locator
      .getAttribute("type")
      .then((value) => value?.toLowerCase() ?? "text")
      .catch(() => "text");
    if (["button", "submit", "reset", "checkbox", "radio"].includes(inputType)) {
      return inputType === "checkbox" || inputType === "radio" ? inputType : "button";
    }
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
  const explicitName =
    (await locator.getAttribute("aria-label").catch(() => null)) ??
    (await locator.getAttribute("name").catch(() => null)) ??
    (await locator.getAttribute("placeholder").catch(() => null)) ??
    (await locator.getAttribute("value").catch(() => null)) ??
    (await locator.textContent().catch(() => null)) ??
    (await locator.getAttribute("id").catch(() => null)) ??
    (await locator.getAttribute("data-testid").catch(() => null)) ??
    (await locator.getAttribute("autocomplete").catch(() => null)) ??
    (await locator.getAttribute("title").catch(() => null));
  if (explicitName?.trim()) {
    return explicitName.trim();
  }

  return (
    (await associatedLabel(locator).catch(() => null)) ??
    (await nearbyFieldText(locator).catch(() => null)) ??
    ""
  ).trim();
}

async function associatedLabel(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const labels = "labels" in element ? Array.from((element as HTMLInputElement).labels ?? []) : [];
    const direct = labels.map((label) => label.textContent?.trim()).find(Boolean);
    if (direct) {
      return direct;
    }
    const id = element.getAttribute("id");
    if (id) {
      const escaped = id.replace(/["\\]/g, "\\$&");
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label?.textContent?.trim()) {
        return label.textContent.trim();
      }
    }
    return null;
  });
}

async function nearbyFieldText(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const container = element.closest("label, [role='group'], .form-group, .field, div");
    const text = container?.textContent?.trim().replace(/\s+/g, " ");
    if (!text || text.length > 120) {
      return null;
    }
    return text;
  });
}
