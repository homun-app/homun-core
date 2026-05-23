import { describe, expect, it } from "vitest";
import { assertNavigationAllowed } from "../src/browser/navigation_guard.js";

describe("browser navigation guard", () => {
  it.each(["file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "chrome://settings"])(
    "blocks unsupported protocol %s",
    async (url) => {
      await expect(assertNavigationAllowed({ url })).rejects.toMatchObject({
        code: "BROWSER_NAVIGATION_BLOCKED",
      });
    },
  );

  it.each(["http://127.0.0.1:3000", "http://localhost:3000", "http://10.0.0.5"])(
    "blocks private network URL %s without opt-in",
    async (url) => {
      await expect(assertNavigationAllowed({ url })).rejects.toMatchObject({
        code: "BROWSER_PRIVATE_NETWORK_BLOCKED",
      });
    },
  );

  it("allows private network URLs when explicitly enabled", async () => {
    await expect(
      assertNavigationAllowed({
        url: "http://127.0.0.1:3000",
        allowPrivateNetwork: true,
      }),
    ).resolves.toBeUndefined();
  });
});
