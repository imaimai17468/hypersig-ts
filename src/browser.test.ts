import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { events, outletAttributes, streamParams } from "./protocol.js";

/** An EventSource the test drives by dispatching the server's events. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static readonly opened: FakeEventSource[] = [];
  readyState = 0;
  readonly url: URL;
  constructor(url: string | URL) {
    super();
    this.url = new URL(url);
    FakeEventSource.opened.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown = null) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function latestSource() {
  const source = FakeEventSource.opened.at(-1);
  if (!source) throw new Error("The runtime opened no stream");
  return source;
}

interface JsdomHandle {
  virtualConsole: {
    on(event: "jsdomError", listener: (error: Error) => void): void;
  };
}

function isJsdomHandle(value: unknown): value is JsdomHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "virtualConsole" in value &&
    typeof value.virtualConsole === "object"
  );
}

/** jsdom reports `location.reload()` as a navigation it does not implement. */
let reloads = 0;
const jsdom: unknown = Reflect.get(globalThis, "jsdom");
if (!isJsdomHandle(jsdom)) throw new Error("The test needs the jsdom instance");
jsdom.virtualConsole.on("jsdomError", (error) => {
  if (error.message.includes("navigation")) reloads += 1;
});

/** Loads the runtime into a page with `body`, as a fresh page load would. */
async function loadPage(body: string) {
  window.dispatchEvent(new Event("pagehide"));
  document.body.innerHTML = `<script data-hs-stream="/_hypersig/stream" data-hs-draft-scope="page"></script>${body}`;
  vi.resetModules();
  await import("./browser.js");
}

/** Waits for the MutationObserver callback. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const find = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  reloads = 0;
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.innerHTML = "";
  delete document.documentElement.dataset.hsConnection;
  FakeEventSource.opened.length = 0;
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores views inside the children of an owned element", async () => {
  await loadPage(
    `<div id="cart" data-hs-view="cart">old</div>` +
      `<rich-editor data-hs-owns-children>` +
      `<div id="forged" data-hs-view="cart"></div>` +
      `<div data-hs-view="ghost"></div>` +
      `</rich-editor>`
  );
  const source = latestSource();
  expect(source.url.searchParams.getAll(streamParams.view)).toEqual(["cart"]);

  source.emit(events.update, {
    target: "cart",
    version: 1,
    html: "<p>new</p>",
  });
  expect(find("#cart").innerHTML).toBe("<p>new</p>");
  expect(find("#forged").innerHTML).toBe("");

  find("rich-editor").insertAdjacentHTML(
    "beforeend",
    `<div data-hs-view="injected"></div>`
  );
  await settle();
  expect(FakeEventSource.opened).toEqual([source]);
});

it("writes the connection status outside the children of an owned element", async () => {
  await loadPage(
    `<rich-editor data-hs-owns-children>` +
      `<p id="forged" ${outletAttributes.connectionStatus}></p>` +
      `</rich-editor>` +
      `<p id="status" ${outletAttributes.connectionStatus}></p>` +
      `<div data-hs-view="cart"></div>`
  );
  latestSource().dispatchEvent(new Event("error"));

  expect(find("#status").textContent).toBe("Live updates disconnected.");
  expect(find("#forged").textContent).toBe("");
});

it("finds a nested view under its root past an earlier element with its id", async () => {
  await loadPage(
    `<span id="hs-view-board/col">decoy</span>` +
      `<div data-hs-view="board">` +
      `<div id="hs-view-board/col" data-hs-view="board/col">old</div>` +
      `</div>`
  );
  latestSource().emit(events.update, {
    target: "board/col",
    version: 1,
    html: "<p>new</p>",
  });

  expect(find("[data-hs-view='board/col']").innerHTML).toBe("<p>new</p>");
  expect(find("span").textContent).toBe("decoy");
});

it("skips a nested view inside the children of an owned element", async () => {
  await loadPage(
    `<div data-hs-view="board">` +
      `<rich-editor data-hs-owns-children>` +
      `<div id="hs-view-board/col" data-hs-view="board/col" class="forged"></div>` +
      `</rich-editor>` +
      `<div id="hs-view-board/col" data-hs-view="board/col" class="real">old</div>` +
      `</div>`
  );
  latestSource().emit(events.update, {
    target: "board/col",
    version: 1,
    html: "<p>new</p>",
  });

  expect(find(".real").innerHTML).toBe("<p>new</p>");
  expect(find(".forged").innerHTML).toBe("");
});

it("keeps a nested view of an update out of the children of an owned element", async () => {
  await loadPage(`<div data-hs-view="board"></div>`);
  const source = latestSource();
  source.emit(events.update, {
    target: "board",
    version: 1,
    children: ["board/col"],
    html:
      `<rich-editor data-hs-owns-children>` +
      `<div id="hs-view-board/col" data-hs-view="board/col" class="forged"></div>` +
      `</rich-editor>` +
      `<div id="hs-view-board/col" data-hs-view="board/col" class="real">old</div>`,
  });
  source.emit(events.update, {
    target: "board/col",
    version: 1,
    html: "<p>new</p>",
  });

  expect(find(".real").innerHTML).toBe("<p>new</p>");
  expect(find(".forged").innerHTML).toBe("");
});

/** Loads a page with a draft form and a view at `time`. */
async function loadResetPage(time: number) {
  vi.setSystemTime(time);
  await loadPage(
    `<form data-hs-draft-form="memo"><textarea name="body" data-hs-draft>saved</textarea></form>` +
      `<div id="cart" data-hs-view="cart">cart</div>`
  );
}

/** Loads the page and has the server reset the stream at `time`. */
async function resetAt(time: number) {
  await loadResetPage(time);
  latestSource().emit(events.reset);
}

it("stops reloading after three resets within a minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await resetAt(0);
  await resetAt(1_000);
  await resetAt(2_000);
  expect(reloads).toBe(3);
  expect(document.documentElement.dataset.hsConnection).not.toBe(
    "reload-required"
  );

  await loadResetPage(59_999);
  const draft = find("textarea");
  if (!(draft instanceof HTMLTextAreaElement)) throw new Error("No draft");
  draft.value = "edited";
  latestSource().emit(events.reset);
  expect(reloads).toBe(3);
  expect(document.documentElement.dataset.hsConnection).toBe("reload-required");
  expect(find("#cart").innerHTML).toBe("");
  expect(draft.value).toBe("edited");

  await resetAt(60_000);
  expect(reloads).toBe(4);
});

it("asks for a reload when it cannot count reloads in session storage", async () => {
  await loadPage(`<div id="cart" data-hs-view="cart">cart</div>`);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage is disabled");
  });
  latestSource().emit(events.reset);

  expect(reloads).toBe(0);
  expect(document.documentElement.dataset.hsConnection).toBe("reload-required");
});

it("reloads when the saved reload times are malformed", async () => {
  await loadPage(`<div data-hs-view="cart"></div>`);
  sessionStorage.setItem("hypersig:reset-reloads", "{");
  latestSource().emit(events.reset);

  expect(reloads).toBe(1);
});

it("reopens the stream at once on reconnect without showing it disconnected", async () => {
  await loadPage(
    `<p id="status" ${outletAttributes.connectionStatus}></p>` +
      `<div id="cart" data-hs-view="cart">cart</div>` +
      `<div id="menu" data-hs-view="menu">menu</div>`
  );
  const first = latestSource();
  first.emit(events.update, { target: "cart", version: 1, html: "new" });
  first.emit(events.ready);
  const statuses: (string | undefined)[] = [];
  const watcher = new MutationObserver(() => {
    statuses.push(document.documentElement.dataset.hsConnection);
  });
  watcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-hs-connection"],
  });

  first.emit(events.reconnect);
  await settle();
  watcher.disconnect();

  expect(first.readyState).toBe(FakeEventSource.CLOSED);
  const second = latestSource();
  expect(second).not.toBe(first);
  expect(second.url.searchParams.getAll(streamParams.view)).toEqual([
    "cart",
    "menu",
  ]);
  // The updated view is no longer the SSR HTML, so the server renders it.
  expect(second.url.searchParams.getAll(streamParams.pristine)).toEqual([
    "menu",
  ]);
  // The status stays ready, never passing through disconnected or connecting.
  expect(statuses).toEqual([]);
  expect(document.documentElement.dataset.hsConnection).toBe("ready");
  expect(find("#status").textContent).toBe("");
  expect(find("#cart").textContent).toBe("new");
  expect(reloads).toBe(0);

  first.emit(events.update, { target: "cart", version: 2, html: "stale" });
  expect(find("#cart").textContent).toBe("new");
  second.dispatchEvent(new Event("open"));
  second.emit(events.update, { target: "cart", version: 1, html: "fresh" });
  expect(find("#cart").textContent).toBe("fresh");
});

it("stops live updates on evicted and keeps the views", async () => {
  vi.useFakeTimers();
  await loadPage(
    `<p id="status" ${outletAttributes.connectionStatus}></p>` +
      `<div id="cart" data-hs-view="cart">cart</div>`
  );
  const source = latestSource();
  source.emit(events.ready);

  source.emit(events.evicted);

  expect(source.readyState).toBe(FakeEventSource.CLOSED);
  expect(document.documentElement.dataset.hsConnection).toBe("too-many-tabs");
  expect(find("#status").textContent).toBe(
    "Live updates stopped because this page is open in too many tabs. Reload to resume."
  );
  expect(find("#cart").textContent).toBe("cart");
  expect(reloads).toBe(0);

  // Neither a retry nor a view the page adds opens another stream.
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div data-hs-view="menu"></div>`
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(FakeEventSource.opened).toEqual([source]);
});
