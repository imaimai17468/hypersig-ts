import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function waitForLive(page: Page) {
  await expect(page.locator("html[data-hs-connection=ready]")).toHaveCount(1);
}

function row(page: Page, title: string) {
  return page.getByRole("listitem").filter({ hasText: title });
}

test("shared tasks react across sessions and tabs, with updates scoped to each filter", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing TodoMVC base URL");
  const peerSession = await browser.newContext({ baseURL });
  try {
    await page.goto("/");
    await waitForLive(page);
    const filterNav = page.getByRole("navigation", { name: "Filter tasks" });
    await expect(filterNav.getByRole("link", { name: "All" })).toHaveAttribute(
      "href",
      "/"
    );
    await expect(
      filterNav.getByRole("link", { name: "Active" })
    ).toHaveAttribute("href", "/?filter=active");
    await expect(
      filterNav.getByRole("link", { name: "Completed" })
    ).toHaveAttribute("href", "/?filter=completed");
    await expect(filterNav.getByRole("link", { name: "All" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    const activeTab = await page.context().newPage();
    const completed = await peerSession.newPage();
    const devtools = await peerSession.newCDPSession(completed);
    await devtools.send("Network.enable");
    const fragments: string[] = [];
    devtools.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
      if (eventName === "html-update") fragments.push(data);
    });

    await Promise.all([
      activeTab.goto("/?filter=active"),
      completed.goto("/?filter=completed"),
    ]);
    await Promise.all([waitForLive(activeTab), waitForLive(completed)]);
    expect(
      (await page.context().cookies()).find(
        ({ name }) => name === "todo-session"
      )?.value
    ).not.toBe(
      (await peerSession.cookies()).find(({ name }) => name === "todo-session")
        ?.value
    );
    fragments.length = 0;

    const composer = page.getByRole("textbox", { name: "New task" });
    await composer.fill("  Book tickets  ");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(row(page, "Book tickets")).toBeVisible();
    await expect(row(activeTab, "Book tickets")).toBeVisible();
    await expect(completed.getByText("1 item left")).toBeVisible();
    await expect(row(completed, "Book tickets")).toHaveCount(0);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toContain('"target":"todo-counts-1"');

    fragments.length = 0;
    await page.getByLabel("Edit: Book tickets").click();
    await row(page, "Book tickets")
      .getByRole("textbox", { name: "Task title" })
      .fill("Book train tickets");
    await row(page, "Book tickets")
      .getByRole("button", { name: "Save" })
      .click();
    await expect(row(activeTab, "Book train tickets")).toBeVisible();
    await expect(row(page, "Book train tickets")).toBeVisible();
    expect(fragments).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(
      row(page, "Book train tickets").getByRole("textbox", {
        name: "Task title",
      })
    ).toBeHidden();

    await activeTab
      .getByRole("button", { name: "Completed: Book train tickets" })
      .click();
    await expect(row(activeTab, "Book train tickets")).toHaveCount(0);
    await expect(row(completed, "Book train tickets")).toBeVisible();
    await expect(
      row(page, "Book train tickets").getByRole("button", {
        name: "Completed: Book train tickets",
      })
    ).toHaveAttribute("aria-pressed", "true");

    await completed.getByRole("button", { name: "Reopen all" }).click();
    await expect(row(activeTab, "Book train tickets")).toBeVisible();
    await expect(row(completed, "Book train tickets")).toHaveCount(0);
    await page.getByRole("button", { name: "Complete all" }).click();
    await expect(row(completed, "Book train tickets")).toBeVisible();
    await completed.getByRole("button", { name: "Clear completed" }).click();
    await expect(row(page, "Book train tickets")).toHaveCount(0);
    await expect(row(completed, "Book train tickets")).toHaveCount(0);

    await activeTab.getByRole("link", { name: "Completed" }).click();
    await expect(
      activeTab.getByRole("link", { name: "Completed" })
    ).toHaveAttribute("aria-current", "page");
    await waitForLive(activeTab);
    await expect(activeTab.getByText("No tasks in this view.")).toBeVisible();
  } finally {
    await peerSession.close();
  }
});

test("form reset follows success and preserves validation failures and newer input", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLive(page);
  const composer = page.getByRole("textbox", { name: "New task" });
  await composer.fill("   ");
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Action failed (422).");
  await expect(composer).toHaveValue("   ");

  let resume = () => {};
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const addUrl = "**/_hypersig/actions/add-todo";
  await page.route(addUrl, async (route) => {
    await waiting;
    await route.continue();
  });
  const started = page.waitForRequest(addUrl);
  await composer.fill("First draft");
  await composer.press("Enter");
  try {
    await started;
    await composer.fill("Second draft");
  } finally {
    resume();
  }
  await expect(row(page, "First draft")).toBeVisible();
  await expect(composer).toHaveValue("Second draft");
  await expect(page.locator("[data-hs-error]")).toBeEmpty();
  await page.getByRole("button", { name: "Delete: First draft" }).click();
  await expect(row(page, "First draft")).toHaveCount(0);
});

test("another tab's update preserves an open editor and its draft", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLive(page);
  const composer = page.getByRole("textbox", { name: "New task" });
  await composer.fill("Original");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Edit: Original" }).click();
  const editor = row(page, "Original").getByRole("textbox", {
    name: "Task title",
  });
  await editor.fill("Draft");

  const peer = await page.context().newPage();
  await peer.goto("/");
  await waitForLive(peer);
  const peerComposer = peer.getByRole("textbox", { name: "New task" });
  await peerComposer.fill("Another task");
  await peerComposer.press("Enter");

  await expect(row(page, "Another task")).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Draft");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "Delete: Original" }).click();
  await expect(row(page, "Original")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete: Another task" }).click();
  await expect(row(page, "Another task")).toHaveCount(0);
});

const toggleUrl = "**/_hypersig/actions/set-todo-completed";

async function addTask(page: Page, title: string) {
  const composer = page.getByRole("textbox", { name: "New task" });
  await composer.fill(title);
  await composer.press("Enter");
  await expect(row(page, title)).toBeVisible();
  return page.getByRole("button", { name: `Completed: ${title}` });
}

const addUrl = "**/_hypersig/actions/add-todo";
const removeUrl = "**/_hypersig/actions/remove-todo";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitTask(page: Page, title: string) {
  const composer = page.getByRole("textbox", { name: "New task" });
  await composer.fill(title);
  await composer.press("Enter");
}

// The task list is shared by every test, so remove whatever a test left
// behind, also when it failed partway. A fresh tab avoids held routes.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const cleaner = await page.context().newPage();
  await cleaner.goto("/");
  await waitForLive(cleaner);
  const deletes = cleaner.getByRole("button", { name: /^Delete: / });
  for (let left = await deletes.count(); left > 0; left -= 1) {
    await deletes.first().click();
    await expect(deletes).toHaveCount(left - 1);
  }
  await cleaner.close();
});

test("adds a task once the server confirms it", async ({ page }) => {
  await page.goto("/");
  await waitForLive(page);
  await page.route(addUrl, async (route) => {
    await delay(1500);
    await route.continue();
  });
  const form = page.locator("form.composer");
  const answered = page.waitForResponse(addUrl);
  await submitTask(page, "Confirmed task");
  // Shorter than the route delay, so the checks run before the answer.
  await expect(form).toHaveAttribute("data-hs-pending", "", { timeout: 1000 });
  await expect(row(page, "Confirmed task")).toHaveCount(0, { timeout: 1000 });
  await answered;
  await expect(row(page, "Confirmed task")).toHaveCount(1);
  await expect(form).not.toHaveAttribute("data-hs-pending");
});

test("marks a toggle as pending until the server confirms it", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLive(page);
  const toggle = await addTask(page, "Pending toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.route(toggleUrl, async (route) => {
    await delay(1500);
    await route.continue();
  });
  const answered = page.waitForResponse(toggleUrl);
  await toggle.click();
  // Shorter than the route delay, so the checks run before the answer.
  await expect(toggle).toHaveAttribute("data-hs-pending", "", {
    timeout: 1000,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false", {
    timeout: 1000,
  });
  await expect(toggle).toHaveText("○", { timeout: 1000 });
  await expect(row(page, "Pending toggle")).toHaveCSS("opacity", "0.55", {
    timeout: 1000,
  });
  await answered;
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveText("✓");
  await expect(toggle).not.toHaveAttribute("data-hs-pending");
  await expect(row(page, "Pending toggle")).toHaveCSS("opacity", "1");
});

test("keeps the confirmed value when a toggle fails", async ({ page }) => {
  await page.goto("/");
  await waitForLive(page);
  const toggle = await addTask(page, "Failed toggle");

  await page.route(toggleUrl, async (route) => {
    await delay(1500);
    await route.fulfill({ status: 500, body: "" });
  });
  const answered = page.waitForResponse(toggleUrl);
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-hs-pending", "", {
    timeout: 1000,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false", {
    timeout: 1000,
  });
  await answered;
  await expect(page.locator("[data-hs-error]")).toHaveText(
    "Action failed (500)."
  );
  await expect(toggle).not.toHaveAttribute("data-hs-pending");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveText("○");
});

test("keeps a toggle pending while another update re-renders the list", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing TodoMVC base URL");
  const peerSession = await browser.newContext({ baseURL });
  try {
    await page.goto("/");
    await waitForLive(page);
    const toggle = await addTask(page, "Held toggle");
    const peer = await peerSession.newPage();
    await peer.goto("/");
    await waitForLive(peer);

    let resume = () => {};
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    await page.route(toggleUrl, async (route) => {
      await waiting;
      await route.continue();
    });
    const started = page.waitForRequest(toggleUrl);
    const answered = page.waitForResponse(toggleUrl);
    await toggle.click();
    try {
      await started;
      await expect(toggle).toHaveAttribute("data-hs-pending", "");
      await submitTask(peer, "Peer task");
      await expect(row(page, "Peer task")).toBeVisible();
      await expect(toggle).toHaveAttribute("data-hs-pending", "");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    } finally {
      resume();
    }
    await answered;
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).not.toHaveAttribute("data-hs-pending");
  } finally {
    await peerSession.close();
  }
});

test("marks a delete as pending and removes the row once confirmed", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLive(page);
  await addTask(page, "Doomed task");
  const doomed = row(page, "Doomed task");
  const deleteButton = page.getByRole("button", {
    name: "Delete: Doomed task",
  });

  await page.route(removeUrl, async (route) => {
    await delay(1500);
    await route.fulfill({ status: 500, body: "" });
  });
  let answered = page.waitForResponse(removeUrl);
  await deleteButton.click();
  // Shorter than the route delay, so the checks run before the answer.
  await expect(deleteButton).toHaveAttribute("data-hs-pending", "", {
    timeout: 1000,
  });
  await expect(doomed).toBeVisible({ timeout: 1000 });
  await expect(doomed).toHaveCSS("opacity", "0.55", { timeout: 1000 });
  await answered;
  await expect(deleteButton).not.toHaveAttribute("data-hs-pending");
  await expect(doomed).toBeVisible();

  await page.unroute(removeUrl);
  await page.route(removeUrl, async (route) => {
    await delay(1500);
    await route.continue();
  });
  answered = page.waitForResponse(removeUrl);
  await deleteButton.click();
  await expect(deleteButton).toHaveAttribute("data-hs-pending", "", {
    timeout: 1000,
  });
  await expect(doomed).toBeVisible({ timeout: 1000 });
  await answered;
  await expect(doomed).toHaveCount(0);
});

test("adds a second task in the same page after the first succeeds", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLive(page);
  const composer = page.getByRole("textbox", { name: "New task" });

  for (const title of ["First in a row", "Second in a row"]) {
    const answered = page.waitForResponse(addUrl);
    await submitTask(page, title);
    expect((await answered).ok()).toBe(true);
    await expect(composer).toHaveValue("");
  }

  for (const title of ["First in a row", "Second in a row"]) {
    await expect(row(page, title)).toHaveCount(1);
  }
});

test("adds a task with JavaScript disabled", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("Missing TodoMVC base URL");
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(
      page.locator('form.composer input[type="hidden"]')
    ).toHaveCount(0);
    await page.getByRole("textbox", { name: "New task" }).fill("Native add");
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/_hypersig/actions/add-todo")
      ),
      page.getByRole("button", { name: "Add" }).click(),
    ]);
    expect(response.status()).toBe(303);
    await expect(page).toHaveURL(baseURL + "/");
    await expect(row(page, "Native add")).toHaveCount(1);
  } finally {
    await context.close();
  }
});
