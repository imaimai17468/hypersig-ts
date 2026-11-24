import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const main = '[data-count="main"]';
const ready = "html[data-hs-connection=ready]";
const stream = "**/_hypersig/stream/**";

test("keeps order lines and total on the same snapshot during a delayed price read", async ({
  page,
}) => {
  const initial = await page.goto("/order");
  expect(await initial?.text()).toContain("data-order-lines=");
  await expect(page.locator(ready)).toHaveCount(1);
  const quantity = Number(await page.locator("#order-quantity").textContent());
  await page.evaluate(() => {
    const order = document.querySelector('[data-hs-view="order-summary"]');
    if (!(order instanceof HTMLElement))
      throw new Error("Missing order boundary");
    const observer = new MutationObserver(() => {
      const lines = order
        .querySelector("[data-order-lines]")
        ?.getAttribute("data-order-lines");
      const total = order.querySelector("[data-order-total]");
      const quantity = Number(
        order.querySelector("#order-quantity")?.textContent
      );
      if (
        !lines ||
        lines !== total?.getAttribute("data-order-total") ||
        total.textContent !== `${quantity * 500 + 200}円`
      ) {
        order.setAttribute("data-mixed-order", "");
        observer.disconnect();
      }
    });
    observer.observe(order, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  const [firstAction] = await Promise.all([
    page.waitForResponse("**/_hypersig/actions/add-notebook"),
    page.getByRole("button", { name: "ノートを追加" }).click(),
  ]);
  expect(firstAction.status()).toBe(200);
  await page.getByRole("button", { name: "ノートを追加" }).click();
  await expect(page.locator("#order-quantity")).toHaveText(
    String(quantity + 2)
  );
  await expect(page.locator("#order-total")).toHaveText(
    `${(quantity + 2) * 500 + 200}円`
  );
  await expect(page.locator("[data-mixed-order]")).toHaveCount(0);
});

async function readRenders(page: Page) {
  const response = await page.request.get("/metrics");
  const metrics: unknown = await response.json();
  if (typeof metrics !== "object" || !metrics || !("renders" in metrics)) {
    throw new Error("Missing render counts");
  }
  return metrics.renders;
}

test("SSR and an Action update only the subscribed counter in two browser sessions", async ({
  page,
  browser,
}) => {
  const second = await browser.newContext();
  try {
    const peer = await second.newPage();
    const cdp = await second.newCDPSession(peer);
    await cdp.send("Network.enable");
    const messages: { eventName: string; data: string }[] = [];
    cdp.on("Network.eventSourceMessageReceived", (event) =>
      messages.push(event)
    );
    const errors: string[] = [];
    for (const tab of [page, peer])
      tab.on("pageerror", (error) => errors.push(error.message));
    const [initial] = await Promise.all([page.goto("/"), peer.goto("/")]);
    expect(await initial?.text()).toMatch(
      /<output data-count="main">\d+<\/output>/
    );
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(peer.locator(ready)).toHaveCount(1);
    messages.length = 0;
    const baseline = Number(await page.locator(main).textContent());
    const renders = await readRenders(page);
    const original = await peer.locator("#heading").elementHandle();
    const independent = await peer
      .locator('[data-hs-view="counter.other"]')
      .elementHandle();
    const field = await peer.locator("#draft").elementHandle();
    await peer.locator("#draft").fill("draft text");
    await peer.locator("#draft").press("End");
    await peer.evaluate(() => {
      const affected = document.querySelector('[data-hs-view="counter.main"]');
      const root = document.querySelector("main");
      if (!root) throw new Error("Missing main");
      root.dataset.testMutations = "0";
      new MutationObserver((records) => {
        const outside = records.some(
          ({ target, attributeName }) =>
            attributeName !== "data-test-mutations" &&
            !affected?.contains(target)
        );
        if (outside) root.dataset.testMutations = "1";
      }).observe(root, {
        subtree: true,
        characterData: true,
        childList: true,
        attributes: true,
      });
    });

    const actionRequests: string[] = [];
    page.on("request", (request) =>
      actionRequests.push(
        request.method() + " " + new URL(request.url()).pathname
      )
    );
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        () => {
          document.documentElement.dataset.testClick = String(
            performance.timeOrigin + performance.now()
          );
        },
        { capture: true, once: true }
      );
    });
    const updates = [page, peer].map((tab) =>
      tab.evaluate(
        (value) => {
          const output = document.querySelector('[data-count="main"]');
          if (!output) throw new Error("Missing counter");
          return new Promise<number>((resolve) => {
            const observer = new MutationObserver(() => {
              if (output.textContent !== value) return;
              observer.disconnect();
              resolve(performance.timeOrigin + performance.now());
            });
            observer.observe(output, {
              characterData: true,
              subtree: true,
              childList: true,
            });
          });
        },
        String(baseline + 1)
      )
    );
    const response = page.waitForResponse("**/_hypersig/actions/increment");
    await page.getByRole("button", { name: "Increment main" }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.locator(main)).toHaveText(String(baseline + 1));
    await expect(peer.locator(main)).toHaveText(String(baseline + 1));
    const click = Number(
      await page.locator("html").getAttribute("data-test-click")
    );
    const elapsed = Math.max(...(await Promise.all(updates))) - click;
    expect(actionRequests).toEqual(["POST /_hypersig/actions/increment"]);
    expect(messages.map(({ eventName }) => eventName)).toEqual(["html-update"]);
    const updated = await readRenders(page);
    expect(renders).toEqual({
      main: expect.any(Number),
      other: expect.any(Number),
    });
    if (
      typeof renders !== "object" ||
      !renders ||
      !("main" in renders) ||
      typeof renders.main !== "number" ||
      !("other" in renders)
    ) {
      throw new Error("Missing render measurements");
    }
    expect(updated).toEqual({ main: renders.main + 2, other: renders.other });
    expect(
      await peer
        .locator("#heading")
        .evaluate((node, previous) => node === previous, original)
    ).toBe(true);
    expect(
      await peer
        .locator('[data-hs-view="counter.other"]')
        .evaluate((node, previous) => node === previous, independent)
    ).toBe(true);
    expect(
      await peer
        .locator("#draft")
        .evaluate((node, previous) => node === previous, field)
    ).toBe(true);
    await expect(peer.locator("#draft")).toBeFocused();
    await expect(peer.locator("#draft")).toHaveValue("draft text");
    expect(
      await peer
        .locator("#draft")
        .evaluate((input) =>
          input instanceof HTMLInputElement ? input.selectionStart : null
        )
    ).toBe("draft text".length);
    await expect(peer.locator("main")).toHaveAttribute(
      "data-test-mutations",
      "0"
    );
    expect(errors).toEqual([]);
    const frameBytes = new TextEncoder().encode(
      messages
        .map(({ eventName, data }) => `event: ${eventName}\ndata: ${data}\n\n`)
        .join("")
    ).length;
    console.log(
      `One Action: 2 affected renders, 0 independent renders, ${frameBytes} SSE bytes per viewer, ${Math.round(elapsed)} ms through both browser updates`
    );
  } finally {
    await second.close();
  }
});

test("EventSource reconnects and catches up without replaying missed Actions", async ({
  page,
  browser,
}) => {
  const second = await browser.newContext();
  try {
    const peer = await second.newPage();
    await page.goto("/");
    await expect(page.locator(ready)).toHaveCount(1);
    const count = Number(await page.locator(main).textContent());
    // End the first stream with a valid empty SSE response to trigger a native retry.
    let connections = 0;
    const disconnected = page.waitForFunction(
      () => document.documentElement.dataset.hsConnection === "disconnected"
    );
    await page.route(stream, async (route) => {
      connections++;
      if (connections === 1) {
        await route.fulfill({
          contentType: "text/event-stream",
          body: "retry: 250\n\n",
        });
      } else {
        // Wait until the peer commits before allowing this same EventSource to retry.
        await expect(peer.locator(main)).toHaveText(String(count + 1));
        await route.continue();
      }
    });
    await page.reload();
    await disconnected;
    await peer.goto("/");
    await expect(peer.locator(ready)).toHaveCount(1);
    await peer.getByRole("button", { name: "Increment main" }).click();
    await expect(page.locator(main)).toHaveText(String(count + 1));
    await expect(page.locator(ready)).toHaveCount(1);
    expect(connections).toBe(2);
  } finally {
    await second.close();
  }
});

test("ignores out-of-order, malformed and unrelated frames and sanitizes fragment markup", async ({
  page,
}) => {
  const frame = (target: string, version: number, html: string) =>
    `event: html-update\ndata: ${JSON.stringify({ target, version, html })}\n\n`;
  await page.route(stream, async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body:
        frame(
          "counter.main",
          5,
          '<output data-count="main" onclick="return false">42</output><script></script>'
        ) +
        frame("counter.main", 4, '<output data-count="main">1</output>') +
        frame("missing", 6, "<output>unrelated</output>") +
        "event: html-update\ndata: invalid\n\n" +
        "event: ready\ndata: {}\n\n",
    });
  });
  await page.goto("/");
  await expect(page.locator(main)).toHaveText("42");
  await expect(page.locator("body script")).toHaveCount(0);
  expect(await page.locator(main).getAttribute("onclick")).toBeNull();
  await expect(page.getByText("unrelated")).toHaveCount(0);
});

test("drops a removed view and resynchronizes it when the same boundary returns", async ({
  page,
}) => {
  const mainView = page.locator('[data-hs-view="counter.main"]');
  const restored = "html[data-hs-connection=ready]";
  await page.goto("/");
  await expect(page.locator(restored)).toHaveCount(1);
  const count = Number(await page.locator(main).textContent());
  const node = await mainView.elementHandle();
  if (!node) throw new Error("Missing view");
  const reduced = page.waitForRequest(
    (request) =>
      request.url().includes("/stream/") &&
      !new URL(request.url()).searchParams
        .getAll("view")
        .includes("counter.main")
  );
  await node.evaluate((element) => element.remove());
  await reduced;
  await expect(page.locator(restored)).toHaveCount(1);
  const before = await readRenders(page);
  const response = await page.request.post("/_hypersig/actions/increment", {
    data: { counterId: "main" },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  expect(await readRenders(page)).toEqual(before);
  await node.evaluate((element) =>
    document.querySelector("main")?.append(element)
  );
  await expect(page.locator(main)).toHaveText(String(count + 1));
  await expect(page.locator(restored)).toHaveCount(1);
});

test("submits a standard form and exposes validation errors without changing server state", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
  const other = page.locator('[data-count="other"]');
  const starting = Number(await other.textContent());
  const hidden = page.locator("form input[name=counterId]");
  const submit = page.getByRole("button", { name: "Increment other" });
  await hidden.evaluate((input) => input.setAttribute("value", "invalid"));
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("Action failed (422).");
  await expect(other).toHaveText(String(starting));
  await hidden.evaluate((input) => input.setAttribute("value", "other"));
  await submit.click();
  await expect(other).toHaveText(String(starting + 1));
  await expect(page.getByRole("alert")).toBeEmpty();
});

test("mounts and unsubscribes a nested view after SSR on the existing SSE connection", async ({
  page,
}) => {
  await page.goto("/nested");
  await expect(page.locator(ready)).toHaveCount(1);
  await expect(page.locator(main)).toHaveCount(0);
  const connections: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_hypersig/stream/"))
      connections.push(request.url());
  });
  await page.getByRole("button", { name: "Show counter" }).click();
  await expect(page.locator(main)).toHaveCount(1);
  const count = Number(await page.locator(main).textContent());
  await page.getByRole("button", { name: "Increment main" }).click();
  await expect(page.locator(main)).toHaveText(String(count + 1));

  const peer = await page.context().newPage();
  await peer.goto("/nested");
  await expect(peer.locator(ready)).toHaveCount(1);
  await expect(peer.locator(main)).toHaveText(String(count + 1));
  await page.getByRole("button", { name: "Hide counter" }).click();
  await expect(page.locator(main)).toHaveCount(0);
  await expect(peer.locator(main)).toHaveCount(0);
  const renders = await readRenders(page);
  const response = await page.request.post("/_hypersig/actions/increment", {
    data: { counterId: "main" },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  await page.getByRole("button", { name: "Show counter" }).click();
  await expect(page.locator(main)).toHaveText(String(count + 2));
  await expect(peer.locator(main)).toHaveText(String(count + 2));
  expect(connections).toEqual([]);
  if (
    typeof renders !== "object" ||
    !renders ||
    !("main" in renders) ||
    typeof renders.main !== "number" ||
    !("other" in renders)
  ) {
    throw new Error("Missing render counts");
  }
  expect(await readRenders(page)).toEqual({
    main: renders.main + 2,
    other: renders.other,
  });
  await page.getByRole("button", { name: "Hide counter" }).click();
  await expect(page.locator(main)).toHaveCount(0);
});

test("marks a failed view, keeps its last HTML, and clears the marker at recovery", async ({
  page,
}) => {
  let resume = () => {};
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let initial = true;
  await page.route(stream, async (route) => {
    if (initial) {
      initial = false;
      await route.fulfill({
        contentType: "text/event-stream",
        body: 'retry: 250\nevent: view-error\ndata: "counter.main"\n\n',
      });
    } else {
      await wait;
      await route.continue();
    }
  });
  try {
    await page.goto("/");
    await expect(page.locator(main)).toHaveCount(1);
    await expect(page.locator('[data-hs-view="counter.main"]')).toHaveAttribute(
      "data-hs-view-error",
      ""
    );
  } finally {
    resume();
  }
  await expect(page.locator(ready)).toHaveCount(1);
  await expect(page.locator("[data-hs-view-error]")).toHaveCount(0);
});

for (const reason of ["access-denied", "unauthenticated"] as const) {
  test(`clears the previously rendered live content when SSE is ${reason}`, async ({
    page,
  }) => {
    await page.route(stream, async (route) => {
      if (reason === "access-denied") {
        await route.fulfill({
          contentType: "text/event-stream",
          body: "event: access-denied\ndata: {}\n\n",
        });
      } else {
        await route.fulfill({ status: 401, body: "Authentication required" });
      }
    });

    const response = await page.goto("/");
    expect(await response?.text()).toContain('data-count="main"');
    await expect(
      page.locator("html[data-hs-connection=disconnected]")
    ).toHaveCount(1);
    await expect(page.locator(main)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "hypersig Counter" })
    ).toBeVisible();
  });
}

test("retains a moved child View's DOM and SSR snapshot until its own Topic changes", async ({
  page,
}) => {
  await page.goto("/nested");
  await expect(page.locator(ready)).toHaveCount(1);
  await page.getByRole("button", { name: "Show counter" }).click();
  await expect(page.locator(main)).toHaveText(/^\d+$/);
  const previous = await page.locator(main).elementHandle();
  const baseline = Number(await page.locator(main).textContent());
  const beforeMove = await readRenders(page);
  await page.getByRole("button", { name: "Move counter" }).click();
  const moved = page.locator("#moved-position").locator(main);
  await expect(moved).toHaveText(String(baseline));
  expect(await moved.evaluate((node, old) => node === old, previous)).toBe(
    true
  );
  expect(await readRenders(page)).toEqual(beforeMove);

  await page.getByRole("button", { name: "Increment main" }).click();
  await expect(moved).toHaveText(String(baseline + 1));
  await page.getByRole("button", { name: "Move counter" }).click();
  await expect(page.locator("#original-position").locator(main)).toHaveText(
    String(baseline + 1)
  );
  await page.getByRole("button", { name: "Hide counter" }).click();
  await expect(page.locator(main)).toHaveCount(0);
});

/** Starts a counter process of its own, which a test can stop and start again. */
async function startCounter(port: number) {
  const url = `http://127.0.0.1:${port}`;
  const server = spawn("bun", ["examples/counter/server.tsx"], {
    env: {
      ...process.env,
      PORT: String(port),
      HYPERSIG_PAGE_KEY: Buffer.alloc(32, 7).toString("base64"),
      COUNTER_SESSION_SECRET: "restart-test-session-secret",
    },
    stdio: "ignore",
  });
  const exited = once(server, "exit");
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      server.kill();
    }
    await exited;
  };
  const deadline = Date.now() + 15_000;
  try {
    for (;;) {
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error("Counter server exited before it was ready");
      if (Date.now() > deadline)
        throw new Error("Counter server did not start");
      try {
        const response = await fetch(url + "/runtime.js", {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) break;
      } catch {
        // The server is not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}

test("applies updates from a restarted server process that counts versions from 1 again", async ({
  browser,
}) => {
  const port = 3223;
  let server = await startCounter(port);
  const context = await browser.newContext({ baseURL: server.url });
  try {
    const page = await context.newPage();
    const peer = await context.newPage();
    await page.goto("/");
    await peer.goto("/");
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(peer.locator(ready)).toHaveCount(1);
    for (const count of [1, 2, 3]) {
      await peer.getByRole("button", { name: "Increment main" }).click();
      await expect(page.locator(main)).toHaveText(String(count));
    }

    const disconnected = "html[data-hs-connection=disconnected]";
    await server.stop();
    await expect(page.locator(disconnected)).toHaveCount(1);
    await expect(peer.locator(disconnected)).toHaveCount(1);
    server = await startCounter(port);
    await expect(page.locator(ready)).toHaveCount(1, { timeout: 15_000 });
    await expect(peer.locator(ready)).toHaveCount(1, { timeout: 15_000 });
    // The new process lost the in-memory count and streams it at version 1.
    await expect(page.locator(main)).toHaveText("0");
    await peer.getByRole("button", { name: "Increment main" }).click();
    await expect(page.locator(main)).toHaveText("1");
    await expect(peer.locator(main)).toHaveText("1");
  } finally {
    await context.close();
    await server.stop();
  }
});

test("redraws a view whose access returned while the browser was offline", async ({
  browser,
}) => {
  const port = 3224;
  let server = await startCounter(port);
  const context = await browser.newContext({ baseURL: server.url });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator(ready)).toHaveCount(1);
    await page.getByRole("button", { name: "Hide shared counter" }).click();
    await expect(page.locator(main)).toHaveCount(0);
    await expect(page.locator('[data-count="other"]')).toHaveText("0");

    // Offline emulation leaves an open stream alone, so the server ends it.
    await context.setOffline(true);
    await server.stop();
    await expect(
      page.locator("html[data-hs-connection=disconnected]")
    ).toHaveCount(1);
    // The new process forgets the hidden session, and the count still
    // matches the SSR snapshot, so only a fresh render shows the counter.
    server = await startCounter(port);
    await context.setOffline(false);
    await expect(page.locator(main)).toHaveText("0", { timeout: 15_000 });
    await expect(page.locator(ready)).toHaveCount(1);
  } finally {
    await context.close();
    await server.stop();
  }
});
