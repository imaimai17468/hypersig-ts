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
