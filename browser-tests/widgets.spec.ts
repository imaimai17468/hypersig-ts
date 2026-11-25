import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const ready = "html[data-hs-connection=ready]";
const draftAction = "/_hypersig/actions/save-draft";
const fruitPath = "/_hypersig/actions/save-fruit";
const fruitAction = `**${fruitPath}`;

// Each test gets its own browser context, so its own session and saved values.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      document.documentElement.dataset.cspViolations =
        JSON.stringify(violations);
    });
  });
});

test.afterEach(async ({ page }) => {
  await expect(page.locator("html")).not.toHaveAttribute("data-csp-violations");
});

async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator(ready)).toHaveCount(1);
}

/** Waits until no fruit save is in flight, when Enter and Space run again. */
async function waitForSaved(page: Page) {
  await expect(page.locator(".combobox-field[data-hs-pending]")).toHaveCount(0);
}

function combobox(page: Page): Locator {
  return page.getByRole("combobox", { name: "Favorite fruit" });
}

async function expectActive(page: Page, fruit: string) {
  const option = page.getByRole("option", { name: fruit });
  await expect(combobox(page)).toHaveAttribute(
    "aria-activedescendant",
    `fruit-option-${fruit.toLowerCase()}`
  );
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { selected: true, includeHidden: true })
  ).toHaveCount(1);
}

test.describe("select-only combobox", () => {
  test("opens, moves and picks with the keyboard", async ({ page }) => {
    await open(page);
    const box = combobox(page);
    const listbox = page.getByRole("listbox", { name: "Favorite fruit" });
    await expect(box).toHaveText("Apple");
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await expect(box).toHaveAttribute("aria-controls", "fruit-listbox");
    // The server leaves aria-activedescendant out while the list is closed.
    await expect(box).not.toHaveAttribute("aria-activedescendant");
    await expect(listbox).toBeHidden();

    await box.focus();
    await box.press("Enter");
    await expect(listbox).toBeVisible();
    await expect(box).toHaveAttribute("aria-expanded", "true");
    await expectActive(page, "Apple");

    await box.press("ArrowDown");
    await expectActive(page, "Banana");
    await box.press("ArrowDown");
    await expectActive(page, "Cherry");
    await box.press("ArrowUp");
    await expectActive(page, "Banana");
    await box.press("End");
    await expectActive(page, "Orange");
    await box.press("ArrowDown");
    await expectActive(page, "Orange");
    await box.press("Home");
    await expectActive(page, "Apple");
    await box.press("ArrowUp");
    await expectActive(page, "Apple");
    await box.press("ArrowDown");
    await box.press("ArrowDown");
    await expectActive(page, "Cherry");

    // Enter and Space wait for the pick's save, so a second Enter cannot
    // send it again.
    await Promise.all([page.waitForResponse(fruitAction), box.press("Enter")]);
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Cherry");
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await expect(box).not.toHaveAttribute("aria-activedescendant");
    await expect(box).toBeFocused();
    await waitForSaved(page);

    // Opening starts from the chosen option, wherever the last visit left off.
    await box.press(" ");
    await expect(listbox).toBeVisible();
    await expectActive(page, "Cherry");
    await box.press("ArrowDown");
    await expectActive(page, "Grape");
    await box.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Cherry");

    await box.press("ArrowDown");
    await expect(listbox).toBeVisible();
    await expectActive(page, "Cherry");
    await box.press("Escape");
    await expect(listbox).toBeHidden();

    // Home and End open a closed list at the first and last option.
    await box.press("End");
    await expect(listbox).toBeVisible();
    await expectActive(page, "Orange");
    await box.press("Escape");
    await box.press("Home");
    await expect(listbox).toBeVisible();
    await expectActive(page, "Apple");
    await box.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Cherry");
  });

  test("saves only the option picked with the keyboard, not the opening", async ({
    page,
  }) => {
    await open(page);
    const other = await page.context().newPage();
    await open(other);
    const saves: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === fruitPath) {
        saves.push(request.postData() ?? "");
      }
    });
    const box = combobox(page);
    const listbox = page.getByRole("listbox", { name: "Favorite fruit" });
    await box.focus();
    await box.press("Enter");
    await expect(listbox).toBeVisible();
    await box.press("Escape");
    await box.press(" ");
    await expect(listbox).toBeVisible();
    await box.press("ArrowDown");
    await expectActive(page, "Banana");
    expect(saves).toEqual([]);

    // Hold the save so the keys below are pressed while it is in flight.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(fruitAction, async (route) => {
      await held;
      await route.continue();
    });
    await box.press("Enter");
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Banana");
    const pending = page.locator(".combobox-field[data-hs-pending]");
    await expect(pending).toHaveCount(1);
    // The arrow keys still open and move the list while the save is held.
    await box.press("ArrowDown");
    await expect(listbox).toBeVisible();
    await expectActive(page, "Banana");
    await box.press("ArrowDown");
    await expectActive(page, "Cherry");
    await box.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(pending).toHaveCount(1);
    expect(saves).toEqual([JSON.stringify({ fruit: "banana" })]);
    release();
    await waitForSaved(page);
    await page.unroute(fruitAction);
    await expect(page.locator("#saved-fruit")).toHaveText("Banana");
    await expect(other.locator("#saved-fruit")).toHaveText("Banana");

    // Tab picks the active option of an open list as focus moves on.
    await box.press("Enter");
    await box.press("End");
    await expectActive(page, "Orange");
    await box.press("Tab");
    await expect(box).not.toBeFocused();
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Orange");
    await expect(other.locator("#saved-fruit")).toHaveText("Orange");
    await waitForSaved(page);
    expect(saves).toHaveLength(2);

    // So does Shift+Tab, as focus moves back.
    await box.focus();
    await box.press("Enter");
    await box.press("Home");
    await expectActive(page, "Apple");
    await box.press("Shift+Tab");
    await expect(box).not.toBeFocused();
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Apple");
    await expect(other.locator("#saved-fruit")).toHaveText("Apple");
    await waitForSaved(page);
    expect(saves).toEqual([
      JSON.stringify({ fruit: "banana" }),
      JSON.stringify({ fruit: "orange" }),
      JSON.stringify({ fruit: "apple" }),
    ]);
  });

  test("picks with the mouse, saves it and reaches another tab", async ({
    page,
  }) => {
    await open(page);
    const other = await page.context().newPage();
    await open(other);
    await expect(other.locator("#saved-fruit")).toHaveText("Apple");
    const box = combobox(page);
    const listbox = page.getByRole("listbox", { name: "Favorite fruit" });

    await box.click();
    await expect(listbox).toBeVisible();
    await expectActive(page, "Apple");
    await Promise.all([
      page.waitForResponse(fruitAction),
      page.getByRole("option", { name: "Mango" }).click(),
    ]);
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Mango");
    await expect(box).toBeFocused();
    await expect(page.locator("#saved-fruit")).toHaveText("Mango");
    await expect(other.locator("#saved-fruit")).toHaveText("Mango");

    await box.click();
    await expect(listbox).toBeVisible();
    await expectActive(page, "Mango");
    await box.click();
    await expect(listbox).toBeHidden();

    await box.click();
    await expect(listbox).toBeVisible();
    await page.getByRole("heading", { name: "Widgets" }).click();
    await expect(listbox).toBeHidden();
    await expect(box).toHaveText("Mango");
  });
});

test("tabs follow the arrow keys, wrap at the ends and keep one tab stop", async ({
  page,
}) => {
  await open(page);
  const tablist = page.getByRole("tablist", { name: "Product details" });
  const names = ["Overview", "Specs", "Reviews"];
  const expectSelected = async (name: string) => {
    for (const other of names) {
      const tab = tablist.getByRole("tab", { name: other });
      await expect(tab).toHaveAttribute(
        "aria-selected",
        String(other === name)
      );
      await expect(tab).toHaveAttribute(
        "tabindex",
        other === name ? "0" : "-1"
      );
    }
    await expect(tablist.getByRole("tab", { name })).toBeFocused();
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await expect(page.getByRole("tabpanel", { name })).toBeVisible();
  };

  await tablist.getByRole("tab", { name: "Overview" }).focus();
  await expectSelected("Overview");
  await page.keyboard.press("ArrowRight");
  await expectSelected("Specs");
  await page.keyboard.press("ArrowRight");
  await expectSelected("Reviews");
  await page.keyboard.press("ArrowRight");
  await expectSelected("Overview");
  await page.keyboard.press("ArrowLeft");
  await expectSelected("Reviews");
  await page.keyboard.press("Home");
  await expectSelected("Overview");
  await page.keyboard.press("End");
  await expectSelected("Reviews");
  await page.keyboard.press("ArrowLeft");
  await expectSelected("Specs");

  // Only the selected tab is a tab stop, so Tab goes on to its panel.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tabpanel", { name: "Specs" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expectSelected("Specs");

  await tablist.getByRole("tab", { name: "Reviews" }).click();
  await expectSelected("Reviews");
});

test("the disclosure closes when focus leaves it or on Escape", async ({
  page,
}) => {
  await open(page);
  const button = page.getByRole("button", { name: "Display options" });
  const panel = page.locator("#display-options");
  const prices = page.getByRole("checkbox", { name: "Show prices" });
  const compact = page.getByRole("checkbox", { name: "Compact rows" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();

  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(prices).toBeFocused();
  // Clicking a checkbox inside keeps the panel open.
  await prices.click();
  await expect(prices).toBeChecked();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(compact).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await expect(panel).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  await button.click();
  await expect(panel).toBeVisible();
  await compact.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
});

test("the counter tracks the length, the trimmed check gates sending, and the filter ignores case", async ({
  page,
}) => {
  await open(page);
  const message = page.getByRole("textbox", { name: "Message" });
  const remaining = page.locator("#message-remaining");
  const send = page.getByRole("button", { name: "Send" });
  await expect(remaining).toHaveText("80 characters left");
  await expect(send).toBeDisabled();
  await message.fill("   ");
  await expect(remaining).toHaveText("77 characters left");
  await expect(send).toBeDisabled();
  await message.fill("  Hi ");
  await expect(remaining).toHaveText("75 characters left");
  await expect(send).toBeEnabled();
  await message.fill("");
  await expect(remaining).toHaveText("80 characters left");
  await expect(send).toBeDisabled();

  const filter = page.getByRole("searchbox", { name: "Filter countries" });
  const countries = page.getByRole("list", { name: "Countries" });
  const all = ["Brazil", "Canada", "Germany", "Japan", "Kenya", "Norway"];
  await expect(countries.getByRole("listitem")).toHaveText(all);
  await filter.fill("an");
  await expect(countries.getByRole("listitem")).toHaveText([
    "Canada",
    "Germany",
    "Japan",
  ]);
  await filter.fill("AN");
  await expect(countries.getByRole("listitem")).toHaveText([
    "Canada",
    "Germany",
    "Japan",
  ]);
  await filter.fill("nor");
  await expect(countries.getByRole("listitem")).toHaveText(["Norway"]);
  await filter.fill("x");
  await expect(countries.getByRole("listitem")).toHaveCount(0);
  await filter.fill("");
  await expect(countries.getByRole("listitem")).toHaveText(all);
});

test("a toast shows after a successful send and hides 3 seconds later", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await open(page);
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const toast = page.locator("#toast");
  await expect(toast).toBeHidden();

  await page.getByRole("textbox", { name: "Message" }).fill("Hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText("Message sent.");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect(page.locator("#message-remaining")).toHaveText(
    "80 characters left"
  );
  await page.clock.runFor(2999);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(toast).toBeHidden();
});

test("typing saves the draft once, after the input stops", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await open(page);
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const saves: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === draftAction) {
      saves.push(request.postData() ?? "");
    }
  });
  const draft = page.getByRole("textbox", { name: "Draft" });
  const saved = page.locator("#saved-draft");
  await expect(saved).toHaveText("");

  await draft.pressSequentially("ab");
  await page.clock.runFor(300);
  await draft.pressSequentially("c");
  await page.clock.runFor(499);
  expect(saves).toEqual([]);
  await page.clock.runFor(1);
  await expect(saved).toHaveText("abc");
  expect(saves).toEqual([JSON.stringify({ draft: "abc" })]);

  await page.clock.runFor(2000);
  await expect(saved).toHaveText("abc");
  expect(saves).toHaveLength(1);

  // The saved draft comes back on reload.
  await page.reload();
  await expect(page.locator(ready)).toHaveCount(1);
  await expect(draft).toHaveValue("abc");
});

test.describe("pending echo", () => {
  const favoriteAction = "**/_hypersig/actions/save-favorite";
  const failAction = "**/_hypersig/actions/fail-next-save";

  function favorite(page: Page): Locator {
    return page.getByRole("button", { name: "Favorite" });
  }

  /** Holds every favorite save until `release` runs. */
  async function holdSaves(page: Page) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(favoriteAction, async (route) => {
      await held;
      await route.continue();
    });
    return () => release();
  }

  async function armFailure(page: Page) {
    await Promise.all([
      page.waitForResponse(failAction),
      page.getByRole("button", { name: "Fail next save" }).click(),
    ]);
    await expect(page.locator("#favorite-fails-next")).toBeVisible();
  }

  test("shows the click as pending, then the committed value", async ({
    page,
  }) => {
    await open(page);
    const other = await page.context().newPage();
    await open(other);
    const button = favorite(page);
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#favorite-unsaved")).toBeHidden();

    const release = await holdSaves(page);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveAttribute("data-hs-pending");
    await expect(page.locator("#favorite-unsaved")).toBeVisible();
    // Nothing is committed while the save is held.
    await expect(favorite(other)).toHaveAttribute("aria-pressed", "false");

    release();
    await expect(button).not.toHaveAttribute("data-hs-pending");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#favorite-unsaved")).toBeHidden();
    await expect(favorite(other)).toHaveAttribute("aria-pressed", "true");

    // A reload renders the committed value.
    await page.reload();
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(favorite(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("a failed save reverts to the committed value", async ({ page }) => {
    await open(page);
    const button = favorite(page);
    await armFailure(page);
    const release = await holdSaves(page);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveAttribute("data-hs-pending");

    release();
    await expect(page.getByRole("alert")).toHaveText(
      "The favorite was not saved (demo failure)."
    );
    await expect(button).not.toHaveAttribute("data-hs-pending");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#favorite-fails-next")).toBeHidden();
  });

  test("a failed save reverts to a value another tab committed meanwhile", async ({
    page,
  }) => {
    await open(page);
    const other = await page.context().newPage();
    await open(other);
    const button = favorite(page);
    const release = await holdSaves(page);
    await button.click();
    await expect(button).toHaveAttribute("data-hs-pending");

    // The other tab commits while this tab's save is held. Its update
    // replaces this tab's echo with the committed value.
    await Promise.all([
      other.waitForResponse(favoriteAction),
      favorite(other).click(),
    ]);
    await expect(favorite(other)).toHaveAttribute("aria-pressed", "true");
    await armFailure(other);
    await expect(page.locator("#favorite-fails-next")).toBeVisible();
    await expect(button).toHaveAttribute("data-hs-pending");

    release();
    await expect(page.getByRole("alert")).toHaveText(
      "The favorite was not saved (demo failure)."
    );
    await expect(button).not.toHaveAttribute("data-hs-pending");
    // The value from before the click was false and the committed one is
    // true. With the previous test, where nothing else commits, this shows
    // that the failure writes the latest committed value.
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(favorite(other)).toHaveAttribute("aria-pressed", "true");
  });
});

test("sends its Content-Security-Policy with the page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
});
