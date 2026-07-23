import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;

beforeEach(async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "form.html");
  const trainFixture = path.join(import.meta.dirname, "fixtures", "train.html");
  const overlayFixture = path.join(import.meta.dirname, "fixtures", "overlay.html");
  const offcanvasFixture = path.join(import.meta.dirname, "fixtures", "offcanvas.html");
  const comboboxFixture = path.join(import.meta.dirname, "fixtures", "combobox.html");
  const html = await readFile(fixture, "utf8");
  const trainHtml = await readFile(trainFixture, "utf8");
  const overlayHtml = await readFile(overlayFixture, "utf8");
  const offcanvasHtml = await readFile(offcanvasFixture, "utf8");
  const comboboxHtml = await readFile(comboboxFixture, "utf8");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/train")) {
      res.end(trainHtml);
      return;
    }
    if (req.url?.startsWith("/overlay")) {
      res.end(overlayHtml);
      return;
    }
    if (req.url?.startsWith("/offcanvas")) {
      res.end(offcanvasHtml);
      return;
    }
    if (req.url?.startsWith("/combobox")) {
      res.end(comboboxHtml);
      return;
    }
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not start");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  manager = new BrowserSessionManager({
    headless: true,
    allowPrivateNetwork: true,
  });
});

afterEach(async () => {
  await manager?.stop();
  if (server) {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser sidecar engine", () => {
  it("opens a fixture page, snapshots refs, fills and submits", async () => {
    await manager.start();
    const opened = await manager.open({ url: baseUrl, label: "booking" });

    expect(opened.targetId).toBe("booking");

    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const input = firstSnapshot.refs.find((ref) => ref.name === "Name");
    const placeholderInput = firstSnapshot.refs.find((ref) => ref.name === "Destination");
    const dateButton = firstSnapshot.refs.find((ref) => ref.name === "Today");
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    expect(input?.ref).toMatch(/^e/);
    expect(placeholderInput?.ref).toMatch(/^e/);
    expect(dateButton?.role).toBe("button");
    expect(submit?.ref).toMatch(/^e/);

    const fillResult = await manager.act({
      targetId: "booking",
      kind: "fill_form",
      fields: [
        { ref: input!.ref, value: "Ada" },
        { ref: placeholderInput!.ref, value: "Milano Centrale" },
      ],
    });
    expect(fillResult.filledRefs).toEqual([input!.ref, placeholderInput!.ref]);
    await manager.act({ targetId: "booking", kind: "click", ref: submit!.ref });

    const secondSnapshot = await manager.snapshot({ targetId: "booking" });
    expect(secondSnapshot.snapshot).toContain("Submitted Ada to Milano Centrale in standard");
  });

  it("fills a single field from the FLAT chat shape (kind=fill, ref, text)", async () => {
    // The chat browser_act schema is flat ({kind, ref, text}) — one micro-action.
    // The sidecar fill contract is an array of fields. A flat fill must still work
    // (it was silently erroring before: action.fields was undefined). Value may
    // arrive in `text` (chat schema) or `value`; both coerce to one field.
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const snapshot = await manager.snapshot({ targetId: "booking" });
    const name = snapshot.refs.find((ref) => ref.name === "Name");
    expect(name?.ref).toMatch(/^e/);

    const fillResult = await manager.act({
      targetId: "booking",
      kind: "fill",
      ref: name!.ref,
      text: "Ada",
    } as never);

    expect(fillResult.filledRefs).toEqual([name!.ref]);
    expect(fillResult.failedRefs).toEqual([]);
  });

  it("auto-confirms an autocomplete combobox by keyboard when typing (no clickable suggestion)", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/combobox`, label: "combobox" });

    // Type only — no `commit` given. The field is role=combobox with
    // keyboard-only suggestions, so the sidecar must auto-confirm with
    // ArrowDown+Enter and select the first match "Napoli Centrale".
    await manager.act({
      targetId: "combobox",
      kind: "type",
      selector: "#station",
      text: "Nap",
    });

    const snapshot = await manager.snapshot({ targetId: "combobox" });
    expect(snapshot.snapshot).toContain("selezionato: Napoli Centrale");
  });

  it("does not auto-confirm a plain textbox (commit none)", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "plain" });
    const snapshot = await manager.snapshot({ targetId: "plain" });
    const name = snapshot.refs.find((ref) => ref.name === "Name");
    // A plain textbox typed with text + Enter would submit; without submit it
    // must just hold the value, proving auto-confirm is scoped to comboboxes.
    await manager.act({ targetId: "plain", kind: "type", ref: name!.ref, text: "Ada" });
    const after = await manager.snapshot({ targetId: "plain" });
    expect(after.snapshot).not.toContain("Submitted");
  });

  it("types into autocomplete-style fields and returns a fresh snapshot", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const destination = firstSnapshot.refs.find((ref) => ref.name === "Destination");

    const result = await manager.act({
      targetId: "booking",
      kind: "type",
      ref: destination!.ref,
      text: "Mil",
    });

    expect(result).toMatchObject({ ok: true, targetId: "booking" });
    expect(JSON.stringify(result)).toContain("Milano Centrale");
  });

  it("accepts canonical OpenClaw act names and efficient interactive snapshots", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({
      targetId: "booking",
      mode: "efficient",
      interactive: true,
      compact: true,
      depth: 6,
    });
    const name = firstSnapshot.refs.find((ref) => ref.name === "Name");
    const destination = firstSnapshot.refs.find((ref) => ref.name === "Destination");
    const klass = firstSnapshot.refs.find((ref) => ref.name === "Class");
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    expect(firstSnapshot.snapshot).toContain("textbox \"Name\"");
    expect(firstSnapshot.snapshot).not.toContain("Booking Form");

    await manager.act({
      targetId: "booking",
      kind: "batch",
      actions: [
        {
          targetId: "booking",
          kind: "fill",
          fields: [
            { ref: name!.ref, type: "text", value: "Ada" },
            { ref: destination!.ref, type: "text", value: "Milano Centrale" },
          ],
        },
        { targetId: "booking", kind: "select", ref: klass!.ref, values: ["business"] },
        { targetId: "booking", kind: "scrollIntoView", ref: submit!.ref },
        { targetId: "booking", kind: "click", ref: submit!.ref },
      ],
    });

    const finalSnapshot = await manager.snapshot({ targetId: "booking" });
    expect(finalSnapshot.snapshot).toContain("Submitted Ada to Milano Centrale in business");
  });

  it("uses Playwright AI aria refs for custom widget action loops", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });

    expect(firstSnapshot.snapshotFormat).toBe("ai");
    expect(firstSnapshot.refsMode).toBe("aria");
    expect(firstSnapshot.stats.refs).toBeGreaterThan(0);

    const destination = firstSnapshot.refs.find((ref) => ref.name === "Destination");
    const typed = await manager.act({
      targetId: "booking",
      kind: "type",
      ref: destination!.ref,
      text: "Mil",
    });
    const milano = typed.refs?.find((ref) => ref.name === "Milano Centrale");

    expect(milano?.refsMode).toBe("aria");

    const selected = await manager.act({
      targetId: "booking",
      kind: "click",
      ref: milano!.ref,
    });
    const today = selected.refs?.find((ref) => ref.name === "Today");
    const calendar = await manager.act({
      targetId: "booking",
      kind: "click",
      ref: today!.ref,
    });
    const june10 = calendar.refs?.find((ref) => ref.name === "10 giugno 2026");

    expect(calendar.snapshot).toContain("10 giugno 2026");

    const dateSelected = await manager.act({
      targetId: "booking",
      kind: "click",
      ref: june10!.ref,
    });

    expect(dateSelected.snapshot).toContain("10 giugno 2026");
  }, 10_000);

  it("can append visible links to AI snapshots for navigation decisions", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });

    const snapshot = await manager.snapshot({ targetId: "booking", urls: true });

    expect(snapshot.snapshot).toContain("Links:");
    expect(snapshot.snapshot).toContain("Docs ->");
    expect(snapshot.snapshot).toContain("/docs");
  });

  it("returns bounded interact, delta and extract observations", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/train`, label: "train" });

    const interact = await manager.snapshot({
      targetId: "train",
      observationMode: "interact",
    } as never);
    expect(interact.observationMode).toBe("interact");
    expect(interact.generation).toBeGreaterThan(0);
    expect(interact.fingerprint).toMatch(/^snap_/);
    expect(interact.stats.chars).toBeLessThanOrEqual(6_200);
    expect(interact.snapshot).toContain('textbox "Da"');

    const from = interact.refs.find((ref) => ref.name === "Da");
    const typed = await manager.act({
      targetId: "train",
      kind: "type",
      ref: from!.ref,
      text: "Nap",
      observationMode: "delta",
      generation: interact.generation,
    } as never);
    expect(typed.observationMode).toBe("delta");
    expect(typed.generation).toBeGreaterThan(interact.generation);
    expect(typed.fingerprint).toMatch(/^snap_/);
    expect(typed.stats!.chars).toBeLessThanOrEqual(8_200);
    expect(JSON.stringify(typed)).toContain("Napoli Centrale");

    const extract = await manager.snapshot({
      targetId: "train",
      observationMode: "extract",
      maxChars: 16_000,
    } as never);
    expect(extract.observationMode).toBe("extract");
    expect(extract.generation).toBeGreaterThan(typed.generation!);
    expect(extract.stats.chars).toBeLessThanOrEqual(16_200);
  });

  it("executes a chat bundle of four actions and rejects nested or oversized bundles", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/train`, label: "train" });
    const snapshot = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
    const accept = snapshot.refs.find((ref) => ref.name === "Accetta tutto");
    const from = snapshot.refs.find((ref) => ref.name === "Da");

    const accepted = accept
      ? await manager.act({
          targetId: "train",
          kind: "batch",
          chatBundle: true,
          generation: snapshot.generation,
          actions: [{ targetId: "train", kind: "click", ref: accept.ref }],
          observationMode: "delta",
        } as never)
      : snapshot;
    if (accept) {
      expect(accepted).toMatchObject({ ok: true });
    }

    const afterAccept = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
    const fromRef = afterAccept.refs.find((ref) => ref.name === "Da") ?? from;
    const bundle = await manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: afterAccept.generation,
      actions: [
        { targetId: "train", kind: "type", ref: fromRef!.ref, text: "Nap" },
        { targetId: "train", kind: "wait", text: "Napoli Centrale", timeoutMs: 2_000 },
      ],
      observationMode: "delta",
    } as never);
    expect(bundle.batchResults).toHaveLength(2);
    expect(bundle.completedActions).toBe(2);
    expect(JSON.stringify(bundle)).toContain("Napoli Centrale");

    await expect(
      manager.act({
        targetId: "train",
        kind: "batch",
        chatBundle: true,
        generation: bundle.generation,
        actions: [
          { targetId: "train", kind: "wait", text: "x" },
          { targetId: "train", kind: "wait", text: "x" },
          { targetId: "train", kind: "wait", text: "x" },
          { targetId: "train", kind: "wait", text: "x" },
          { targetId: "train", kind: "wait", text: "x" },
        ],
      } as never),
    ).rejects.toMatchObject({ code: "BROWSER_CHAT_BUNDLE_TOO_LARGE" });

    await expect(
      manager.act({
        targetId: "train",
        kind: "batch",
        chatBundle: true,
        generation: bundle.generation,
        actions: [{ targetId: "train", kind: "batch", actions: [] }],
      } as never),
    ).rejects.toMatchObject({ code: "BROWSER_NESTED_BATCH_REJECTED" });
  });

  it("rejects a chat bundle from a stale observation generation", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const first = await manager.snapshot({ targetId: "booking", observationMode: "interact" } as never);
    await manager.snapshot({ targetId: "booking", observationMode: "interact" } as never);
    const name = first.refs.find((ref) => ref.name === "Name");

    await expect(
      manager.act({
        targetId: "booking",
        kind: "batch",
        chatBundle: true,
        generation: first.generation,
        actions: [{ targetId: "booking", kind: "type", ref: name!.ref, text: "Ada" }],
      } as never),
    ).rejects.toMatchObject({ code: "BROWSER_STALE_GENERATION" });
  });

  it("fills train search with bounded bundles and extracts three result cards", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/train`, label: "train" });
    const first = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
    const accept = first.refs.find((ref) => ref.name === "Accetta tutto");
    if (accept) {
      await manager.act({
        targetId: "train",
        kind: "batch",
        chatBundle: true,
        generation: first.generation,
        actions: [{ targetId: "train", kind: "click", ref: accept.ref }],
        observationMode: "delta",
      } as never);
    }

    const form = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
    const from = form.refs.find((ref) => ref.name === "Da");
    const to = form.refs.find((ref) => ref.name === "A");
    const typed = await manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: form.generation,
      actions: [
        { targetId: "train", kind: "type", ref: from!.ref, text: "Nap" },
        { targetId: "train", kind: "type", ref: to!.ref, text: "Mil" },
      ],
      observationMode: "delta",
    } as never);
    expect(typed.completedActions).toBe(2);

    const ready = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
    const date = ready.refs.find((ref) => ref.name === "Scegli data");
    const search = ready.refs.find((ref) => ref.name === "Cerca");
    await manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: ready.generation,
      actions: [
        { targetId: "train", kind: "click", ref: date!.ref },
        { targetId: "train", kind: "wait", text: "10 giugno 2026", timeoutMs: 2_000 },
        { targetId: "train", kind: "click", ref: search!.ref },
        { targetId: "train", kind: "wait", text: "FR 9512", timeoutMs: 3_000 },
      ],
      observationMode: "extract",
    } as never);

    const extract = await manager.snapshot({ targetId: "train", observationMode: "extract" } as never);
    const text = extract.snapshot;
    expect(text).toContain("FR 9512");
    expect(text).toContain("Intercity 590");
    expect(text).toContain("Italo 9920");
    expect(text).toContain("€49.90");
    expect(text).toContain("€39.90");
    expect(text).toContain("€54.90");
  });

  it("selects options and can snapshot after an explicit fill_form request", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const input = firstSnapshot.refs.find((ref) => ref.name === "Name");
    const travelClass = firstSnapshot.refs.find((ref) => ref.name === "Class");
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    const fillResult = await manager.act({
      targetId: "booking",
      kind: "fill_form",
      fields: [{ ref: input!.ref, value: "Grace" }],
      snapshot_after: true,
    });
    expect(fillResult.filledRefs).toEqual([input!.ref]);
    expect(JSON.stringify(fillResult)).toContain("Booking Form");

    await manager.act({
      targetId: "booking",
      kind: "select_option",
      ref: travelClass!.ref,
      value: "business",
    });
    await manager.act({ targetId: "booking", kind: "click", ref: submit!.ref });
    const afterSubmit = await manager.snapshot({ targetId: "booking" });
    expect(afterSubmit.snapshot).toContain("Submitted Grace to in business");
  });

  it("snapshots automatically after fill_form so callers get fresh refs", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const input = firstSnapshot.refs.find((ref) => ref.name === "Name");

    const fillResult = await manager.act({
      targetId: "booking",
      kind: "fill_form",
      fields: [{ ref: input!.ref, value: "Grace" }],
    });

    expect(fillResult.filledRefs).toEqual([input!.ref]);
    expect(JSON.stringify(fillResult)).toContain("Booking Form");
    expect(JSON.stringify(fillResult)).toContain("Submit");
  });

  it("waits for delayed client-side results before snapshotting after a click", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const delayed = firstSnapshot.refs.find((ref) => ref.name === "Load delayed options");

    const result = await manager.act({
      targetId: "booking",
      kind: "click",
      ref: delayed!.ref,
    });

    expect(JSON.stringify(result)).toContain("Option 09:10 Napoli Centrale");
  });

  it("supports OpenClaw-style hover, scroll_into_view, rich wait and batch actions", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const name = firstSnapshot.refs.find((ref) => ref.name === "Name");
    const destination = firstSnapshot.refs.find((ref) => ref.name === "Destination");
    const help = firstSnapshot.refs.find((ref) => ref.name === "Help");
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    const hover = await manager.act({
      targetId: "booking",
      kind: "hover",
      ref: help!.ref,
    });
    expect(JSON.stringify(hover)).toContain("Helpful booking hint");

    const scrolled = await manager.act({
      targetId: "booking",
      kind: "scroll_into_view",
      ref: submit!.ref,
    });
    expect(scrolled).toMatchObject({ ok: true, targetId: "booking" });

    const batch = await manager.act({
      targetId: "booking",
      kind: "batch",
      actions: [
        { targetId: "booking", kind: "fill_form", fields: [{ ref: name!.ref, value: "Linus" }] },
        { targetId: "booking", kind: "type", ref: destination!.ref, text: "Mil" },
      ],
    });
    expect(batch.batchResults).toHaveLength(2);
    expect(JSON.stringify(batch)).toContain("Milano Centrale");

    const waited = await manager.act({
      targetId: "booking",
      kind: "wait",
      text: "Milano Centrale",
      timeoutMs: 2_000,
    });
    expect(waited).toMatchObject({ ok: true, targetId: "booking" });
  }, 15_000);

  it("returns a classified timeout error for impossible waits", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });

    await expect(
      manager.act({
        targetId: "booking",
        kind: "wait",
        text: "This text does not exist",
        timeoutMs: 600,
      }),
    ).rejects.toMatchObject({
      code: "BROWSER_ACTION_TIMEOUT",
      retryable: true,
    });
  });

  it("drives a complete train-search fixture through cookie, autocomplete, date, time and results", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/train`, label: "train" });
    const firstSnapshot = await manager.snapshot({ targetId: "train" });
    const acceptCookies = firstSnapshot.refs.find((ref) => ref.name === "Accetta tutto");

    if (acceptCookies) {
      await manager.act({ targetId: "train", kind: "click", ref: acceptCookies.ref });
    }
    const formSnapshot = await manager.snapshot({ targetId: "train" });
    const from = formSnapshot.refs.find((ref) => ref.name === "Da");

    const fromTyped = await manager.act({
      targetId: "train",
      kind: "type",
      ref: from!.ref,
      text: "Nap",
    });
    const napoli = fromTyped.refs?.find((ref) => ref.name === "Napoli Centrale");
    await manager.act({ targetId: "train", kind: "click", ref: napoli!.ref });

    const afterFrom = await manager.snapshot({ targetId: "train" });
    const toRef = afterFrom.refs.find((ref) => ref.name === "A");
    const toTyped = await manager.act({
      targetId: "train",
      kind: "type",
      ref: toRef!.ref,
      text: "Mil",
    });
    const milano = toTyped.refs?.find((ref) => ref.name === "Milano Centrale");
    const toSelected = await manager.act({ targetId: "train", kind: "click", ref: milano!.ref });

    const date = toSelected.refs?.find((ref) => ref.name === "Scegli data");
    const calendar = await manager.act({ targetId: "train", kind: "click", ref: date!.ref });
    const june10 = calendar.refs?.find((ref) => ref.name === "10 giugno 2026");
    const dateSelected = await manager.act({ targetId: "train", kind: "click", ref: june10!.ref });

    const time = dateSelected.refs?.find((ref) => ref.name === "Ora");
    await manager.act({
      targetId: "train",
      kind: "select_option",
      ref: time!.ref,
      value: "09:00",
    });
    const readySnapshot = await manager.snapshot({ targetId: "train" });
    const search = readySnapshot.refs.find((ref) => ref.name === "Cerca");
    await manager.act({ targetId: "train", kind: "click", ref: search!.ref });
    const results = await manager.act({
      targetId: "train",
      kind: "wait",
      text: "FR 9512",
      timeoutMs: 3_000,
    });

    const serialized = JSON.stringify(results);
    expect(serialized).toContain("FR 9512");
    expect(serialized).toContain("09:05");
    expect(serialized).toContain("Italo 9920");
    expect(serialized).toContain("09:30");
    expect(serialized).toContain("€49.90");
  }, 20_000);

  it("dismisses common cookie overlays before observing and acting", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/overlay`, label: "overlay" });
    const snapshot = await manager.snapshot({ targetId: "overlay" });
    const primaryAction = snapshot.refs.find((ref) => ref.name === "Primary action");

    expect(snapshot.snapshot).not.toContain("Cookie overlay");

    const clicked = await manager.act({
      targetId: "overlay",
      kind: "click",
      ref: primaryAction!.ref,
    });

    expect(JSON.stringify(clicked)).toContain("Clicked underlay");
  });

  it("dismisses offcanvas backdrops before acting on visible fields", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/offcanvas`, label: "offcanvas" });
    const snapshot = await manager.snapshot({ targetId: "offcanvas" });
    const input = snapshot.refs.find((ref) => ref.name === "Partenza");

    expect(snapshot.snapshot).not.toContain("offcanvas-backdrop");

    const typed = await manager.act({
      targetId: "offcanvas",
      kind: "type",
      ref: input!.ref,
      text: "Napoli Centrale",
    });

    expect(JSON.stringify(typed)).toContain("Napoli Centrale");
  });

  it("types through label or hidden helper refs by targeting the associated editable control", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/offcanvas`, label: "offcanvas" });
    const snapshot = await manager.snapshot({ targetId: "offcanvas" });
    const hiddenHelper = snapshot.refs.find((ref) => ref.name.startsWith("Stazione di arrivo"));

    const typed = await manager.act({
      targetId: "offcanvas",
      kind: "type",
      ref: hiddenHelper!.ref,
      text: "Milano Centrale",
    });

    expect(JSON.stringify(typed)).toContain("Milano Centrale");
  });

  it("fails stale refs after navigation", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    await manager.navigate({ targetId: "booking", url: `${baseUrl}/next` });

    await expect(
      manager.act({ targetId: "booking", kind: "click", ref: submit!.ref }),
    ).rejects.toMatchObject({
      code: "BROWSER_STALE_REF",
    });
  });
});
