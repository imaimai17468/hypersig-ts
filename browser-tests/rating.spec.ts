import { expect, test } from "@playwright/test";

const ready = "html[data-hs-connection=ready]";
const pressed = '#rating button[aria-pressed="true"]';

test("rates with the custom element and reflects the signal back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
  const rating = page.locator("#rating");
  await expect(rating.locator("button")).toHaveCount(5);
  await expect(page.locator(pressed)).toHaveCount(0);

  await page.getByRole("button", { name: "3 stars" }).click();
  await expect(rating).toHaveAttribute("value", "3");
  await expect(page.locator(pressed)).toHaveCount(3);

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(rating).toHaveAttribute("value", "0");
  await expect(page.locator(pressed)).toHaveCount(0);
});

test("keeps the element and its children across Live View updates", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing rating base URL");
  const context = await browser.newContext({ baseURL });
  try {
    const peer = await context.newPage();
    await Promise.all([page.goto("/"), peer.goto("/")]);
    await Promise.all([
      expect(page.locator(ready)).toHaveCount(1),
      expect(peer.locator(ready)).toHaveCount(1),
    ]);
    const count = page.locator("#rating-count");
    const before = Number(await count.textContent());
    const element = await page.locator("#rating").evaluateHandle((node) => {
      node.querySelector("button")?.setAttribute("data-test-marker", "kept");
      return node;
    });

    await peer.getByRole("button", { name: "4 stars" }).click();
    await expect(count).toHaveText(String(before + 1));

    expect(
      await element.evaluate(
        (node) => node.isConnected && node === document.querySelector("#rating")
      )
    ).toBe(true);
    await expect(page.locator("#rating button").first()).toHaveAttribute(
      "data-test-marker",
      "kept"
    );
  } finally {
    await context.close();
  }
});

test("keeps the local rating when a peer's save updates the Live View", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing rating base URL");
  const context = await browser.newContext({ baseURL });
  try {
    const peer = await context.newPage();
    await Promise.all([page.goto("/"), peer.goto("/")]);
    await Promise.all([
      expect(page.locator(ready)).toHaveCount(1),
      expect(peer.locator(ready)).toHaveCount(1),
    ]);
    const count = page.locator("#rating-count");
    const initial = Number(await count.textContent());
    await Promise.all([
      page.waitForResponse("**/_hypersig/actions/save-rating"),
      page.getByRole("button", { name: "3 stars" }).click(),
    ]);
    // Wait for the update from this page's own save before watching `value`.
    await expect(count).toHaveText(String(initial + 1));
    await page.evaluate(() => {
      const rating = document.querySelector("#rating");
      if (!rating) throw new Error("Missing rating");
      // Each record's old value is a value the attribute held, so a
      // transient server value shows up even when records arrive batched.
      const held: (string | null)[] = [];
      new MutationObserver((records) => {
        for (const record of records) held.push(record.oldValue);
        rating.setAttribute("data-held-values", JSON.stringify(held));
      }).observe(rating, {
        attributeFilter: ["value"],
        attributeOldValue: true,
      });
    });

    await peer.getByRole("button", { name: "5 stars" }).click();
    await expect(count).toHaveText(String(initial + 2));

    const rating = page.locator("#rating");
    await expect(rating).toHaveAttribute("value", "3");
    await expect(page.locator(pressed)).toHaveCount(3);
    // The runtime may write the same value again, but never the server's 0.
    const held: unknown = JSON.parse(
      (await rating.getAttribute("data-held-values")) ?? "[]"
    );
    expect(held).toEqual(
      Array.isArray(held) ? held.map(() => "3") : ["array of values"]
    );
  } finally {
    await context.close();
  }
});

test("sends no Action from a forged button or form inside the element", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
  const actions: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_hypersig/actions/")) {
      actions.push(request.url());
    }
  });
  await page.evaluate(() => {
    const rating = document.querySelector("#rating");
    if (!rating) throw new Error("Missing rating");
    const forge = (id: string) => {
      const button = document.createElement("button");
      button.id = id;
      button.textContent = id;
      button.dataset.hsAction = "/_hypersig/actions/save-rating";
      button.dataset.hsInput = JSON.stringify({ score: 5 });
      return button;
    };
    const form = document.createElement("form");
    form.id = "forged-form";
    form.method = "post";
    form.action = "/_hypersig/actions/save-rating";
    form.dataset.hsForm = "";
    form.innerHTML = '<input name="score" value="5">';
    rating.append(forge("forged-inside"), form);
    // Outside the Live View, so a morph does not remove it.
    document.body.append(forge("forged-outside"));
  });

  await page.locator("#forged-inside").click();
  await page
    .locator("#forged-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  // The outside button proves the delegation runs; its request comes last.
  await Promise.all([
    page.waitForRequest("**/_hypersig/actions/save-rating"),
    page.locator("#forged-outside").click(),
  ]);
  expect(actions).toHaveLength(1);
  await expect(page).toHaveURL("/");
});

test("writes Action errors only to outlets outside the element", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
  await page.evaluate(() => {
    const rating = document.querySelector("#rating");
    if (!rating) throw new Error("Missing rating");
    const outlet = document.createElement("p");
    outlet.id = "forged-outlet";
    outlet.setAttribute("data-hs-error", "");
    // The Live View comes before the page's own outlet in document order.
    rating.append(outlet);
    const button = document.createElement("button");
    button.id = "invalid-score";
    button.dataset.hsAction = "/_hypersig/actions/save-rating";
    button.dataset.hsInput = JSON.stringify({ score: 99 });
    document.body.append(button);
  });

  await Promise.all([
    page.waitForResponse("**/_hypersig/actions/save-rating"),
    page.locator("#invalid-score").click(),
  ]);
  await expect(page.locator("p[role=alert]")).not.toHaveText("");
  await expect(page.locator("#forged-outlet")).toHaveText("");
});
