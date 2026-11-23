// The automatic JSX runtime that `<span {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import { expect, it } from "vite-plus/test";
import { on, ref, signals, uuid } from "./index.js";
import { startSignals } from "./signal-runtime.js";

/**
 * Each test gets its own document in a frame, so the listeners a runtime adds
 * do not reach other tests.
 */
function createPage(html: string) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const page = frame.contentDocument;
  const view = page?.defaultView;
  if (!page || !view) throw new Error("The frame has no document");
  page.body.innerHTML = html;
  const find = <E extends Element = HTMLElement>(selector: string) => {
    const element = page.querySelector<E>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  return {
    page,
    find,
    input: (selector: string) => find<HTMLInputElement>(selector),
    click: (selector: string) => find(selector).click(),
    dispatch: (selector: string, type: "input" | "change") =>
      find(selector).dispatchEvent(new view.Event(type, { bubbles: true })),
  };
}

/** Waits for the microtask that re-evaluates bindings. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const element = (tag: string, props: Record<string, unknown>) =>
  jsx(tag, props);
const render = (tag: string, props: Record<string, unknown>) =>
  String(element(tag, props));

it("initializes from data-hs-signals and updates bound text on click", async () => {
  const counter = signals({ count: 0, open: false }, { name: "click-counter" });
  const c = counter.with({ count: 2 });
  const { page, find, click } = createPage(
    render("div", {
      ...c.init(),
      children: [
        element("span", { id: "count", ...c.bindText(c.count.mul(10)) }),
        element("p", { id: "panel", ...c.bindShow(c.open) }),
        element("button", {
          id: "add",
          ...on.click([c.count.set(c.count.add(1)), c.open.toggle()]),
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  expect(runtime.read(c.count.path)).toBe(2);
  expect(find("#count").textContent).toBe("20");
  expect(find("#panel").hasAttribute("hidden")).toBe(true);

  click("#add");
  await settle();
  expect(runtime.read(c.count.path)).toBe(3);
  expect(find("#count").textContent).toBe("30");
  expect(find("#panel").hasAttribute("hidden")).toBe(false);

  click("#add");
  await settle();
  expect(find("#panel").hasAttribute("hidden")).toBe(true);
});

it("prefers a restored or browser-kept input value at load", () => {
  const form = signals(
    { title: "", agreed: false, untouched: "kept" },
    { name: "kept-form" }
  );
  const f = form.with({ title: "server" });
  const { page, input, find } = createPage(
    render("div", {
      ...f.init(),
      children: [
        element("input", { id: "title", ...f.bindValue(f.title) }),
        element("input", {
          id: "agreed",
          type: "checkbox",
          ...f.bindValue(f.agreed),
        }),
        element("input", {
          id: "untouched",
          ...form.with({ untouched: "stale" }).bindValue(f.untouched),
        }),
        element("span", { id: "echo", ...f.bindText(f.title) }),
      ],
    })
  );
  input("#title").value = "restored";
  input("#agreed").checked = true;
  const runtime = startSignals({ root: page });

  expect(runtime.read(f.title.path)).toBe("restored");
  expect(runtime.read(f.agreed.path)).toBe(true);
  expect(runtime.read(f.untouched.path)).toBe("kept");
  expect(input("#untouched").value).toBe("kept");
  expect(find("#echo").textContent).toBe("restored");
});

it("converts number inputs and ignores non-finite values", async () => {
  const editor = signals({ base: 0, done: false }, { name: "number-editor" });
  const e = editor.with({ base: 4 });
  const { page, input, dispatch } = createPage(
    render("div", {
      ...e.init(),
      children: [
        element("input", { id: "base", ...e.bindValue(e.base) }),
        element("input", {
          id: "done",
          type: "checkbox",
          ...e.bindValue(e.done),
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  input("#base").value = "7";
  dispatch("#base", "input");
  expect(runtime.read(e.base.path)).toBe(7);
  input("#base").value = "seven";
  dispatch("#base", "input");
  input("#base").value = "1e999";
  dispatch("#base", "change");
  expect(runtime.read(e.base.path)).toBe(7);

  input("#done").checked = true;
  dispatch("#done", "change");
  expect(runtime.read(e.done.path)).toBe(true);
  await settle();
});

it("writes bound inputs without changing their default value", async () => {
  const draft = signals({ title: "" }, { name: "reset-draft" });
  const d = draft.with({ title: "first" });
  const { page, input, click } = createPage(
    render("div", {
      ...d.init(),
      children: [
        element("input", { id: "title", ...d.bindValue(d.title) }),
        element("button", { id: "clear", ...on.click(d.title.set("")) }),
      ],
    })
  );
  startSignals({ root: page });

  click("#clear");
  await settle();
  expect(input("#title").value).toBe("");
  expect(input("#title").defaultValue).toBe("first");
});

it("runs the closest input and change handlers after writing the input", async () => {
  const search = signals({ query: "", echo: "" }, { name: "search-box" });
  const s = search.with({});
  const { page, input, find, dispatch } = createPage(
    render("div", {
      ...s.init(),
      ...on.change(s.echo.set(s.query.concat("!"))),
      children: [
        element("input", {
          id: "query",
          ...s.bindValue(s.query),
          ...on.input(s.echo.set(s.query)),
        }),
        element("span", { id: "echo", ...s.bindText(s.echo) }),
      ],
    })
  );
  startSignals({ root: page });

  input("#query").value = "abc";
  dispatch("#query", "input");
  await settle();
  expect(find("#echo").textContent).toBe("abc");

  dispatch("#query", "change");
  await settle();
  expect(find("#echo").textContent).toBe("abc!");
});

it("binds only allowed attributes even from a crafted attribute", () => {
  const { page, find } = createPage(
    `<button id="b" disabled data-hs-attr='{"href":["lit","/x"],"onclick":["lit","alert(1)"],"style":["lit","color:red"],"data-hs-text":["lit","x"],"DATA-X":["lit","x"],"aria-pressed":["lit",true],"data-count":["lit",3],"disabled":["lit",0]}'>b</button>`
  );
  startSignals({ root: page });

  const button = find("#b");
  expect(button.getAttributeNames().sort()).toEqual([
    "aria-pressed",
    "data-count",
    "data-hs-attr",
    "id",
  ]);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("data-count")).toBe("3");
});

it("applies Live View snapshots but not those of nested views", async () => {
  const outer = signals({ revision: 0 }, { name: "outer-view" });
  const inner = signals({ revision: 0 }, { name: "inner-view" });
  const o = outer.with({ revision: 1 });
  const i = inner.with({ revision: 1 });
  const { page, find, runtime } = (() => {
    const created = createPage(
      render("div", {
        "data-hs-view": "memo",
        children: [
          element("p", { id: "outer-snapshot", ...o.init() }),
          element("div", {
            "data-hs-view": "memo/child",
            id: "inner-snapshot",
            ...i.init(),
          }),
        ],
      }) +
        render("span", { id: "outer", ...o.bindText(o.revision) }) +
        render("span", { id: "inner", ...i.bindText(i.revision) })
    );
    return { ...created, runtime: startSignals({ root: created.page }) };
  })();

  find("#outer-snapshot").setAttribute(
    "data-hs-signals",
    o.with({ revision: 2 }).init()["data-hs-signals"]
  );
  find("#inner-snapshot").setAttribute(
    "data-hs-signals",
    i.with({ revision: 2 }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(find("[data-hs-view='memo']"));
  await settle();

  expect(find("#outer").textContent).toBe("2");
  expect(find("#inner").textContent).toBe("1");
  expect(page.querySelectorAll("[data-hs-view]")).toHaveLength(2);
});

it("keeps a focused input's value when its Live View snapshot arrives", async () => {
  const memo = signals({ title: "", revision: 0 }, { name: "focused-memo" });
  const m = memo.with({ title: "server", revision: 1 });
  const { page, find, input, dispatch } = createPage(
    render("div", {
      "data-hs-view": "memo",
      ...m.init(),
      children: [
        element("input", { id: "title", ...m.bindValue(m.title) }),
        element("span", { id: "revision", ...m.bindText(m.revision) }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  const title = input("#title");
  title.focus();
  title.value = "typing";
  dispatch("#title", "input");
  const view = find("[data-hs-view]");
  view.setAttribute(
    "data-hs-signals",
    m.with({ title: "saved", revision: 2 }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(view);
  await settle();

  expect(title.value).toBe("typing");
  expect(find("#revision").textContent).toBe("2");
});

it("ignores malformed signal attributes and keeps other bindings working", async () => {
  const good = signals({ count: 0 }, { name: "good-group" });
  const g = good.with({ count: 1 });
  const count = JSON.stringify(g.count.path);
  const { page, find, click } = createPage(
    [
      `<div data-hs-view="memo">`,
      `<p data-hs-signals="{not json"></p>`,
      `<p data-hs-signals='{"a":1}'></p>`,
      `<p data-hs-signals='[[[],1],[["x"]],[[1],2],"bad",[["$pending","/x"],true],[${count},5]]'></p>`,
      `</div>`,
      `<span id="bad-text" data-hs-text='["pow",["lit",1],["lit",2]]'>keep</span>`,
      `<span id="bad-show" data-hs-show="nope"></span>`,
      `<span id="bad-attr" data-hs-attr='[["lit",1]]'></span>`,
      `<input id="bad-bind" data-hs-bind='[${count},"date"]' value="keep">`,
      `<button id="bad-click" data-hs-on-click='[["set",${count}]]'>x</button>`,
      `<button id="mixed-click" data-hs-on-click='[["set",${count},["lit",9]],["nope"]]'>x</button>`,
      `<button id="add" data-hs-on-click='${JSON.stringify([g.count.set(g.count.add(1))])}'>+</button>`,
      `<span id="count" data-hs-text='${JSON.stringify(g.count.node)}'></span>`,
      `<span id="pending" data-hs-text='["sig",["$pending","/x"]]'>-</span>`,
    ].join("")
  );
  const runtime = startSignals({ root: page });

  expect(runtime.read(g.count.path)).toBe(5);
  expect(runtime.read(["$pending", "/x"])).toBeUndefined();
  expect(find("#count").textContent).toBe("5");
  expect(find("#pending").textContent).toBe("");
  expect(find("#bad-text").textContent).toBe("keep");
  expect(find("#bad-show").hasAttribute("hidden")).toBe(false);
  expect(find<HTMLInputElement>("#bad-bind").value).toBe("keep");

  click("#bad-click");
  click("#mixed-click");
  await settle();
  expect(find("#count").textContent).toBe("5");

  click("#add");
  runtime.applySnapshots(find("[data-hs-view]"));
  await settle();
  expect(find("#count").textContent).toBe("5");
  click("#add");
  await settle();
  expect(find("#count").textContent).toBe("6");
});

it("focuses a ref", () => {
  const title = ref({ name: "title-ref" });
  const other = ref({ name: "other-ref" });
  const { page, find, click } = createPage(
    render("input", { id: "other", ...other.attr() }) +
      render("input", { id: "title", ...title.attr() }) +
      render("button", { id: "edit", ...on.click(title.focus()) })
  );
  startSignals({ root: page });

  click("#edit");
  expect(page.activeElement).toBe(find("#title"));
});

it("writes a new uuid from the uuid option or crypto.randomUUID", () => {
  const operation = signals({ id: "" }, { name: "operation-id" });
  const html = render("button", {
    id: "next",
    ...on.click(operation.id.set(uuid())),
  });
  const custom = createPage(html);
  const runtime = startSignals({ root: custom.page, uuid: () => "id-1" });
  custom.click("#next");
  expect(runtime.read(operation.id.path)).toBe("id-1");

  const standard = createPage(html);
  const fallback = startSignals({ root: standard.page });
  standard.click("#next");
  expect(fallback.read(operation.id.path)).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/
  );
});
