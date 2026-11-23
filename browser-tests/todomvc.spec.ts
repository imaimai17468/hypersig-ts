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
