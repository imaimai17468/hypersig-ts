import { expect, test } from "@playwright/test";

test("serves Void routes, typed SSR links and scoped SSE through the same host", async ({
  browser,
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("Missing example base URL");
  const context = await browser.newContext({ baseURL });
  try {
    await expect((await page.request.get("/health")).json()).resolves.toEqual({
      status: "ok",
      host: "Void",
    });
    expect((await page.request.get("/counters/unknown")).status()).toBe(404);

    const peer = await context.newPage();
    const response = await page.goto("/");
    const source = await response?.text();
    expect(source).toContain('<a href="/counters/other">Other</a>');
    expect(source).toContain('<output id="counter-value">0</output>');
    expect(await response?.headerValue("cache-control")).toBe("no-store");
    expect(await response?.headerValue("content-security-policy")).toContain(
      "script-src 'self'"
    );
    if (testInfo.project.name === "development") {
      expect(source).toContain('src="/@vite/client"');
      expect(source).toContain('src="/runtime.ts"');
    } else {
      expect(source).not.toContain("/@vite/client");
      expect(source).toContain('src="/assets/hypersig-runtime.js"');
    }

    await peer.goto("/counters/main");
    const ready = "html[data-hs-connection=ready]";
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(peer.locator(ready)).toHaveCount(1);

    const rejected = await page.request.post("/_hypersig/actions/increment", {
      headers: { Origin: "https://other.example" },
      data: { counterKey: "main" },
    });
    expect(rejected.status()).toBe(403);
    const action = page.waitForResponse("**/_hypersig/actions/increment");
    await page.getByRole("button", { name: "Increment" }).click();
    expect((await action).ok()).toBe(true);
    await expect(page.locator("#counter-value")).toHaveText("1");
    await expect(peer.locator("#counter-value")).toHaveText("1");

    await peer.getByRole("link", { name: "Other" }).click();
    await expect(peer).toHaveURL(/\/counters\/other$/);
    await expect(peer.locator(ready)).toHaveCount(1);
    await expect(peer.locator("#counter-value")).toHaveText("0");
  } finally {
    await context.close();
  }
});
