import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const saveUrl = "**/_hypersig/actions/save-memo";

function saveMemo(page: Page) {
  const response = page.waitForResponse(saveUrl);
  return Promise.all([
    response,
    page.getByRole("button", { name: "保存", exact: true }).click(),
  ]).then(([result]) => result);
}

test("keeps drafts and rejects a save against an older shared memo revision", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing shared memo base URL");
  const context = await browser.newContext({ baseURL });
  try {
    const peer = await context.newPage();
    const [initial] = await Promise.all([page.goto("/"), peer.goto("/")]);
    expect(await initial?.text()).toContain("引き継ぎメモ");
    const ready = "html[data-hs-connection=ready]";
    await Promise.all([
      expect(page.locator(ready)).toHaveCount(1),
      expect(peer.locator(ready)).toHaveCount(1),
    ]);

    const first = page.getByRole("textbox", { name: "本文" });
    const second = peer.getByRole("textbox", { name: "本文" });
    await second.fill("後から送る下書き");
    await first.fill("先に公開したメモ");
    let releaseResponse = () => {};
    const responseHeld = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(
      saveUrl,
      async (route) => {
        const response = await route.fetch();
        await responseHeld;
        await route.fulfill({ response });
      },
      { times: 1 }
    );
    const firstSave = saveMemo(page);
    try {
      await expect(peer.locator("#published-memo")).toHaveText(
        "先に公開したメモ"
      );
      await expect(page.locator("#published-memo")).toHaveText(
        "先に公開したメモ"
      );
      await expect(page.locator("#draft-version")).toHaveText("1");
      await expect(page.getByText("送信中…")).toBeVisible();
      await first.fill("保存の返事を待つ間の追記");
    } finally {
      releaseResponse();
      expect((await firstSave).status()).toBe(200);
    }
    await expect(second).toHaveValue("後から送る下書き");
    await expect(peer.locator("#draft-version")).toHaveText("1");
    await expect(peer.locator("#newer-version")).toBeVisible();
    await expect(page.locator("#draft-version")).toHaveText("2");
    await expect(page.locator("#newer-version")).toBeHidden();
    await expect(page.getByText("送信中…")).toBeHidden();
    await expect(first).toHaveValue("保存の返事を待つ間の追記");

    expect((await saveMemo(peer)).status()).toBe(409);
    await expect(peer.getByRole("alert")).toContainText(
      "別の編集が先に保存されたため、下書きは保存されていません。"
    );
    await expect(second).toHaveValue("後から送る下書き");
    await expect(page.locator("#published-memo")).toHaveText(
      "先に公開したメモ"
    );

    await peer.getByRole("link", { name: "最新版を読み込む" }).click();
    await expect(peer.locator(ready)).toHaveCount(1);
    await expect(peer.locator("#draft-version")).toHaveText("2");
    await expect(second).toHaveValue("先に公開したメモ");
    await second.fill("  ");
    expect((await saveMemo(peer)).status()).toBe(422);
    await expect(peer.locator("#memo-text-error")).toHaveText(
      "本文を入力してください。"
    );
    await expect(page.locator("#published-memo")).toHaveText(
      "先に公開したメモ"
    );

    await second.fill("修正して公開したメモ");
    expect((await saveMemo(peer)).status()).toBe(200);
    await expect(page.locator("#published-memo")).toHaveText(
      "修正して公開したメモ"
    );
    await expect(peer.getByRole("alert")).toBeEmpty();
    await expect(peer.locator("#memo-text-error")).toBeEmpty();

    await expect(peer.locator("#draft-version")).toHaveText("3");
    await second.fill("ページを開いたまま追記したメモ");
    expect((await saveMemo(peer)).status()).toBe(200);
    await expect(peer.locator("#draft-version")).toHaveText("4");
    await expect(peer.locator("#newer-version")).toBeHidden();
    await expect(page.locator("#published-memo")).toHaveText(
      "ページを開いたまま追記したメモ"
    );
    await expect(page.locator("#draft-version")).toHaveText("2");

    await context.setOffline(true);
    await second.fill("通信が切れている間の下書き");
    await peer.getByRole("button", { name: "保存", exact: true }).click();
    await expect(peer.getByRole("alert")).toHaveText("Action request failed.");
    await expect(second).toHaveValue("通信が切れている間の下書き");
    await expect(page.locator("#published-memo")).toHaveText(
      "ページを開いたまま追記したメモ"
    );
  } finally {
    await context.close();
  }
});

test("native forms preserve invalid and conflicting drafts and redirect after a save", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing shared memo base URL");
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    const peer = await context.newPage();
    await page.goto("/");
    await expect(page.locator("link[rel=prefetch]")).toHaveAttribute(
      "href",
      "/guide"
    );
    const guide = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/guide"
      ),
      page.getByRole("link", { name: "使い方", exact: true }).click(),
    ]);
    expect(guide[0].headers()["cache-control"]).toBe("public, max-age=300");
    await page.getByRole("link", { name: "共有メモに戻る" }).click();
    await peer.goto("/");

    const draft = page.getByRole("textbox", { name: "本文" });
    await draft.fill("  ");
    const invalid = await saveMemo(page);
    expect(invalid.status()).toBe(422);
    expect(invalid.headers()["cache-control"]).toBe("no-store");
    await expect(page.locator("#memo-text-error")).toHaveText(
      "本文を入力してください。"
    );
    await expect(draft).toHaveValue("  ");

    await draft.fill("JavaScript なしで確定");
    const saved = await saveMemo(page);
    expect(saved.status()).toBe(303);
    await expect(page).toHaveURL(baseURL + "/");
    await expect(page.locator("#published-memo")).toHaveText(
      "JavaScript なしで確定"
    );

    const stale = peer.getByRole("textbox", { name: "本文" });
    await stale.fill("競合したまま残る下書き");
    expect((await saveMemo(peer)).status()).toBe(409);
    await expect(stale).toHaveValue("競合したまま残る下書き");
    await expect(peer.getByRole("alert")).toContainText(
      "別の編集が先に保存されたため"
    );
    await expect(peer.locator("#published-memo")).toHaveText(
      "JavaScript なしで確定"
    );
  } finally {
    await context.close();
  }
});

async function resetLiveRegistration(page: Page) {
  await page.route(
    "**/_hypersig/stream/**",
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: "event: reset\ndata: {}\n\n",
      }),
    { times: 1 }
  );
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
  });
}

test("restores a draft and its original revision across a live registration reset", async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing shared memo base URL");
  const context = await browser.newContext({ baseURL });
  try {
    const peer = await context.newPage();
    await Promise.all([page.goto("/"), peer.goto("/")]);
    const ready = "html[data-hs-connection=ready]";
    await expect(page.locator(ready)).toHaveCount(1);
    const draft = page.getByRole("textbox", { name: "本文" });
    const original = await page.locator("#draft-version").textContent();
    await draft.fill("復旧前に書いていた下書き");
    await peer
      .getByRole("textbox", { name: "本文" })
      .fill("復旧後に読む共有メモ");
    expect((await saveMemo(peer)).status()).toBe(200);
    await expect(page.locator("#published-memo")).toHaveText(
      "復旧後に読む共有メモ"
    );
    const loaded = page.waitForEvent("domcontentloaded");
    await resetLiveRegistration(page);
    await loaded;
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(draft).toHaveValue("復旧前に書いていた下書き");
    await expect(page.locator("#restored-draft")).toBeVisible();
    if (original === null) throw new Error("Missing draft revision");
    await expect(page.locator("#draft-version")).toHaveText(original);
    await expect(page.locator("#newer-version")).toBeVisible();
    expect((await saveMemo(page)).status()).toBe(409);
    await expect(page.locator("#published-memo")).toHaveText(
      "復旧後に読む共有メモ"
    );

    await page
      .getByRole("button", { name: "表示中の版から編集を続ける" })
      .click();
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("復旧前に書いていた下書き");
    await expect(page.locator("#newer-version")).toBeHidden();
    await expect(page.locator("#draft-version")).toHaveText(
      String(Number(original) + 1)
    );
    expect((await saveMemo(page)).status()).toBe(200);
    await expect(peer.locator("#published-memo")).toHaveText(
      "復旧前に書いていた下書き"
    );
    await expect(page.locator("#restored-draft")).toBeHidden();

    await draft.fill("次のセッションに渡さない下書き");
    await page.context().clearCookies();
    const reauthenticated = page.waitForEvent("domcontentloaded");
    await resetLiveRegistration(page);
    await reauthenticated;
    await expect(page.locator(ready)).toHaveCount(1);
    await expect(draft).toHaveValue("復旧前に書いていた下書き");
    await expect(page.locator("#restored-draft")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("keeps the form open when browser storage prevents saving a draft for a reset", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("html[data-hs-connection=ready]")).toHaveCount(1);
  const draft = page.getByRole("textbox", { name: "本文" });
  await draft.fill("保存先がなくても残る下書き");
  await resetLiveRegistration(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-hs-connection",
    "reload-required"
  );
  await expect(draft).toHaveValue("保存先がなくても残る下書き");
  await expect(page.locator("#published-memo")).toHaveCount(0);
  await expect(page.locator("[data-hs-connection-status]")).toContainText(
    "Copy your draft"
  );
});

test("retries a committed save once when the HTTP response is lost", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html[data-hs-connection=ready]")).toHaveCount(1);
  const draft = page.getByRole("textbox", { name: "本文" });
  const revision = Number(await page.locator("#draft-version").textContent());
  const token = page.locator("[name=operationId]");
  const original = await token.inputValue();
  await page.route(
    saveUrl,
    async (route) => {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort("failed");
    },
    { times: 1 }
  );
  await draft.fill("応答が届かなくても確定したメモ");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Action request failed.");
  await expect(page.locator("#published-memo")).toHaveText(
    "応答が届かなくても確定したメモ"
  );
  await expect(token).toHaveValue(original);
  const retry = await saveMemo(page);
  expect(retry.status()).toBe(200);
  expect(await retry.json()).toEqual({ data: { revision: revision + 1 } });
  await expect(page.locator("#draft-version")).toHaveText(String(revision + 1));
  await expect(page.locator("[data-revision]")).toHaveAttribute(
    "data-revision",
    String(revision + 1)
  );
  await expect(token).not.toHaveValue(original);
});
