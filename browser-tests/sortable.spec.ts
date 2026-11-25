import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const ready = "html[data-hs-connection=ready]";
const initial = ["Write code", "Review", "Test", "Deploy"];
const reorderAction = "**/_hypersig/actions/reorder-items";

// Each test gets its own browser context, so its own session and list.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      document.documentElement.dataset.cspViolations =
        JSON.stringify(violations);
    });
  });
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
  await expect(rows(page)).toHaveText(initial);
});

test.afterEach(async ({ page }) => {
  await expect(page.locator("html")).not.toHaveAttribute("data-csp-violations");
});

function rows(page: Page): Locator {
  return page.locator("#tasks li");
}

function handle(page: Page, label: string): Locator {
  return page.getByRole("button", { name: `Move ${label}` });
}

function busyList(page: Page): Locator {
  return page.locator("#tasks ol[aria-busy=true]");
}

async function openPeer(page: Page): Promise<Page> {
  // Another tab of the same session sees the same list.
  const peer = await page.context().newPage();
  await peer.goto("/");
  await expect(peer.locator(ready)).toHaveCount(1);
  return peer;
}

/** Holds this page's reorder requests until the returned function runs. */
async function holdReorders(page: Page): Promise<() => Promise<void>> {
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(reorderAction, async (route) => {
    await released;
    await route.continue();
  });
  return async () => {
    release?.();
  };
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Presses on `from` and moves the pointer over `to` without dropping. */
async function pickUpOver(page: Page, from: Locator, to: Locator) {
  const start = await center(from);
  const end = await center(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Past the activation distance, then onto the target in steps.
  await page.mouse.move(start.x, start.y + 10, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 10 });
}

/**
 * Picks up `label` with Space and presses `key` until the row is over
 * `position` (from 1). dnd-kit ignores an arrow key until it has measured the
 * rows, so a press that the announcement does not follow is sent again.
 */
async function liftWithKeys(
  page: Page,
  label: string,
  key: "ArrowUp" | "ArrowDown",
  position: number
) {
  const announcement = page.locator("#tasks [role=status]");
  await handle(page, label).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#tasks li[data-dragging]")).toHaveText(label);
  const start = initial.indexOf(label) + 1;
  const step = key === "ArrowDown" ? 1 : -1;
  for (let at = start + step; at !== position + step; at += step) {
    const over = `${label} is over position ${at}.`;
    await expect(async () => {
      if ((await announcement.textContent()) !== over) {
        await page.keyboard.press(key);
      }
      await expect(announcement).toHaveText(over, { timeout: 500 });
    }).toPass();
  }
}

test("drags a row with the mouse, shows it as pending, and saves it", async ({
  page,
}) => {
  const peer = await openPeer(page);
  const release = await holdReorders(page);
  const moved = ["Review", "Test", "Write code", "Deploy"];

  await Promise.all([
    page.waitForRequest(reorderAction),
    (async () => {
      await pickUpOver(page, handle(page, "Write code"), rows(page).nth(2));
      await page.mouse.up();
    })(),
  ]);
  await expect(rows(page)).toHaveText(moved);
  await expect(busyList(page)).toHaveCount(1);
  await expect(rows(peer)).toHaveText(initial);

  await release();
  await expect(busyList(page)).toHaveCount(0);
  await expect(rows(page)).toHaveText(moved);
  await expect(rows(peer)).toHaveText(moved);
});

test("moves a row with the keyboard and saves it", async ({ page }) => {
  const peer = await openPeer(page);
  const release = await holdReorders(page);
  const moved = ["Review", "Test", "Write code", "Deploy"];

  await liftWithKeys(page, "Write code", "ArrowDown", 3);
  await Promise.all([
    page.waitForRequest(reorderAction),
    page.keyboard.press("Space"),
  ]);
  await expect(rows(page)).toHaveText(moved);
  await expect(busyList(page)).toHaveCount(1);

  await release();
  await expect(busyList(page)).toHaveCount(0);
  await expect(rows(peer)).toHaveText(moved);
  await expect(handle(page, "Write code")).toBeFocused();
});

test("does not start another drag while a dropped order is pending", async ({
  page,
}) => {
  const peer = await openPeer(page);
  const release = await holdReorders(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_hypersig/actions/reorder-items")) {
      requests.push(request.url());
    }
  });
  const moved = ["Review", "Test", "Write code", "Deploy"];

  await Promise.all([
    page.waitForRequest(reorderAction),
    (async () => {
      await pickUpOver(page, handle(page, "Write code"), rows(page).nth(2));
      await page.mouse.up();
    })(),
  ]);
  await expect(busyList(page)).toHaveCount(1);

  // Moving Write code back would save the first order again.
  await pickUpOver(page, handle(page, "Write code"), rows(page).nth(0));
  await expect(page.locator("#tasks li[data-dragging]")).toHaveCount(0);
  await page.mouse.up();
  await handle(page, "Review").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#tasks li[data-dragging]")).toHaveCount(0);
  await expect(rows(page)).toHaveText(moved);

  await release();
  await expect(busyList(page)).toHaveCount(0);
  await expect(rows(page)).toHaveText(moved);
  await expect(rows(peer)).toHaveText(moved);
  expect(requests).toHaveLength(1);
  await page.reload();
  await expect(rows(page)).toHaveText(moved);
});

test("rejects keys that do not reorder the list", async ({ page }) => {
  const inputs = {
    unknown: ["code", "review", "test", "ship"],
    duplicate: ["code", "code", "test", "deploy"],
    short: ["code", "review", "deploy"],
  };
  await page.evaluate((inputs) => {
    for (const [id, keys] of Object.entries(inputs)) {
      const button = document.createElement("button");
      button.id = id;
      button.dataset.hsAction = "/_hypersig/actions/reorder-items";
      button.dataset.hsInput = JSON.stringify({ keys });
      document.body.append(button);
    }
  }, inputs);

  const alert = page.locator("p[role=alert]");
  for (const id of Object.keys(inputs)) {
    // The message is the same for every key, so it is cleared first to see
    // that this response wrote it.
    await alert.evaluate((element) => {
      element.textContent = "";
    });
    await expect(alert).toBeEmpty();
    const [response] = await Promise.all([
      page.waitForResponse(reorderAction),
      page.locator(`#${id}`).click(),
    ]);
    expect(response.status()).toBe(409);
    await expect(alert).toHaveText("The list changed. Reload the page.");
  }
  await page.reload();
  await expect(rows(page)).toHaveText(initial);
});

test("returns to the server's order when the save fails", async ({ page }) => {
  // The server keeps Deploy last.
  await Promise.all([
    page.waitForResponse(reorderAction),
    (async () => {
      await pickUpOver(page, handle(page, "Deploy"), rows(page).nth(0));
      await page.mouse.up();
    })(),
  ]);
  await expect(page.locator("p[role=alert]")).toHaveText(
    "Deploy has to stay last."
  );
  await expect(rows(page)).toHaveText(initial);
  await expect(busyList(page)).toHaveCount(0);

  // The list still saves after a failure.
  await pickUpOver(page, handle(page, "Write code"), rows(page).nth(1));
  await page.mouse.up();
  await expect(rows(page)).toHaveText([
    "Review",
    "Write code",
    "Test",
    "Deploy",
  ]);
  await expect(busyList(page)).toHaveCount(0);
});

test("keeps dragging while another tab saves, then saves onto that order", async ({
  page,
}) => {
  const peer = await openPeer(page);
  const list = page.locator("#tasks");

  await pickUpOver(page, handle(page, "Write code"), rows(page).nth(1));
  await expect(page.locator("#tasks li[data-dragging]")).toHaveText(
    "Write code"
  );

  // The peer moves Test to the top while this page is still dragging. A tab
  // in the background gets no animation frames, which dnd-kit moves rows in.
  await peer.bringToFront();
  await liftWithKeys(peer, "Test", "ArrowUp", 1);
  await peer.keyboard.press("Space");
  const peerOrder = ["Test", "Write code", "Review", "Deploy"];
  await expect(rows(peer)).toHaveText(peerOrder);
  await expect(busyList(peer)).toHaveCount(0);
  await expect
    .poll(async () => labelsOf(await list.getAttribute("items")))
    .toEqual(peerOrder);

  // The drag survives the update and the rows stay where they were.
  await expect(page.locator("#tasks li[data-dragging]")).toHaveText(
    "Write code"
  );
  await expect(rows(page)).toHaveText(initial);

  // Dropping moves Write code below Review in the peer's order.
  await page.bringToFront();
  await page.mouse.up();
  const saved = ["Test", "Review", "Write code", "Deploy"];
  await expect(rows(page)).toHaveText(saved);
  await expect(busyList(page)).toHaveCount(0);
  await expect(rows(peer)).toHaveText(saved);
});

function labelsOf(json: string | null): unknown {
  const items: unknown = JSON.parse(json ?? "null");
  if (!Array.isArray(items)) return items;
  return items.map((item: unknown) =>
    typeof item === "object" && item !== null && "label" in item
      ? item.label
      : item
  );
}

test("sends its Content-Security-Policy with the page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
});
