/**
 * URL query flags for simulated workspace demo modes.
 * Pure — safe to unit-test under Node without Vite.
 */

export type DemoMode = {
  busyDemo: boolean;
  scaleDemo: boolean;
  storageKey: "complete" | "busy" | "materials" | "normal";
};

export function resolveDemoMode(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): DemoMode {
  const params = new URLSearchParams(search);
  const busyDemo = params.get("work-demo") === "busy";
  const scaleDemo = params.get("materials-demo") === "large";
  const storageKey =
    busyDemo && params.get("edition") === "complete"
      ? "complete"
      : busyDemo
        ? "busy"
        : scaleDemo
          ? "materials"
          : "normal";
  return { busyDemo, scaleDemo, storageKey };
}
