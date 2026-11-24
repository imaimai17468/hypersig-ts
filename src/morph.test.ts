import { expect, it } from "vite-plus/test";
import { morphView } from "./morph.js";
import { sanitizeFragment } from "./sanitize.js";
import { startSignals } from "./signal-runtime.js";

/** Stands in for the element's JavaScript, which renders its own children. */
function renderOwnedChildren(element: Element) {
  element.innerHTML = "<button>★</button><button>★</button>";
}

function createView(html: string) {
  const view = document.createElement("div");
  view.dataset.hsView = "ratings";
  view.innerHTML = html;
  document.body.append(view);
  return view;
}

const runtime = startSignals({ root: document });

it("updates the attributes of an owned element and keeps its children", () => {
  const view = createView(
    `<p>old</p><star-rating id="r" value="1" class="old" data-hs-owns-children></star-rating>`
  );
  const owned = view.querySelector("star-rating");
  if (!owned) throw new Error("Missing star-rating");
  renderOwnedChildren(owned);

  morphView(
    view,
    sanitizeFragment(
      `<p>new</p><star-rating id="r" value="4" data-hs-owns-children data-hs-on-custom="[]"></star-rating><p>after</p>`
    ),
    runtime
  );

  const morphed = view.querySelector("star-rating");
  expect(morphed).toBe(owned);
  expect(morphed?.getAttribute("value")).toBe("4");
  expect(morphed?.hasAttribute("class")).toBe(false);
  expect(morphed?.getAttribute("data-hs-on-custom")).toBe("[]");
  expect(morphed?.querySelectorAll("button")).toHaveLength(2);
  expect([...view.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    "new",
    "after",
  ]);
  view.remove();
});

it("leaves the bound attributes of a kept element to the runtime", () => {
  const bindings = JSON.stringify({
    value: ["sig", ["vote-1", "score"]],
    readonly: ["sig", ["vote-1", "locked"]],
  });
  const view = createView(
    `<star-rating id="r" value="3" readonly class="old" data-hs-owns-children data-hs-element-attr='${bindings}'></star-rating>`
  );
  const owned = view.querySelector("star-rating");
  if (!owned) throw new Error("Missing star-rating");
  renderOwnedChildren(owned);
  const observer = new MutationObserver(() => {});
  observer.observe(owned, { attributeFilter: ["value", "readonly"] });

  // The server renders the initial signal values: value 0 and readonly false.
  morphView(
    view,
    sanitizeFragment(
      `<star-rating id="r" value="0" class="new" data-hs-owns-children data-hs-element-attr='${bindings}'></star-rating>`
    ),
    runtime
  );

  expect(observer.takeRecords()).toEqual([]);
  observer.disconnect();
  expect(view.querySelector("star-rating")).toBe(owned);
  expect(owned.getAttribute("value")).toBe("3");
  expect(owned.hasAttribute("readonly")).toBe(true);
  expect(owned.getAttribute("class")).toBe("new");
  expect(owned.querySelectorAll("button")).toHaveLength(2);
  view.remove();
});

it("copies a fixed JSON attribute of a kept element and leaves a bound one to the runtime", () => {
  const bindings = JSON.stringify({ items: ["sig", ["list-1", "items"]] });
  const json = JSON.stringify(["items"]);
  const view = createView(
    `<sortable-list id="l" items='["a"]' config='{"size":1}' data-hs-owns-children data-hs-element-attr='${bindings}' data-hs-element-json='${json}'></sortable-list>`
  );
  const owned = view.querySelector("sortable-list");
  if (!owned) throw new Error("Missing sortable-list");
  renderOwnedChildren(owned);

  morphView(
    view,
    sanitizeFragment(
      `<sortable-list id="l" items='[]' config='{"size":2}' data-hs-owns-children data-hs-element-attr='${bindings}' data-hs-element-json='${json}'></sortable-list>`
    ),
    runtime
  );

  expect(view.querySelector("sortable-list")).toBe(owned);
  expect(owned.getAttribute("config")).toBe('{"size":2}');
  expect(owned.getAttribute("items")).toBe('["a"]');
  expect(owned.querySelectorAll("button")).toHaveLength(2);
  view.remove();
});

it("replaces an owned element whose id differs, rebuilding its children", () => {
  const view = createView(
    `<star-rating value="1" data-hs-owns-children></star-rating><p>tail</p>`
  );
  const owned = view.querySelector("star-rating");
  if (!owned) throw new Error("Missing star-rating");
  renderOwnedChildren(owned);

  morphView(
    view,
    sanitizeFragment(
      `<star-rating id="b" value="2" data-hs-owns-children></star-rating><p>tail</p><p>more</p>`
    ),
    runtime
  );

  const morphed = view.querySelector("star-rating");
  expect(morphed).not.toBe(owned);
  expect(morphed?.id).toBe("b");
  expect(morphed?.getAttribute("value")).toBe("2");
  expect(morphed?.children).toHaveLength(0);
  expect([...view.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    "tail",
    "more",
  ]);
  view.remove();
});

it("keeps data-hs-pending on an owned element while its request is in flight", async () => {
  const pending = startSignals({
    root: document,
    send: () => new Promise(() => {}),
  });
  const view = createView(
    `<star-rating id="p" data-hs-owns-children></star-rating>`
  );
  const owned = view.querySelector<HTMLElement>("star-rating");
  if (!owned) throw new Error("Missing star-rating");
  void pending.send(owned, "/actions/rate", "{}");
  await Promise.resolve();
  expect(owned.hasAttribute("data-hs-pending")).toBe(true);

  morphView(
    view,
    sanitizeFragment(
      `<star-rating id="p" value="3" data-hs-owns-children></star-rating>`
    ),
    pending
  );

  expect(owned.getAttribute("value")).toBe("3");
  expect(owned.hasAttribute("data-hs-pending")).toBe(true);
  view.remove();
});

it("leaves a nested view untouched", () => {
  const view = createView(
    `<div id="hs-view-ratings/a" data-hs-view="ratings/a"><p>child</p></div>`
  );

  morphView(
    view,
    sanitizeFragment(
      `<div id="hs-view-ratings/a" data-hs-view="ratings/a"><p>server</p></div>`
    ),
    runtime
  );

  expect(view.querySelector("p")?.textContent).toBe("child");
  view.remove();
});
