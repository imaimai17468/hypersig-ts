// The automatic JSX runtime that `<span {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import * as v from "valibot";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createHypersig,
  createMemoryPubSub,
  customElement,
  event,
  json,
  on,
  ref,
  refs,
  signals,
  timer,
  uuid,
  when,
} from "./index.js";
import type { StmtNode } from "./index.js";
import { morphView } from "./morph.js";
import { sanitizeFragment } from "./sanitize.js";
import type { SendResult } from "./signal-runtime.js";
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
  input("#base").value = "";
  dispatch("#base", "input");
  input("#base").value = "  ";
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
            children: element("p", { id: "inner-snapshot", ...i.init() }),
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
      children: [
        element("p", { id: "snapshot", ...m.init() }),
        element("input", { id: "title", ...m.bindValue(m.title) }),
        element("span", { id: "revision", ...m.bindText(m.revision) }),
        element("span", { id: "echo", ...m.bindText(m.title) }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  const title = input("#title");
  title.focus();
  title.value = "typing";
  dispatch("#title", "input");
  const view = find("[data-hs-view]");
  const snapshot = find("#snapshot");
  snapshot.setAttribute(
    "data-hs-signals",
    m.with({ title: "saved", revision: 2 }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(view);
  await settle();

  expect(title.value).toBe("typing");
  expect(runtime.read(m.title.path)).toBe("typing");
  expect(find("#echo").textContent).toBe("typing");
  expect(find("#revision").textContent).toBe("2");

  title.blur();
  snapshot.setAttribute(
    "data-hs-signals",
    m.with({ title: "published", revision: 3 }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(view);
  await settle();
  expect(runtime.read(m.title.path)).toBe("published");
  expect(title.value).toBe("published");
  expect(find("#echo").textContent).toBe("published");
  expect(find("#revision").textContent).toBe("3");
});

it("restores browser-only bindings that a morph reset to server HTML", async () => {
  const local = signals({ count: 0, open: false }, { name: "local-only" });
  const l = local.with({ count: 1 });
  const { page, find, input, click } = createPage(
    render("div", {
      ...l.init(),
      children: [
        element("button", {
          id: "set",
          ...on.click([l.count.set(5), l.open.set(true)]),
        }),
        element("div", {
          "data-hs-view": "memo",
          children: [
            element("span", { id: "count", ...l.bindText(l.count) }),
            element("p", { id: "panel", ...l.bindShow(l.open) }),
            element("input", { id: "field", ...l.bindValue(l.count) }),
          ],
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });
  click("#set");
  await settle();

  const view = find("[data-hs-view]");
  find("#count").textContent = "1";
  find("#panel").setAttribute("hidden", "");
  input("#field").value = "1";
  view.setAttribute("data-hs-signals", l.init()["data-hs-signals"]);
  runtime.applySnapshots(view);
  await settle();

  expect(runtime.read(l.count.path)).toBe(5);
  expect(find("#count").textContent).toBe("5");
  expect(find("#panel").hasAttribute("hidden")).toBe(false);
  expect(input("#field").value).toBe("5");
});

it("fills an absent path from a default pair but keeps an existing browser value", async () => {
  const editor = signals(
    { base: 0, published: 0, draft: "" },
    { name: "default-pairs" }
  );
  const form = editor.with({ base: 3, published: 3 });
  const view = editor.with({ published: 3 });
  const { find, runtime } = (() => {
    const created = createPage(
      render("div", {
        "data-hs-view": "memo",
        children: element("p", { id: "view-snapshot", ...view.init() }),
      }) +
        render("form", {
          ...form.init(),
          children: element("span", {
            id: "base",
            ...form.bindText(form.base),
          }),
        })
    );
    return { ...created, runtime: startSignals({ root: created.page }) };
  })();

  // The view snapshot comes first, so its default base fills the absent path
  // and the form's owned base replaces it.
  expect(runtime.read(form.base.path)).toBe(3);
  expect(runtime.read(form.draft.path)).toBe("");

  find("#view-snapshot").setAttribute(
    "data-hs-signals",
    editor.with({ published: 4 }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(find("[data-hs-view='memo']"));
  await settle();

  expect(runtime.read(form.published.path)).toBe(4);
  expect(runtime.read(form.base.path)).toBe(3);
  expect(find("#base").textContent).toBe("3");
});

it("reads a bound hidden input whose value changed before the runtime started", () => {
  const editor = signals({ base: 0, operation: "" }, { name: "hidden-form" });
  const e = editor.with({ base: 4, operation: "new" });
  const { page, input } = createPage(
    render("form", {
      ...e.init(),
      children: [
        element("input", {
          id: "base",
          type: "hidden",
          ...e.bindValue(e.base),
        }),
        element("input", {
          id: "operation",
          type: "hidden",
          ...e.bindValue(e.operation),
        }),
      ],
    })
  );
  // Setting `value` on a hidden input also changes its `defaultValue`.
  input("#base").value = "3";
  input("#operation").value = "restored";
  const runtime = startSignals({ root: page });

  expect(runtime.read(e.base.path)).toBe(3);
  expect(runtime.read(e.operation.path)).toBe("restored");
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
      `<p data-hs-signals='[[[],1],[["x"]],[[1],2],"bad",[["$pending","/x"],true],[${count},5],[${count},7,1],[${count},8,0,0]]'></p>`,
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

it("prefers the uuid option over crypto.randomUUID", () => {
  const operation = signals({ id: "" }, { name: "preferred-id" });
  const { page, click } = createPage(
    render("button", { id: "next", ...on.click(operation.id.set(uuid())) })
  );
  const randomUUID = vi.spyOn(crypto, "randomUUID");
  try {
    const runtime = startSignals({ root: page, uuid: () => "id-from-option" });
    click("#next");
    expect(runtime.read(operation.id.path)).toBe("id-from-option");
    expect(randomUUID).not.toHaveBeenCalled();
  } finally {
    randomUUID.mockRestore();
  }
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

const hypersig = createHypersig({
  origin: "http://localhost",
  pubsub: createMemoryPubSub(),
  authenticate: () => ({ sessionId: "s" }),
});
const toggleTodo = hypersig.action("toggle-todo", {
  input: v.object({ key: v.string(), completed: v.boolean() }),
  output: v.object({ revision: v.number() }),
  authorize: () => true,
  execute: () => ({ revision: 1 }),
});
const bump = hypersig.action("bump", {
  input: v.object({ count: v.number() }),
  output: v.number(),
  authorize: () => true,
  execute: (input) => input.count,
});
const saveMemo = hypersig.action("save-memo", {
  input: v.object({ title: v.string() }),
  output: v.object({ revision: v.number() }),
  authorize: () => true,
  execute: () => ({ revision: 1 }),
});

interface SentRequest {
  control: HTMLElement;
  url: string;
  body: string | FormData;
  respond(result: SendResult): void;
  fail(): void;
}

/** A `send` whose requests stay in flight until a test settles them. */
function createSend() {
  const requests: SentRequest[] = [];
  const send = (control: HTMLElement, url: string, body: string | FormData) =>
    new Promise<SendResult>((respond, reject) => {
      requests.push({
        control,
        url,
        body,
        respond,
        fail: () => reject(new Error("offline")),
      });
    });
  const request = (index: number) => {
    const sent = requests[index];
    if (!sent) throw new Error(`No request ${index}`);
    return sent;
  };
  return { requests, request, send };
}

/** A counter in a Live View whose button writes the bumped count before calling. */
function createBumpPage() {
  const counter = signals(
    { count: 0, revision: 0, failed: false },
    { name: "bump-counter" }
  );
  const c = counter.with({ count: 1, revision: 1 });
  const created = createPage(
    render("div", {
      "data-hs-view": "counter",
      children: [
        element("p", { id: "snapshot", ...c.init() }),
        element("span", { id: "count", ...c.bindText(c.count) }),
        element("button", {
          id: "bump",
          ...on.click([
            c.failed.set(false),
            c.count.set(c.count.add(1)),
            bump.call({ count: c.count }, { onError: c.failed.set(true) }),
          ]),
        }),
      ],
    })
  );
  const sender = createSend();
  const runtime = startSignals({ root: created.page, send: sender.send });
  const sendSnapshot = (count: number, revision: number) => {
    created
      .find("#snapshot")
      .setAttribute(
        "data-hs-signals",
        c.with({ count, revision }).init()["data-hs-signals"]
      );
    runtime.applySnapshots(created.find("[data-hs-view]"));
  };
  return { ...created, ...sender, runtime, c, sendSnapshot };
}

it("shows a write before a call, sends its value and keeps it on success", async () => {
  const todo = signals(
    { completed: false, revision: 0 },
    { name: "early-todo" }
  );
  const t = todo.with({});
  const { page, find, click } = createPage(
    render("div", {
      ...t.init(),
      children: [
        element("span", { id: "completed", ...t.bindText(t.completed) }),
        element("span", { id: "revision", ...t.bindText(t.revision) }),
        element("button", {
          id: "toggle",
          ...on.click([
            t.completed.toggle(),
            toggleTodo.call(
              { key: "a", completed: t.completed },
              { onSuccess: (output) => t.revision.set(output.get("revision")) }
            ),
          ]),
        }),
      ],
    })
  );
  const { requests, request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  click("#toggle");
  await settle();
  expect(find("#completed").textContent).toBe("true");
  expect(requests).toHaveLength(1);
  expect(request(0).url).toBe(toggleTodo.url);
  expect(request(0).control).toBe(find("#toggle"));
  expect(request(0).body).toBe(JSON.stringify({ key: "a", completed: true }));

  request(0).respond({ ok: true, data: { revision: 7 } });
  await settle();
  expect(runtime.read(t.completed.path)).toBe(true);
  expect(find("#revision").textContent).toBe("7");
});

it("keeps writes made before a failed call", async () => {
  const { find, click, request, runtime, c } = createBumpPage();

  click("#bump");
  expect(runtime.read(c.count.path)).toBe(2);
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(c.count.path)).toBe(2);
  expect(runtime.read(c.failed.path)).toBe(true);
  expect(find("#count").textContent).toBe("2");
});

it("keeps writes and runs onError when the request rejects", async () => {
  const { click, request, runtime, c } = createBumpPage();

  click("#bump");
  request(0).fail();
  await settle();
  expect(runtime.read(c.count.path)).toBe(2);
  expect(runtime.read(c.failed.path)).toBe(true);
  expect(runtime.read(["$pending", bump.url])).toBe(false);
});

it("applies a snapshot that arrives while a call is in flight", async () => {
  const { find, click, request, runtime, c, sendSnapshot } = createBumpPage();

  click("#bump");
  sendSnapshot(5, 2);
  await settle();
  expect(runtime.read(c.count.path)).toBe(5);
  expect(find("#count").textContent).toBe("5");

  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(c.count.path)).toBe(5);
});

it("runs onError statements to undo a write by hand", async () => {
  const todo = signals({ completed: false }, { name: "undo-todo" });
  // The value the page was rendered with, as a server render reads it.
  const rendered = { completed: false };
  const t = todo.with(rendered);
  const { page, find, click } = createPage(
    render("div", {
      "data-hs-view": "todo",
      children: [
        element("p", { id: "snapshot", ...t.init() }),
        element("span", { id: "completed", ...t.bindText(t.completed) }),
        element("button", {
          id: "toggle",
          ...on.click([
            t.completed.toggle(),
            toggleTodo.call(
              { key: "a", completed: t.completed },
              { onError: [t.completed.set(rendered.completed)] }
            ),
          ]),
        }),
      ],
    })
  );
  const { request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  click("#toggle");
  expect(runtime.read(t.completed.path)).toBe(true);
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(t.completed.path)).toBe(false);
  expect(find("#completed").textContent).toBe("false");

  click("#toggle");
  expect(runtime.read(t.completed.path)).toBe(true);
  // A Live View update from before the commit arrives during the request.
  find("#snapshot").setAttribute(
    "data-hs-signals",
    todo.with({ completed: false }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(find("[data-hs-view]"));
  expect(runtime.read(t.completed.path)).toBe(false);
  request(1).respond({ ok: false });
  await settle();
  expect(runtime.read(t.completed.path)).toBe(false);
  expect(find("#completed").textContent).toBe("false");
});

const saveFavorite = hypersig.action("save-favorite", {
  input: v.object({ favorite: v.boolean() }),
  output: v.null(),
  authorize: () => true,
  execute: () => null,
});

/**
 * A Live View with a committed `favorite` and three buttons that show their
 * value as pending: one toggles it, `#on` sets true and `#off` sets false.
 */
function createFavoritePage() {
  const favorite = signals(
    { favorite: false, seen: "", other: 0 },
    { name: "pending-favorite" }
  );
  const f = favorite.with({ favorite: false });
  const pendingButton = (
    id: string,
    next: Parameters<typeof f.favorite.set>[0]
  ) =>
    element("button", {
      id,
      ...on.click(
        saveFavorite.call(
          { favorite: f.favorite },
          {
            pending: f.favorite.set(next),
            onError: f.seen.set(f.favorite.choose("on", "off")),
          }
        )
      ),
    });
  const created = createPage(
    render("div", {
      "data-hs-view": "favorite",
      children: [
        element("p", { id: "snapshot", ...f.init() }),
        element("span", { id: "shown", ...f.bindText(f.favorite) }),
        pendingButton("toggle", f.favorite.not()),
        pendingButton("on", true),
        pendingButton("off", false),
      ],
    })
  );
  const sender = createSend();
  const runtime = startSignals({ root: created.page, send: sender.send });
  const commit = (value: boolean) => {
    created
      .find("#snapshot")
      .setAttribute(
        "data-hs-signals",
        favorite.with({ favorite: value }).init()["data-hs-signals"]
      );
    runtime.applySnapshots(created.find("[data-hs-view]"));
  };
  return { ...created, ...sender, runtime, f, favorite, commit };
}

it("shows a pending value at once and sends the value it wrote", async () => {
  const { find, click, requests, request, runtime, f, commit } =
    createFavoritePage();

  click("#toggle");
  expect(runtime.read(f.favorite.path)).toBe(true);
  expect(find("#toggle").hasAttribute("data-hs-pending")).toBe(true);
  expect(requests).toHaveLength(1);
  expect(request(0).body).toBe(JSON.stringify({ favorite: true }));
  await settle();
  expect(find("#shown").textContent).toBe("true");

  request(0).respond({ ok: true, data: null });
  await settle();
  expect(find("#toggle").hasAttribute("data-hs-pending")).toBe(false);
  expect(runtime.read(f.favorite.path)).toBe(true);

  // Another tab's commit arrives after this one.
  commit(false);
  await settle();
  expect(find("#shown").textContent).toBe("false");
});

it("replaces a pending value with a committed one that arrives in flight", async () => {
  const { click, request, runtime, f, commit } = createFavoritePage();

  click("#on");
  commit(false);
  expect(runtime.read(f.favorite.path)).toBe(false);
  request(0).respond({ ok: true, data: null });
  await settle();
  expect(runtime.read(f.favorite.path)).toBe(false);
});

it("reverts a failed pending value to the latest committed value before onError", async () => {
  const { find, click, request, runtime, f, commit } = createFavoritePage();

  click("#on");
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(f.favorite.path)).toBe(false);
  expect(runtime.read(f.seen.path)).toBe("off");
  expect(find("#shown").textContent).toBe("false");

  click("#off");
  // Another tab commits true while this request is in flight.
  commit(true);
  request(1).fail();
  await settle();
  expect(runtime.read(f.favorite.path)).toBe(true);
  expect(runtime.read(f.seen.path)).toBe("on");
});

it("leaves a pending value a later request wrote when the earlier one fails", async () => {
  const { click, request, runtime, f } = createFavoritePage();

  click("#off");
  click("#on");
  expect(runtime.read(f.favorite.path)).toBe(true);
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(f.favorite.path)).toBe(true);

  request(1).respond({ ok: false });
  await settle();
  expect(runtime.read(f.favorite.path)).toBe(false);
});

it("throws and sends nothing when a pending path has no committed value", () => {
  const favorite = signals(
    { favorite: false, seen: "", other: 0 },
    { name: "uncommitted-favorite" }
  );
  const f = favorite.with({ favorite: false });
  const { page, click } = createPage(
    render("div", {
      ...f.init(),
      children: element("button", {
        id: "uncommitted",
        ...on.click([
          saveFavorite.call(
            { favorite: true },
            { pending: [f.favorite.set(true), f.other.set(1)] }
          ),
          f.seen.set("after"),
        ]),
      }),
    })
  );
  const { requests, send } = createSend();
  const runtime = startSignals({ root: page, send });
  const errors: unknown[] = [];
  const catchError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  const view = page.defaultView;
  if (!view) throw new Error("The page has no window");
  // The click reports the exception to the frame's window.
  view.addEventListener("error", catchError);
  try {
    click("#uncommitted");
  } finally {
    view.removeEventListener("error", catchError);
  }
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain(JSON.stringify(f.other.path));
  expect(requests).toHaveLength(0);
  expect(runtime.read(f.favorite.path)).toBe(false);
  expect(runtime.read(f.seen.path)).toBe("");
});

it("skips the whole handler while its control is pending", async () => {
  const { click, requests, request, runtime, c } = createBumpPage();

  click("#bump");
  click("#bump");
  expect(runtime.read(c.count.path)).toBe(2);
  expect(requests).toHaveLength(1);

  request(0).respond({ ok: true, data: 2 });
  await settle();
  click("#bump");
  expect(runtime.read(c.count.path)).toBe(3);
  expect(requests).toHaveLength(2);
  expect(request(1).body).toBe(JSON.stringify({ count: 3 }));
});

it("tracks pending state per action URL", async () => {
  const memo = signals({ title: "" }, { name: "pending-memo" });
  const m = memo.with({});
  const { page, find, click } = createPage(
    render("form", {
      id: "save",
      ...saveMemo.form(),
      children: [
        element("input", {
          id: "title",
          ...m.bindAttr({ disabled: saveMemo.pending() }),
        }),
        element("button", {
          id: "save-again",
          type: "button",
          ...on.click(saveMemo.call({ title: m.title })),
        }),
      ],
    }) +
      render("button", {
        id: "bump",
        ...bump.bind({ count: 1 }),
        ...m.bindAttr({ "aria-busy": bump.pending() }),
      })
  );
  const { requests, request, send } = createSend();
  const runtime = startSignals({ root: page, send });
  const saving = ["$pending", saveMemo.url];
  const bumping = ["$pending", bump.url];

  const form = find<HTMLFormElement>("#save");
  void runtime.send(form, saveMemo.url, new FormData(form));
  await settle();
  expect(runtime.read(saving)).toBe(true);
  expect(runtime.read(bumping)).toBeUndefined();
  expect(find("#title").hasAttribute("disabled")).toBe(true);

  expect(await runtime.send(form, saveMemo.url, new FormData(form))).toEqual({
    ok: false,
  });
  expect(requests).toHaveLength(1);

  const button = find("#bump");
  void runtime.send(button, bump.url, "{}");
  await settle();
  expect(runtime.read(bumping)).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");

  click("#save-again");
  expect(requests).toHaveLength(3);
  request(0).respond({ ok: true, data: { revision: 2 } });
  await settle();
  expect(runtime.read(saving)).toBe(true);
  request(2).respond({ ok: false });
  await settle();
  expect(runtime.read(saving)).toBe(false);
  expect(find("#title").hasAttribute("disabled")).toBe(false);
  expect(runtime.read(bumping)).toBe(true);

  request(1).respond({ ok: true, data: 1 });
  await settle();
  expect(runtime.read(bumping)).toBe(false);
  expect(button.getAttribute("aria-busy")).toBe("false");
});

it("clears the restored flag when the form's action succeeds", async () => {
  const memo = signals({ title: "" }, { name: "restored-memo" });
  const m = memo.with({});
  const { page, find } = createPage(
    render("form", {
      id: "save",
      ...saveMemo.form({ draft: true }),
      children: element("p", {
        id: "notice",
        ...m.bindShow(saveMemo.draftRestored()),
      }),
    }) + render("p", { id: "other", ...m.bindShow(bump.draftRestored()) })
  );
  const { request, send } = createSend();
  const runtime = startSignals({
    root: page,
    send,
    restoredActions: [saveMemo.url],
  });
  expect(find("#notice").hasAttribute("hidden")).toBe(false);
  expect(find("#other").hasAttribute("hidden")).toBe(true);

  const form = find<HTMLFormElement>("#save");
  void runtime.send(form, saveMemo.url, new FormData(form));
  request(0).respond({ ok: false });
  await settle();
  expect(find("#notice").hasAttribute("hidden")).toBe(false);

  void runtime.send(form, saveMemo.url, new FormData(form));
  request(1).respond({ ok: true, data: { revision: 2 } });
  await settle();
  expect(runtime.read(["$restored", saveMemo.url])).toBe(false);
  expect(find("#notice").hasAttribute("hidden")).toBe(true);
});

it("runs form success statements with the action output", async () => {
  const editor = signals(
    { base: 0, failed: false },
    { name: "form-result-editor" }
  );
  const e = editor.with({});
  const { page, find } = createPage(
    render("form", {
      id: "save",
      ...e.init(),
      ...saveMemo.form({
        onSuccess: (output) => [
          e.base.set(output.get("revision")),
          e.failed.set(false),
        ],
        onError: e.failed.set(true),
      }),
    })
  );
  const { request, send } = createSend();
  const runtime = startSignals({ root: page, send });
  const form = find<HTMLFormElement>("#save");

  const failed = runtime.send(form, saveMemo.url, new FormData(form));
  request(0).respond({ ok: false });
  expect(await failed).toEqual({ ok: false });
  expect(runtime.read(e.failed.path)).toBe(true);

  const saved = runtime.send(form, saveMemo.url, new FormData(form));
  request(1).respond({ ok: true, data: { revision: 3 } });
  expect(await saved).toEqual({ ok: true, data: { revision: 3 } });
  expect(runtime.read(e.base.path)).toBe(3);
  expect(runtime.read(e.failed.path)).toBe(false);
});

it("shows the store value in a focused checkbox that a morph reset", async () => {
  const task = signals({ done: false, note: "" }, { name: "focused-check" });
  const t = task.with({});
  const { page, find, input, click } = createPage(
    render("div", {
      "data-hs-view": "task",
      children: [
        element("p", { id: "snapshot", ...t.init() }),
        element("input", {
          id: "done",
          type: "checkbox",
          ...t.bindValue(t.done),
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  const done = input("#done");
  done.focus();
  click("#done");
  expect(runtime.read(t.done.path)).toBe(true);
  // A morph syncs `checked` from the server HTML even on a focused checkbox.
  done.checked = false;
  find("#snapshot").setAttribute(
    "data-hs-signals",
    t.with({ done: true }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(find("[data-hs-view]"));
  await settle();
  expect(page.activeElement).toBe(done);
  expect(done.checked).toBe(true);

  find("#snapshot").setAttribute(
    "data-hs-signals",
    t.with({ done: false }).init()["data-hs-signals"]
  );
  runtime.applySnapshots(find("[data-hs-view]"));
  await settle();
  expect(runtime.read(t.done.path)).toBe(false);
  expect(done.checked).toBe(false);
});

it("reads bound fields again after their form resets", async () => {
  const composer = signals(
    { title: "", count: 0, urgent: false },
    { name: "reset-composer" }
  );
  const c = composer.with({});
  const { page, find, input, dispatch } = createPage(
    render("form", {
      id: "form",
      ...c.init(),
      children: [
        element("input", { id: "title", ...c.bindValue(c.title) }),
        element("input", {
          id: "count",
          type: "number",
          ...c.bindValue(c.count),
        }),
        element("input", {
          id: "urgent",
          type: "checkbox",
          ...c.bindValue(c.urgent),
        }),
        element("span", { id: "echo", ...c.bindText(c.title) }),
      ],
    }) + render("input", { id: "outside", ...c.bindValue(c.title) })
  );
  const runtime = startSignals({ root: page });

  input("#title").value = "typed";
  dispatch("#title", "input");
  input("#count").value = "3";
  dispatch("#count", "input");
  find("#urgent").click();
  await settle();
  expect(find("#echo").textContent).toBe("typed");

  find<HTMLFormElement>("#form").reset();
  await settle();
  expect(runtime.read(c.title.path)).toBe("");
  expect(runtime.read(c.urgent.path)).toBe(false);
  expect(runtime.read(c.count.path)).toBe(0);
  expect(find("#echo").textContent).toBe("");
  expect(input("#outside").value).toBe("");
});

it("does not write bound text into script or style elements", async () => {
  const code = signals({ text: "alert(1)" }, { name: "script-text" });
  const c = code.with({});
  const { page, find } = createPage(
    render("div", { ...c.init() }) +
      `<script id="script" data-hs-text='${JSON.stringify(c.text.node)}'></script>` +
      `<style id="style" data-hs-text='${JSON.stringify(c.text.node)}'></style>` +
      render("span", { id: "span", ...c.bindText(c.text) })
  );
  startSignals({ root: page });
  await settle();

  expect(find("#script").textContent).toBe("");
  expect(find("#style").textContent).toBe("");
  expect(find("#span").textContent).toBe("alert(1)");
});

it("does not write bound text into SVG script or style elements", async () => {
  const code = signals({ text: "alert(1)" }, { name: "svg-script-text" });
  const c = code.with({});
  const { page, find } = createPage(
    render("div", { ...c.init() }) +
      `<svg><script id="script" data-hs-text='${JSON.stringify(c.text.node)}'></script>` +
      `<style id="style" data-hs-text='${JSON.stringify(c.text.node)}'></style></svg>`
  );
  startSignals({ root: page });
  await settle();

  expect(find("#script").namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(find("#script").textContent).toBe("");
  expect(find("#style").textContent).toBe("");
});

it("binds the checked property so a clicked checkbox follows the signal", async () => {
  const filter = signals({ all: true }, { name: "checked-attr" });
  const f = filter.with({});
  const { page, find, input, click } = createPage(
    render("div", { ...f.init() }) +
      render("input", {
        id: "all",
        type: "checkbox",
        ...f.bindAttr({ checked: f.all }),
      }) +
      render("button", { id: "off", ...on.click(f.all.set(false)) }) +
      render("button", { id: "on", ...on.click(f.all.set(true)) })
  );
  startSignals({ root: page });

  const all = input("#all");
  expect(all.checked).toBe(true);
  click("#all");
  expect(all.checked).toBe(false);
  click("#on");
  await settle();
  expect(all.checked).toBe(true);
  expect(all.hasAttribute("checked")).toBe(true);
  click("#off");
  await settle();
  expect(all.checked).toBe(false);
  expect(find("#all").hasAttribute("checked")).toBe(false);
});

it("ignores a pathologically nested binding and keeps rendering the others", async () => {
  const depth = 100_000;
  const nested = `${'["not",'.repeat(depth)}["lit",1]${"]".repeat(depth)}`;
  const statement = `[["set",["deep","x"],${nested}]]`;
  const label = signals({ text: "ok" }, { name: "deep-neighbor" });
  const l = label.with({});
  const { page, find, click } = createPage(
    render("div", { ...l.init() }) +
      `<span id="deep" data-hs-text='${nested}'>keep</span>` +
      `<button id="deep-click" data-hs-on-click='${statement}'>x</button>` +
      render("span", { id: "label", ...l.bindText(l.text) }) +
      render("button", { id: "rename", ...on.click(l.text.set("renamed")) })
  );
  const runtime = startSignals({ root: page });

  expect(find("#deep").textContent).toBe("keep");
  expect(find("#label").textContent).toBe("ok");
  click("#deep-click");
  expect(runtime.read(["deep", "x"])).toBeUndefined();
  click("#rename");
  await settle();
  expect(find("#label").textContent).toBe("renamed");
});

const addTodo = hypersig.action("add-todo", {
  input: v.object({ todoKey: v.string(), todoTitle: v.string() }),
  output: v.null(),
  authorize: () => true,
  execute: () => null,
});
const todoEditor = signals(
  { newKey: "", newTitle: "" },
  { name: "runtime-todo-editor" }
);

/** A form whose submit statements write the key its hidden input sends. */
function createSubmitPage() {
  const e = todoEditor.with({});
  const created = createPage(
    render("form", {
      id: "add",
      ...e.init(),
      ...addTodo.form({ onSubmit: [e.newKey.set(uuid())] }),
      children: [
        element("input", {
          id: "key",
          type: "hidden",
          name: addTodo.field("todoKey"),
          ...e.bindValue(e.newKey),
        }),
        element("input", {
          id: "title",
          name: addTodo.field("todoTitle"),
          ...e.bindValue(e.newTitle),
        }),
        element("button", { id: "submit", name: "via", value: "button" }),
      ],
    })
  );
  const sender = createSend();
  let next = 0;
  const runtime = startSignals({
    root: created.page,
    send: sender.send,
    uuid: () => `f${++next}`,
  });
  const form = created.find<HTMLFormElement>("#add");
  return { ...created, ...sender, runtime, e, form };
}

it("runs submit statements and sends the bound values they wrote", async () => {
  const { find, input, dispatch, form, request, runtime, e } =
    createSubmitPage();

  input("#title").value = "Walk";
  dispatch("#title", "input");
  const sent = runtime.sendForm(form, addTodo.url, find("#submit"));
  const body = request(0).body;
  if (typeof body === "string") throw new Error("Expected form data");
  expect(body.get("todoKey")).toBe("f1");
  expect(body.get("todoTitle")).toBe("Walk");
  expect(body.get("via")).toBe("button");
  expect(request(0).control).toBe(form);
  expect(runtime.read(["$pending", addTodo.url])).toBe(true);

  request(0).respond({ ok: false });
  expect(await sent).toEqual({ ok: false });
  expect(runtime.read(e.newKey.path)).toBe("f1");
});

it("refuses to send a form while it is pending, without running its submit statements", async () => {
  const { form, request, requests, runtime, e } = createSubmitPage();

  void runtime.sendForm(form, addTodo.url, null);
  expect(await runtime.sendForm(form, addTodo.url, null)).toEqual({
    ok: false,
  });
  expect(requests).toHaveLength(1);
  expect(runtime.read(e.newKey.path)).toBe("f1");

  request(0).respond({ ok: true, data: null });
  await settle();
  void runtime.sendForm(form, addTodo.url, null);
  expect(requests).toHaveLength(2);
  expect(runtime.read(e.newKey.path)).toBe("f2");
});

it("sends a call input field named __proto__ as an ordinary key", () => {
  const rename = hypersig.action("rename-proto", {
    input: v.object({ ["__proto__"]: v.string() }),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  const { page, click } = createPage(
    render("button", {
      id: "rename",
      ...on.click(rename.call({ ["__proto__"]: "x" })),
    })
  );
  const { requests, request, send } = createSend();
  startSignals({ root: page, send });

  click("#rename");
  expect(requests).toHaveLength(1);
  expect(request(0).body).toBe('{"__proto__":"x"}');
});

it("keeps data-hs-pending on a control until its last send ends", async () => {
  const { page, find, click } = createPage(
    render("button", {
      id: "twice",
      ...on.click([bump.call({ count: 1 }), bump.call({ count: 2 })]),
    }) +
      render("form", {
        id: "submit-call",
        ...addTodo.form({ onSubmit: [bump.call({ count: 3 })] }),
        children: element("input", {
          name: addTodo.field("todoTitle"),
          value: "x",
        }),
      })
  );
  const sender = createSend();
  const runtime = startSignals({ root: page, send: sender.send });
  const button = find("#twice");
  const form = find<HTMLFormElement>("#submit-call");

  click("#twice");
  expect(sender.requests).toHaveLength(2);
  expect(button.hasAttribute("data-hs-pending")).toBe(true);
  expect(runtime.isSending(button)).toBe(true);
  sender.request(0).respond({ ok: true, data: 1 });
  await settle();
  expect(button.hasAttribute("data-hs-pending")).toBe(true);
  expect(runtime.isSending(button)).toBe(true);
  sender.request(1).respond({ ok: false });
  await settle();
  expect(button.hasAttribute("data-hs-pending")).toBe(false);
  expect(runtime.isSending(button)).toBe(false);

  const sent = runtime.sendForm(form, addTodo.url, null);
  expect(sender.requests).toHaveLength(4);
  expect(form.hasAttribute("data-hs-pending")).toBe(true);
  sender.request(2).respond({ ok: true, data: 3 });
  await settle();
  expect(form.hasAttribute("data-hs-pending")).toBe(true);
  sender.request(3).respond({ ok: true, data: null });
  await sent;
  expect(form.hasAttribute("data-hs-pending")).toBe(false);
});

const rating = customElement("star-rating", {
  attributes: { value: "number", open: "boolean" },
  events: { rate: event<number>() },
  ownsChildren: true,
});

/** Dispatches a `CustomEvent` that does not bubble, created in the page's frame. */
function dispatchCustom(target: Element, type: string, detail: unknown) {
  const view = target.ownerDocument.defaultView;
  if (!view) throw new Error("The element has no window");
  target.dispatchEvent(new view.CustomEvent(type, { detail, bubbles: false }));
}

it("binds declared attributes on custom elements only", async () => {
  const stars = signals(
    { count: 3, open: false },
    { name: "custom-attrs" }
  ).with({});
  const handBound = JSON.stringify({
    value: ["sig", stars.count.path],
    onrate: ["lit", "alert(1)"],
    style: ["lit", "color: red"],
  });
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: [
        element("star-rating", {
          id: "rating",
          ...stars.bindElement(rating, {
            value: stars.count,
            open: stars.open,
          }),
        }),
        element("star-rating", {
          id: "hand",
          "data-hs-element-attr": handBound,
        }),
        element("div", { id: "plain", "data-hs-element-attr": handBound }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  runtime.write(stars.count.path, 5);
  runtime.write(stars.open.path, true);
  await settle();
  expect(find("#rating").getAttribute("value")).toBe("5");
  expect(find("#rating").getAttribute("open")).toBe("");
  expect(find("#hand").getAttribute("value")).toBe("5");
  expect(find("#hand").hasAttribute("onrate")).toBe(false);
  expect(find("#hand").hasAttribute("style")).toBe(false);
  expect(find("#plain").hasAttribute("value")).toBe(false);

  runtime.write(stars.open.path, false);
  await settle();
  expect(find("#rating").hasAttribute("open")).toBe(false);
});

it("runs statements for a non-bubbling custom event with its detail", async () => {
  const stars = signals({ count: 0 }, { name: "custom-detail" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        ...rating.on("rate", (detail) => stars.count.set(detail)),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  dispatchCustom(find("#rating"), "rate", 4);
  expect(runtime.read(stars.count.path)).toBe(4);
});

it("uses null for a detail that is not JSON", () => {
  const stars = signals(
    { count: 2 as number | null },
    { name: "custom-null" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        ...rating.on("rate", (detail) => stars.count.set(detail)),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  dispatchCustom(find("#rating"), "rate", () => 1);
  expect(runtime.read(stars.count.path)).toBe(null);
});

it("attaches listeners to custom elements added later", async () => {
  const stars = signals(
    { count: 0, renders: 0 },
    { name: "custom-later" }
  ).with({});
  const { page, find } = createPage(render("div", { ...stars.init() }));
  const runtime = startSignals({ root: page });

  page.body.insertAdjacentHTML(
    "beforeend",
    render("star-rating", {
      id: "rating",
      ...rating.on("rate", (detail) =>
        stars.count.set(stars.count.add(detail))
      ),
    })
  );
  runtime.write(stars.renders.path, 1);
  await settle();
  runtime.write(stars.renders.path, 2);
  await settle();

  dispatchCustom(find("#rating"), "rate", 2);
  expect(runtime.read(stars.count.path)).toBe(2);
});

it("ignores malformed custom event entries and runs the valid ones", () => {
  const stars = signals({ count: 0 }, { name: "custom-malformed" }).with({});
  const set = [["set", stars.count.path, ["detail"]]];
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        "data-hs-on-custom": JSON.stringify([
          ["Rate", set],
          "rate",
          ["rate", [["set", "not-a-path", ["detail"]]]],
          ["rate", set],
        ]),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  dispatchCustom(find("#rating"), "Rate", 7);
  expect(runtime.read(stars.count.path)).toBe(0);
  dispatchCustom(find("#rating"), "rate", 3);
  expect(runtime.read(stars.count.path)).toBe(3);
});

it("runs the statements of the current attribute after it changes", async () => {
  const stars = signals(
    { count: 0, other: 0 },
    { name: "custom-changed" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        ...rating.on("rate", (detail) => stars.count.set(detail)),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  find("#rating").setAttribute(
    "data-hs-on-custom",
    rating.on("rate", (detail) => stars.other.set(detail))["data-hs-on-custom"]
  );
  runtime.write(stars.count.path, 0);
  await settle();
  dispatchCustom(find("#rating"), "rate", 6);
  expect(runtime.read(stars.count.path)).toBe(0);
  expect(runtime.read(stars.other.path)).toBe(6);
});

it("does not run custom event statements on an ordinary element", () => {
  const stars = signals({ count: 0 }, { name: "custom-plain" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("div", {
        id: "plain",
        ...rating.on("rate", (detail) => stars.count.set(detail)),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  dispatchCustom(find("#plain"), "rate", 4);
  expect(runtime.read(stars.count.path)).toBe(0);
});

it("keeps children only for matching owned elements", () => {
  const { page, find } = createPage(`
    <star-rating id="a" data-hs-owns-children></star-rating>
    <star-rating id="a2" data-hs-owns-children></star-rating>
    <star-rating data-hs-owns-children class="anon"></star-rating>
    <star-rating id="a" class="unowned"></star-rating>
    <other-rating id="a" data-hs-owns-children></other-rating>
  `);
  const runtime = startSignals({ root: page });
  const owned = find("#a");
  const copy = (html: string) => {
    const template = page.createElement("template");
    template.innerHTML = html;
    const next = template.content.firstElementChild;
    if (!next) throw new Error("Missing element");
    return next;
  };

  expect(
    runtime.keepsChildren(
      owned,
      copy('<star-rating id="a" value="2" data-hs-owns-children></star-rating>')
    )
  ).toBe(true);
  expect(
    runtime.keepsChildren(
      find(".anon"),
      copy("<star-rating data-hs-owns-children></star-rating>")
    )
  ).toBe(true);
  expect(runtime.keepsChildren(owned, find("#a2"))).toBe(false);
  expect(runtime.keepsChildren(owned, find(".anon"))).toBe(false);
  expect(runtime.keepsChildren(owned, find(".unowned"))).toBe(false);
  expect(runtime.keepsChildren(find(".unowned"), owned)).toBe(false);
  expect(runtime.keepsChildren(owned, find("other-rating"))).toBe(false);
});

it("lists the bindElement attributes the runtime renders", () => {
  const bindings = JSON.stringify({
    value: ["lit", 3],
    onclick: ["lit", "x"],
    style: ["lit", "x"],
    "data-hs-view": ["lit", "x"],
    max: "not an expression",
  });
  const { page, find } = createPage(`
    <star-rating data-hs-element-attr='${bindings}'></star-rating>
    <div data-hs-element-attr='${bindings}'></div>
    <star-rating class="unbound"></star-rating>
  `);
  const runtime = startSignals({ root: page });

  expect([...runtime.boundElementAttributes(find("star-rating"))]).toEqual([
    "value",
  ]);
  expect(runtime.boundElementAttributes(find("div")).size).toBe(0);
  expect(runtime.boundElementAttributes(find(".unbound")).size).toBe(0);
});

it("renders bindAttr by name and bindElement by value type on one custom element", async () => {
  const stars = signals(
    { pressed: true, open: true },
    { name: "custom-both" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        ...stars.bindAttr({ "aria-pressed": stars.pressed }),
        ...stars.bindElement(rating, { open: stars.open }),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  runtime.write(stars.pressed.path, false);
  runtime.write(stars.open.path, false);
  await settle();
  expect(find("#rating").getAttribute("aria-pressed")).toBe("false");
  expect(find("#rating").hasAttribute("open")).toBe(false);
});

it("applies the name list to data-hs-attr on a custom element", async () => {
  const stars = signals({ count: 3 }, { name: "custom-name-list" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...stars.init(),
      children: element("star-rating", {
        id: "rating",
        "data-hs-attr": JSON.stringify({
          value: ["sig", stars.count.path],
          "data-count": ["sig", stars.count.path],
        }),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  runtime.write(stars.count.path, 5);
  await settle();
  expect(find("#rating").hasAttribute("value")).toBe(false);
  expect(find("#rating").getAttribute("data-count")).toBe("5");
});

it("runs result statements of a call from a custom event with its detail", async () => {
  const e = signals({ saved: 0 }, { name: "custom-call-detail" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...e.init(),
      children: element("star-rating", {
        id: "rating",
        ...rating.on("rate", (detail) =>
          bump.call(
            { count: detail },
            {
              onSuccess: () => e.saved.set(detail),
              onError: e.saved.set(detail.mul(-1)),
            }
          )
        ),
      }),
    })
  );
  const { request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  dispatchCustom(find("#rating"), "rate", 4);
  expect(request(0).body).toBe(JSON.stringify({ count: 4 }));
  request(0).respond({ ok: true, data: 4 });
  await settle();
  expect(runtime.read(e.saved.path)).toBe(4);

  dispatchCustom(find("#rating"), "rate", 2);
  request(1).respond({ ok: false });
  await settle();
  expect(runtime.read(e.saved.path)).toBe(-2);
});

it("does not rewrite bound attributes or text whose value is unchanged", async () => {
  const stars = signals(
    { count: 3, open: true, pressed: true, other: 0 },
    { name: "custom-unchanged" }
  ).with({});
  const { page } = createPage(
    render("div", {
      ...stars.init(),
      children: [
        element("star-rating", {
          id: "rating",
          ...stars.bindAttr({
            "aria-pressed": stars.pressed,
            "data-count": stars.count,
          }),
          ...stars.bindElement(rating, {
            value: stars.count,
            open: stars.open,
          }),
        }),
        element("span", { id: "text", ...stars.bindText(stars.count) }),
      ],
    })
  );
  const runtime = startSignals({ root: page });
  await settle();
  const view = page.defaultView;
  if (!view) throw new Error("The frame has no window");
  const records: MutationRecord[] = [];
  const observer = new view.MutationObserver((found) => records.push(...found));
  const takeRecords = () => records.splice(0);
  observer.observe(page.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  runtime.write(stars.other.path, 1);
  await settle();
  expect(takeRecords()).toEqual([]);

  runtime.write(stars.count.path, 4);
  await settle();
  const changed = takeRecords()
    .filter((record) => record.type === "attributes")
    .map((record) => record.attributeName);
  expect(changed.sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
    "data-count",
    "value",
  ]);
  observer.disconnect();
});

it("ignores hypersig attributes inside the children of an owned element", async () => {
  const s = signals(
    { count: 1, typed: "", other: 0 },
    { name: "owned-inside" }
  ).with({});
  const field = ref({ name: "owned-field" });
  const inner = signals({ count: 0 }, { name: "owned-snapshot" }).with({
    count: 9,
  });
  const { page, find, click, dispatch } = createPage(
    render("div", {
      ...s.init(),
      children: [
        element("star-rating", {
          id: "rating",
          "data-hs-owns-children": "",
          ...s.bindElement(rating, { value: s.count }),
          ...rating.on("rate", (detail) => s.count.set(detail)),
          children: [
            element("button", {
              id: "inner-click",
              ...on.click(s.count.set(100)),
            }),
            element("span", { id: "inner-text", "data-hs-text": "x" }),
            element("p", { id: "inner-snapshot", ...inner.init() }),
            element("input", {
              id: "inner-input",
              ...s.bindValue(s.typed),
              ...field.attr(),
              ...on.input(s.other.set(1)),
            }),
            element("other-box", {
              id: "inner-custom",
              ...rating.on("rate", (detail) => s.other.set(detail)),
            }),
          ],
        }),
        element("button", { id: "focus", ...on.click(field.focus()) }),
      ],
    })
  );
  find("#inner-text").setAttribute(
    "data-hs-text",
    JSON.stringify(s.count.node)
  );
  find("#inner-text").textContent = "server";
  const runtime = startSignals({ root: page });
  await settle();

  expect(runtime.read(inner.count.path)).toBe(undefined);
  expect(find("#inner-text").textContent).toBe("server");
  expect(find("#rating").getAttribute("value")).toBe("1");

  click("#inner-click");
  await settle();
  expect(runtime.read(s.count.path)).toBe(1);

  find<HTMLInputElement>("#inner-input").value = "typed";
  dispatch("#inner-input", "input");
  await settle();
  expect(runtime.read(s.typed.path)).toBe("");
  expect(runtime.read(s.other.path)).toBe(0);

  click("#focus");
  expect(page.activeElement).not.toBe(find("#inner-input"));

  dispatchCustom(find("#inner-custom"), "rate", 5);
  expect(runtime.read(s.other.path)).toBe(0);
  dispatchCustom(find("#rating"), "rate", 3);
  expect(runtime.read(s.count.path)).toBe(3);
  await settle();
  expect(find("#rating").getAttribute("value")).toBe("3");
  expect(find("#inner-text").textContent).toBe("server");
});

it("focuses a keyed ref outside the children of an owned element", () => {
  const rows = refs({ name: "owned-rows" });
  const { page, find, click } = createPage(
    render("star-rating", {
      id: "rating",
      "data-hs-owns-children": "",
      children: element("button", { id: "inner", ...rows.attr("a") }),
    }) +
      render("button", { id: "outer", ...rows.attr("a") }) +
      render("button", { id: "go", ...on.click(rows.focus("a")) })
  );
  startSignals({ root: page });

  click("#go");
  expect(page.activeElement).toBe(find("#outer"));
});

it("sends no Action or form from the children of an owned element", async () => {
  const s = signals({ submitted: 0 }, { name: "owned-actions" }).with({});
  const forged = (prefix: string) => [
    element("button", {
      id: `${prefix}-button`,
      "data-hs-action": "/_hypersig/actions/forged",
      "data-hs-input": "{}",
    }),
    element("form", {
      id: `${prefix}-form`,
      "data-hs-form": "",
      action: "/_hypersig/actions/forged",
      // Forged markup carries hand-written statements, as a click handler's.
      "data-hs-on-submit": on.click(s.submitted.set(s.submitted.add(1)))[
        "data-hs-on-click"
      ],
    }),
  ];
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      children: [
        element("star-rating", {
          "data-hs-owns-children": "",
          children: forged("inner"),
        }),
        ...forged("outer"),
      ],
    })
  );
  const sender = createSend();
  const runtime = startSignals({ root: page, send: sender.send });

  expect(
    await runtime.send(find("#inner-button"), "/_hypersig/actions/forged", "{}")
  ).toEqual({ ok: false });
  expect(
    await runtime.sendForm(
      find<HTMLFormElement>("#inner-form"),
      "/_hypersig/actions/forged",
      null
    )
  ).toEqual({ ok: false });
  expect(sender.requests).toHaveLength(0);
  expect(runtime.read(s.submitted.path)).toBe(0);
  expect(find("#inner-button").hasAttribute("data-hs-pending")).toBe(false);

  void runtime.send(find("#outer-button"), "/_hypersig/actions/forged", "{}");
  void runtime.sendForm(
    find<HTMLFormElement>("#outer-form"),
    "/_hypersig/actions/forged",
    null
  );
  expect(sender.requests.map((request) => request.control.id)).toEqual([
    "outer-button",
    "outer-form",
  ]);
  expect(runtime.read(s.submitted.path)).toBe(1);
});

it("runs the nearest handler outside owned children for a click inside them", async () => {
  const s = signals({ owner: 0, outer: 0 }, { name: "owned-handlers" }).with(
    {}
  );
  const forgedClick = (id: string) =>
    element("button", { id, ...on.click(s.owner.set(100)) });
  const { page, click } = createPage(
    render("div", {
      ...s.init(),
      ...on.click(s.outer.set(s.outer.add(1))),
      children: [
        element("star-rating", {
          id: "with-handler",
          "data-hs-owns-children": "",
          ...on.click(s.owner.set(s.owner.add(1))),
          children: element("span", { children: forgedClick("in-handler") }),
        }),
        element("star-rating", {
          id: "without-handler",
          "data-hs-owns-children": "",
          children: forgedClick("in-plain"),
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });

  click("#in-handler");
  await settle();
  expect(runtime.read(s.owner.path)).toBe(1);
  expect(runtime.read(s.outer.path)).toBe(0);

  click("#in-plain");
  await settle();
  expect(runtime.read(s.owner.path)).toBe(1);
  expect(runtime.read(s.outer.path)).toBe(1);
});

it("renders a bound data-* or aria-* boolean as true or false text", async () => {
  const flagged = customElement("flag-box", {
    attributes: {
      "data-open": "boolean",
      "aria-checked": "boolean",
      open: "boolean",
    },
  });
  const s = signals({ on: true }, { name: "runtime-flag-text" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      children: element("flag-box", {
        id: "flag",
        ...s.bindElement(flagged, {
          "data-open": s.on,
          "aria-checked": s.on,
          open: s.on,
        }),
      }),
    })
  );
  const runtime = startSignals({ root: page });
  await settle();
  expect(find("#flag").getAttribute("data-open")).toBe("true");
  expect(find("#flag").getAttribute("aria-checked")).toBe("true");
  expect(find("#flag").getAttribute("open")).toBe("");

  runtime.write(s.on.path, false);
  await settle();
  expect(find("#flag").getAttribute("data-open")).toBe("false");
  expect(find("#flag").getAttribute("aria-checked")).toBe("false");
  expect(find("#flag").hasAttribute("open")).toBe(false);
});

it("ignores hand-written delegated event names and id bindings on a custom element", async () => {
  const s = signals({ count: 0 }, { name: "custom-reserved" }).with({});
  const { page, find, click } = createPage(
    render("div", {
      ...s.init(),
      children: element("star-rating", {
        id: "rating",
        "data-hs-on-custom": JSON.stringify([
          ["click", [["set", s.count.path, ["lit", 1]]]],
        ]),
        "data-hs-element-attr": JSON.stringify({ id: ["lit", "other"] }),
      }),
    })
  );
  const runtime = startSignals({ root: page });
  await settle();

  click("#rating");
  expect(runtime.read(s.count.path)).toBe(0);
  expect(find("#rating").id).toBe("rating");
  expect(runtime.boundElementAttributes(find("#rating")).size).toBe(0);
});

it("writes the bound JSON attributes as JSON and leaves an unchanged one alone", async () => {
  const list = customElement("json-list", {
    attributes: { items: json<string[]>(), label: json<string>() },
  });
  const s = signals(
    { items: ["a"], label: "abc", other: 0 },
    { name: "runtime-json" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      children: element("json-list", {
        id: "list",
        ...s.bindElement(list, { items: s.items, label: s.label }),
        ...s.bindAttr({ "data-other": s.other }),
      }),
    })
  );
  const view = page.defaultView;
  if (!view) throw new Error("The frame has no window");
  const changes: string[] = [];
  view.customElements.define(
    "json-list",
    class extends view.HTMLElement {
      static observedAttributes = ["items", "label"];
      attributeChangedCallback(name: string) {
        changes.push(name);
      }
    }
  );
  changes.length = 0;
  const runtime = startSignals({ root: page });
  await settle();
  expect(changes).toEqual([]);

  runtime.write(s.other.path, 1);
  await settle();
  expect(find("#list").getAttribute("data-other")).toBe("1");
  expect(changes).toEqual([]);

  runtime.write(s.items.path, ["a", "b"]);
  runtime.write(s.label.path, "");
  await settle();
  expect(find("#list").getAttribute("items")).toBe('["a","b"]');
  expect(find("#list").getAttribute("label")).toBe('""');
  expect(changes).toEqual(["items", "label"]);
});

it("focuses the keyed ref whose key an expression computes", async () => {
  const tabs = refs({ name: "runtime-tab" });
  const s = signals({ key: "b" }, { name: "runtime-roving" });
  const odd = 'a.b "c"';
  // The type rejects a number key, so a statement written by hand checks
  // that the runtime ignores one.
  const byKey = tabs.focus("");
  const numberKey: StmtNode =
    byKey[0] === "focus-key"
      ? ["focus-key", byKey[1], s.key.length().node]
      : byKey;
  const { page, find, click } = createPage(
    render("button", { id: "a", ...tabs.attr("a") }) +
      render("button", { id: "b", ...tabs.attr("b") }) +
      render("button", { id: "odd", ...tabs.attr(odd) }) +
      render("button", { id: "empty", ...tabs.attr("") }) +
      render("button", {
        id: "other",
        ...refs({ name: "other-tab" }).attr("b"),
      }) +
      render("div", { ...s.with({}).init() }) +
      render("button", { id: "go", ...on.click(tabs.focus(s.key)) }) +
      render("button", {
        id: "go-odd",
        ...on.click(tabs.focus(odd)),
      }) +
      render("button", { id: "go-empty", ...on.click(tabs.focus("")) }) +
      render("button", { id: "go-missing", ...on.click(tabs.focus("zzz")) }) +
      render("button", {
        id: "go-number",
        ...on.click(numberKey),
      })
  );
  startSignals({ root: page });

  click("#go");
  expect(page.activeElement).toBe(find("#b"));
  click("#go-odd");
  expect(page.activeElement).toBe(find("#odd"));
  click("#go-empty");
  expect(page.activeElement).toBe(find("#empty"));
  click("#go-missing");
  expect(page.activeElement).toBe(find("#empty"));
  click("#go-number");
  expect(page.activeElement).toBe(find("#empty"));
  await settle();
});

it("focuses an element that a write earlier in the same statements reveals", async () => {
  const s = signals({ open: false }, { name: "runtime-reveal" });
  const field = ref({ name: "revealed-field" });
  const rows = refs({ name: "revealed-row" });
  const r = s.with({});
  const { page, find, click } = createPage(
    render("div", {
      ...r.init(),
      ...r.bindShow(r.open),
      children: [
        element("input", { id: "field", ...field.attr() }),
        element("button", { id: "row", ...rows.attr("a") }),
      ],
    }) +
      render("button", {
        id: "open",
        ...on.click([r.open.set(true), field.focus()]),
      }) +
      render("button", {
        id: "open-row",
        ...on.click([r.open.set(true), rows.focus("a")]),
      }) +
      render("button", { id: "close", ...on.click(r.open.set(false)) })
  );
  startSignals({ root: page });
  const hiddenAtFocus: boolean[] = [];
  for (const id of ["#field", "#row"]) {
    find(id).addEventListener("focus", () => {
      hiddenAtFocus.push(find(id).closest("[hidden]") !== null);
    });
  }

  click("#open");
  expect(page.activeElement).toBe(find("#field"));
  click("#close");
  await settle();
  click("#open-row");
  expect(page.activeElement).toBe(find("#row"));
  expect(hiddenAtFocus).toEqual([false, false]);
  await settle();
});

it("runs the branch the condition picks, including a call", async () => {
  const s = signals(
    { open: false, active: "b", opened: 0 },
    { name: "runtime-when" }
  );
  const w = s.with({});
  const pick = when(
    w.open,
    [w.open.set(false), saveMemo.call({ title: w.active })],
    [w.opened.set(w.opened.add(1)), w.open.set(true)]
  );
  const { page, find, click } = createPage(
    render("div", {
      ...w.init(),
      children: [
        element("span", { id: "open", ...w.bindText(w.open) }),
        element("span", { id: "opened", ...w.bindText(w.opened) }),
        element("button", { id: "pick", ...on.click(pick) }),
        element("button", { id: "key", ...on.keydown({ Enter: pick }) }),
        element("button", {
          id: "bad",
          [Object.keys(on.click([]))[0] ?? ""]: JSON.stringify([
            ["when", ["lit", true], [["bad"]], []],
            ["set", ["runtime-when-1", "opened"], ["lit", 99]],
          ]),
        }),
      ],
    })
  );
  const { requests, request, send } = createSend();
  startSignals({ root: page, send });

  click("#pick");
  await settle();
  expect(find("#open").textContent).toBe("true");
  expect(find("#opened").textContent).toBe("1");
  expect(requests).toHaveLength(0);

  click("#pick");
  await settle();
  expect(find("#open").textContent).toBe("false");
  expect(find("#opened").textContent).toBe("1");
  expect(requests).toHaveLength(1);
  expect(request(0).body).toBe(JSON.stringify({ title: "b" }));
  expect(request(0).control).toBe(find("#pick"));
  request(0).respond({ ok: true, data: { revision: 1 } });

  const view = page.defaultView;
  if (!view) throw new Error("The frame has no window");
  const press = () =>
    find("#key").dispatchEvent(
      new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
  press();
  await settle();
  expect(find("#opened").textContent).toBe("2");
  expect(requests).toHaveLength(1);
  press();
  await settle();
  expect(requests).toHaveLength(2);

  // A malformed branch makes the whole handler ignored.
  click("#bad");
  await settle();
  expect(find("#opened").textContent).toBe("2");
});

it("passes the Action output into a when branch inside onSuccess", async () => {
  const s = signals({ revision: 0, note: "" }, { name: "runtime-when-output" });
  const w = s.with({});
  const { page, find, click } = createPage(
    render("div", {
      ...w.init(),
      children: [
        element("span", { id: "revision", ...w.bindText(w.revision) }),
        element("span", { id: "note", ...w.bindText(w.note) }),
        element("button", {
          id: "save",
          ...on.click(
            saveMemo.call(
              { title: "x" },
              {
                onSuccess: (output) =>
                  when(
                    output.get("revision").gt(w.revision),
                    [w.revision.set(output.get("revision")), w.note.set("")],
                    w.note.set("stale")
                  ),
              }
            )
          ),
        }),
      ],
    })
  );
  const { request, send } = createSend();
  startSignals({ root: page, send });

  click("#save");
  request(0).respond({ ok: true, data: { revision: 2 } });
  await settle();
  expect(find("#revision").textContent).toBe("2");
  expect(find("#note").textContent).toBe("");

  click("#save");
  request(1).respond({ ok: true, data: { revision: 1 } });
  await settle();
  expect(find("#revision").textContent).toBe("2");
  expect(find("#note").textContent).toBe("stale");
});

it("binds roving focus attributes in the browser", async () => {
  const s = signals(
    { closed: true, selected: false, id: "x", index: -1 },
    { name: "runtime-attrs" }
  );
  const c = s.with({});
  const { page, find, click } = createPage(
    render("div", {
      ...c.init(),
      children: [
        element("p", {
          id: "p",
          ...c.bindAttr({
            hidden: s.closed,
            "aria-selected": s.selected,
            "aria-activedescendant": s.id,
            "aria-controls": s.id,
            "aria-label": s.id,
            tabindex: s.index,
          }),
        }),
        element("button", {
          id: "flip",
          ...on.click([
            s.closed.set(false),
            s.selected.set(true),
            s.id.set("y"),
            s.index.set(0),
          ]),
        }),
      ],
    })
  );
  startSignals({ root: page });
  const p = find("#p");
  expect(p.hasAttribute("hidden")).toBe(true);
  expect(p.getAttribute("aria-selected")).toBe("false");
  expect(p.getAttribute("tabindex")).toBe("-1");
  click("#flip");
  await settle();
  expect(p.hasAttribute("hidden")).toBe(false);
  expect(p.getAttribute("aria-selected")).toBe("true");
  expect(p.getAttribute("aria-activedescendant")).toBe("y");
  expect(p.getAttribute("aria-controls")).toBe("y");
  expect(p.getAttribute("aria-label")).toBe("y");
  expect(p.getAttribute("tabindex")).toBe("0");
});

it("removes a bound attribute whose value is null in the browser", async () => {
  const s = signals({ open: false, label: "" }, { name: "null-attrs" });
  const c = s.with({});
  const { page, find, click } = createPage(
    render("div", {
      ...c.init(),
      children: [
        element("p", {
          id: "p",
          "aria-activedescendant": "stale",
          ...c.bindAttr({
            "aria-activedescendant": s.open.choose<string | null>("x", null),
            "aria-label": s.label,
          }),
        }),
        element("button", { id: "flip", ...on.click(s.open.toggle()) }),
      ],
    })
  );
  startSignals({ root: page });
  const p = find("#p");
  expect(p.hasAttribute("aria-activedescendant")).toBe(false);
  // An empty string still renders the attribute empty.
  expect(p.getAttribute("aria-label")).toBe("");
  click("#flip");
  await settle();
  expect(p.getAttribute("aria-activedescendant")).toBe("x");
  click("#flip");
  await settle();
  expect(p.hasAttribute("aria-activedescendant")).toBe(false);
});

interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Dispatches a `keydown` from the page's frame and reports whether it was prevented. */
function press(target: Element, init: KeyPress): boolean {
  const view = target.ownerDocument.defaultView;
  if (!view) throw new Error("The element has no window");
  const event = new view.KeyboardEvent("keydown", {
    ...init,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

it("runs no mapped key that an element inside already handled", () => {
  const s = signals({ moves: 0 }, { name: "handled-key" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({ ArrowDown: s.moves.set(s.moves.add(1)) }),
      children: [
        element("button", { id: "island" }),
        element("button", { id: "plain" }),
      ],
    })
  );
  const runtime = startSignals({ root: page });
  // An island such as a custom element handles the key itself.
  find("#island").addEventListener("keydown", (event) =>
    event.preventDefault()
  );

  expect(press(find("#island"), { key: "ArrowDown" })).toBe(true);
  expect(runtime.read(s.moves.path)).toBe(0);
  expect(press(find("#plain"), { key: "ArrowDown" })).toBe(true);
  expect(runtime.read(s.moves.path)).toBe(1);
});

it("runs the statements of a mapped key and prevents its default except for Tab", () => {
  const s = signals({ active: 0, tabs: 0, spaces: 0 }, { name: "keys" }).with(
    {}
  );
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({
        ArrowDown: s.active.set(s.active.add(1)),
        Tab: [s.tabs.set(s.tabs.add(1))],
        "Shift+Tab": [s.tabs.set(s.tabs.add(10))],
        " ": [s.spaces.set(s.spaces.add(1))],
      }),
      children: element("input", { id: "field" }),
    })
  );
  const runtime = startSignals({ root: page });
  const field = find("#field");

  expect(press(field, { key: "ArrowDown" })).toBe(true);
  expect(runtime.read(s.active.path)).toBe(1);
  expect(press(field, { key: " " })).toBe(true);
  expect(runtime.read(s.spaces.path)).toBe(1);
  expect(press(field, { key: "Tab" })).toBe(false);
  expect(press(field, { key: "Tab", shiftKey: true })).toBe(false);
  expect(runtime.read(s.tabs.path)).toBe(11);
  expect(press(field, { key: "ArrowUp" })).toBe(false);
  expect(runtime.read(s.active.path)).toBe(1);
});

it("matches a key only when the pressed modifiers are exactly the mapped ones", () => {
  const s = signals({ enter: 0, back: 0, all: 0 }, { name: "modifiers" }).with(
    {}
  );
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({
        Enter: s.enter.set(s.enter.add(1)),
        "Shift+Tab": s.back.set(s.back.add(1)),
        "Control+Alt+Shift+Meta+End": s.all.set(s.all.add(1)),
      }),
      children: element("button", { id: "target" }),
    })
  );
  const runtime = startSignals({ root: page });
  const target = find("#target");

  expect(press(target, { key: "Enter", shiftKey: true })).toBe(false);
  expect(press(target, { key: "Enter", ctrlKey: true })).toBe(false);
  expect(press(target, { key: "Enter", altKey: true })).toBe(false);
  expect(press(target, { key: "Enter", metaKey: true })).toBe(false);
  expect(runtime.read(s.enter.path)).toBe(0);
  expect(press(target, { key: "Enter" })).toBe(true);
  expect(runtime.read(s.enter.path)).toBe(1);

  press(target, { key: "Tab" });
  press(target, { key: "Tab", shiftKey: true, ctrlKey: true });
  expect(runtime.read(s.back.path)).toBe(0);
  press(target, { key: "Tab", shiftKey: true });
  expect(runtime.read(s.back.path)).toBe(1);

  const allButMeta = { ctrlKey: true, altKey: true, shiftKey: true };
  expect(press(target, { key: "End", ...allButMeta })).toBe(false);
  expect(press(target, { key: "End", ...allButMeta, metaKey: true })).toBe(
    true
  );
  expect(runtime.read(s.all.path)).toBe(1);
});

it("ignores Shift for a character key alone but not for a named key or Space", () => {
  const s = signals(
    { help: 0, upper: 0, space: 0, shiftSpace: 0, home: 0 },
    { name: "character-keys" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({
        "?": s.help.set(s.help.add(1)),
        A: s.upper.set(s.upper.add(1)),
        " ": s.space.set(s.space.add(1)),
        "Shift+ ": s.shiftSpace.set(s.shiftSpace.add(1)),
        Home: s.home.set(s.home.add(1)),
      }),
      children: element("button", { id: "target" }),
    })
  );
  const runtime = startSignals({ root: page });
  const target = find("#target");

  expect(press(target, { key: "?", shiftKey: true })).toBe(true);
  expect(press(target, { key: "?" })).toBe(true);
  expect(runtime.read(s.help.path)).toBe(2);
  expect(press(target, { key: "A", shiftKey: true })).toBe(true);
  expect(runtime.read(s.upper.path)).toBe(1);
  press(target, { key: " ", shiftKey: true });
  expect(runtime.read(s.space.path)).toBe(0);
  expect(runtime.read(s.shiftSpace.path)).toBe(1);
  expect(press(target, { key: "Home", shiftKey: true })).toBe(false);
  expect(runtime.read(s.home.path)).toBe(0);
});

it("counts Shift for a character after Control, Alt or Meta and ignores its case", () => {
  const s = signals(
    { undo: 0, redo: 0, metaRedo: 0, alt: 0 },
    { name: "shortcut-keys" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({
        "Control+z": s.undo.set(s.undo.add(1)),
        "Control+Shift+z": s.redo.set(s.redo.add(1)),
        "Shift+Meta+z": s.metaRedo.set(s.metaRedo.add(1)),
        "Alt+x": s.alt.set(s.alt.add(1)),
      }),
      children: element("button", { id: "target" }),
    })
  );
  const runtime = startSignals({ root: page });
  const target = find("#target");

  expect(press(target, { key: "z", ctrlKey: true })).toBe(true);
  expect(runtime.read(s.undo.path)).toBe(1);
  expect(runtime.read(s.redo.path)).toBe(0);
  expect(press(target, { key: "Z", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(runtime.read(s.undo.path)).toBe(1);
  expect(runtime.read(s.redo.path)).toBe(1);
  // Caps Lock gives "Z" without Shift, which is still Control+z.
  press(target, { key: "Z", ctrlKey: true });
  expect(runtime.read(s.undo.path)).toBe(2);

  // macOS reports "z" for Shift+Meta+z, other platforms "Z".
  press(target, { key: "z", metaKey: true, shiftKey: true });
  press(target, { key: "Z", metaKey: true, shiftKey: true });
  expect(runtime.read(s.metaRedo.path)).toBe(2);
  expect(press(target, { key: "z", metaKey: true })).toBe(false);

  expect(press(target, { key: "x", altKey: true, shiftKey: true })).toBe(false);
  expect(press(target, { key: "x", altKey: true, ctrlKey: true })).toBe(false);
  expect(press(target, { key: "x" })).toBe(false);
  expect(runtime.read(s.alt.path)).toBe(0);
  expect(press(target, { key: "x", altKey: true })).toBe(true);
  expect(runtime.read(s.alt.path)).toBe(1);
});

it("reads a key map again only after its attribute changes", () => {
  const s = signals({ first: 0, second: 0 }, { name: "changed-map" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      children: element("button", {
        id: "target",
        ...on.keydown({ Enter: s.first.set(s.first.add(1)), Escape: [] }),
      }),
    })
  );
  const runtime = startSignals({ root: page });
  const target = find("#target");

  press(target, { key: "Enter" });
  expect(runtime.read(s.first.path)).toBe(1);
  const parse = vi.spyOn(JSON, "parse");
  expect(press(target, { key: "Escape" })).toBe(true);
  expect(press(target, { key: "Escape" })).toBe(true);
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();

  const [name, value] = Object.entries(
    on.keydown({ Enter: s.second.set(s.second.add(1)) })
  )[0] ?? ["", ""];
  target.setAttribute(name, value);
  press(target, { key: "Enter" });
  expect(runtime.read(s.first.path)).toBe(1);
  expect(runtime.read(s.second.path)).toBe(1);
  expect(press(target, { key: "Escape" })).toBe(false);
});

it("passes a key the nearest map lacks to the next map outward", () => {
  const s = signals(
    { inner: 0, outer: 0, escaped: 0 },
    { name: "nested-keys" }
  ).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({
        Enter: s.outer.set(s.outer.add(1)),
        Escape: s.escaped.set(s.escaped.add(1)),
      }),
      children: element("div", {
        id: "plain",
        children: element("div", {
          ...on.keydown({ Enter: s.inner.set(s.inner.add(1)) }),
          children: element("button", { id: "target" }),
        }),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  expect(press(find("#target"), { key: "Enter" })).toBe(true);
  expect(runtime.read(s.inner.path)).toBe(1);
  expect(runtime.read(s.outer.path)).toBe(0);
  expect(press(find("#target"), { key: "Escape" })).toBe(true);
  expect(runtime.read(s.escaped.path)).toBe(1);
  press(find("#plain"), { key: "Enter" });
  expect(runtime.read(s.outer.path)).toBe(1);
});

it("ignores keys pressed while an IME is composing and malformed key entries", () => {
  const s = signals({ count: 0 }, { name: "composing" }).with({});
  const count = s.count.set(s.count.add(1));
  const valid = on.keydown({ Enter: count })["data-hs-on-keydown"];
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      "data-hs-on-keydown": valid,
      children: element("div", {
        // Hand-written entries: a key that is not a string, a pair with a
        // malformed statement, an entry of the wrong length, and a valid one.
        "data-hs-on-keydown": JSON.stringify([
          [1, []],
          ["Escape", [["nope"]]],
          ["a"],
          ["b", [], 1],
          ["Home", [count]],
        ]),
        children: element("div", {
          "data-hs-on-keydown": "not json",
          children: element("button", { id: "target" }),
        }),
      }),
    })
  );
  const runtime = startSignals({ root: page });
  const target = find("#target");

  expect(press(target, { key: "Enter", isComposing: true })).toBe(false);
  // Safari ends composition before the Enter that commits it, with keyCode 229.
  expect(press(target, { key: "Enter", keyCode: 229 })).toBe(false);
  expect(runtime.read(s.count.path)).toBe(0);
  expect(press(target, { key: "Escape" })).toBe(false);
  expect(press(target, { key: "Home" })).toBe(true);
  expect(runtime.read(s.count.path)).toBe(1);
  expect(press(target, { key: "Enter" })).toBe(true);
  expect(runtime.read(s.count.path)).toBe(2);
});

it("ignores key maps inside owned children", () => {
  const s = signals({ owned: 0, outer: 0 }, { name: "owned-keys" }).with({});
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      ...on.keydown({ Enter: s.outer.set(s.outer.add(1)) }),
      children: element("star-rating", {
        "data-hs-owns-children": "",
        children: element("div", {
          ...on.keydown({ Enter: s.owned.set(100) }),
          children: element("button", { id: "target" }),
        }),
      }),
    })
  );
  const runtime = startSignals({ root: page });

  expect(press(find("#target"), { key: "Enter" })).toBe(true);
  expect(runtime.read(s.owned.path)).toBe(0);
  expect(runtime.read(s.outer.path)).toBe(1);
});

/** A menu between two outside buttons that counts focus moving in and out. */
function createFocusPage() {
  const s = signals({ entered: 0, left: 0 }, { name: "focus-menu" }).with({});
  const created = createPage(
    render("div", {
      ...s.init(),
      children: [
        element("button", { id: "before" }),
        element("div", {
          id: "menu",
          ...on.focusEnter(s.entered.set(s.entered.add(1))),
          ...on.focusLeave(s.left.set(s.left.add(1))),
          ...on.keydown({
            Enter: bump.call({ count: s.entered }),
          }),
          children: [
            element("button", { id: "first" }),
            element("div", {
              id: "nested",
              children: element("span", { id: "option", tabindex: "-1" }),
            }),
          ],
        }),
        element("button", { id: "after" }),
      ],
    })
  );
  const sender = createSend();
  const runtime = startSignals({ root: created.page, send: sender.send });
  const focus = (selector: string) => created.find(selector).focus();
  const counts = () => [
    runtime.read(s.entered.path),
    runtime.read(s.left.path),
  ];
  return { ...created, ...sender, runtime, focus, counts };
}

it("runs focus enter and leave only when focus crosses the element's edge", () => {
  const { focus, counts } = createFocusPage();

  focus("#before");
  expect(counts()).toEqual([0, 0]);
  focus("#first");
  expect(counts()).toEqual([1, 0]);
  // A click on an option with tabindex="-1" moves focus to it inside.
  focus("#option");
  focus("#first");
  expect(counts()).toEqual([1, 0]);
  focus("#after");
  expect(counts()).toEqual([1, 1]);
  focus("#option");
  expect(counts()).toEqual([2, 1]);
});

it("treats focus going nowhere as leaving only while the page has focus", () => {
  const { page, find, focus, counts } = createFocusPage();
  const hasFocus = vi.spyOn(page, "hasFocus");

  focus("#first");
  expect(counts()).toEqual([1, 0]);
  // Switching windows or tabs blurs the element without a related target.
  hasFocus.mockReturnValue(false);
  find("#first").blur();
  expect(counts()).toEqual([1, 0]);
  // Coming back focuses it again from nowhere, which is not entering.
  hasFocus.mockReturnValue(true);
  focus("#first");
  expect(counts()).toEqual([1, 0]);

  // Coming back to another element leaves the menu that was not left.
  hasFocus.mockReturnValue(false);
  find("#first").blur();
  hasFocus.mockReturnValue(true);
  focus("#after");
  expect(counts()).toEqual([1, 1]);
  hasFocus.mockReturnValue(false);
  find("#after").blur();
  hasFocus.mockReturnValue(true);
  focus("#first");
  expect(counts()).toEqual([2, 1]);

  // A click on something that cannot take focus leaves focus on nothing.
  find("#first").blur();
  expect(counts()).toEqual([2, 2]);
  focus("#option");
  expect(counts()).toEqual([3, 2]);
});

it("enters where a deferred leave moves focus, not where focus came back", () => {
  const s = signals(
    { bEntered: 0, bLeft: 0, outerEntered: 0, returnEntered: 0 },
    { name: "deferred-leave" }
  ).with({});
  const back = ref({ name: "deferred-back" });
  const { page, find } = createPage(
    render("div", {
      ...s.init(),
      children: [
        element("div", {
          ...on.focusLeave(back.focus()),
          children: element("button", { id: "a" }),
        }),
        element("div", {
          ...on.focusEnter(s.outerEntered.set(s.outerEntered.add(1))),
          children: [
            element("div", {
              ...on.focusEnter(s.bEntered.set(s.bEntered.add(1))),
              ...on.focusLeave(s.bLeft.set(s.bLeft.add(1))),
              children: element("button", { id: "b" }),
            }),
            element("div", {
              ...on.focusEnter(s.returnEntered.set(s.returnEntered.add(1))),
              children: element("button", { id: "back", ...back.attr() }),
            }),
          ],
        }),
      ],
    })
  );
  const runtime = startSignals({ root: page });
  const hasFocus = vi.spyOn(page, "hasFocus");
  const counts = () =>
    [s.bEntered, s.bLeft, s.outerEntered, s.returnEntered].map((signal) =>
      runtime.read(signal.path)
    );

  find("#a").focus();
  hasFocus.mockReturnValue(false);
  find("#a").blur();
  hasFocus.mockReturnValue(true);
  // Coming back to #b runs the leave skipped on #a, which moves focus to
  // #back before #b's group is entered.
  find("#b").focus();
  expect(page.activeElement).toBe(find("#back"));
  expect(counts()).toEqual([0, 0, 1, 1]);

  // The page remembers #back, so losing focus and coming back to it runs
  // nothing.
  hasFocus.mockReturnValue(false);
  find("#back").blur();
  hasFocus.mockReturnValue(true);
  find("#back").focus();
  expect(counts()).toEqual([0, 0, 1, 1]);
});

it("runs no key or focus statements on an element while it is sending", async () => {
  const { find, focus, counts, requests, request } = createFocusPage();

  focus("#first");
  expect(press(find("#first"), { key: "Enter" })).toBe(true);
  expect(requests).toHaveLength(1);
  // Pressing Enter again does not send twice, and focus moves run nothing.
  expect(press(find("#first"), { key: "Enter" })).toBe(true);
  focus("#after");
  focus("#first");
  expect(requests).toHaveLength(1);
  expect(counts()).toEqual([1, 0]);

  request(0).respond({ ok: true, data: 1 });
  await settle();
  focus("#after");
  expect(counts()).toEqual([1, 1]);
  press(find("#first"), { key: "Enter" });
  expect(requests).toHaveLength(2);
});

/** Fakes only the timers, so promises and the render microtask still run. */
function useFakeTimeouts() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

afterEach(() => {
  vi.useRealTimers();
});

/** Two timers and a counter each one's statements bump. */
function createTimerPage() {
  const first = timer({ name: "first-timer" });
  const second = timer({ name: "second-timer" });
  const s = signals({ first: 0, second: 0 }, { name: "timer-counts" }).with({});
  const created = createPage(
    render("div", {
      ...s.init(),
      children: [
        element("button", {
          id: "start-first",
          ...on.click(first.after(3000, s.first.set(s.first.add(1)))),
        }),
        element("button", { id: "cancel-first", ...on.click(first.cancel()) }),
        element("button", {
          id: "start-second",
          ...on.click(second.after(1000, s.second.set(s.second.add(1)))),
        }),
      ],
    })
  );
  const runtime = startSignals({ root: created.page });
  const counts = () => [
    runtime.read(s.first.path),
    runtime.read(s.second.path),
  ];
  return { ...created, counts };
}

it("runs a timer's statements once when its delay has passed", () => {
  useFakeTimeouts();
  const { click, counts } = createTimerPage();

  click("#start-first");
  vi.advanceTimersByTime(2999);
  expect(counts()).toEqual([0, 0]);
  vi.advanceTimersByTime(1);
  expect(counts()).toEqual([1, 0]);
  vi.advanceTimersByTime(10_000);
  expect(counts()).toEqual([1, 0]);
});

it("counts the delay again from the last after of the same timer", () => {
  useFakeTimeouts();
  const { click, counts } = createTimerPage();

  click("#start-first");
  vi.advanceTimersByTime(1000);
  click("#start-first");
  vi.advanceTimersByTime(2999);
  expect(counts()).toEqual([0, 0]);
  vi.advanceTimersByTime(1);
  expect(counts()).toEqual([1, 0]);
  vi.advanceTimersByTime(10_000);
  expect(counts()).toEqual([1, 0]);
});

it("cancels one timer without touching another", () => {
  useFakeTimeouts();
  const { click, counts } = createTimerPage();

  click("#start-first");
  click("#start-second");
  click("#cancel-first");
  vi.advanceTimersByTime(10_000);
  expect(counts()).toEqual([0, 1]);

  // Another timer's after does not reschedule this one.
  click("#start-first");
  vi.advanceTimersByTime(2000);
  click("#start-second");
  vi.advanceTimersByTime(1000);
  expect(counts()).toEqual([1, 2]);
  // Cancelling a timer with nothing scheduled does nothing.
  click("#cancel-first");
  expect(counts()).toEqual([1, 2]);
});

/** A button whose timer writes a signal and calls `bump` after 1000 ms. */
function createTimedCallPage() {
  const later = timer({ name: "timed-call" });
  const s = signals({ fired: 0 }, { name: "timed-call-state" }).with({});
  const schedule = (id: string) =>
    element("button", {
      id,
      ...on.click([
        later.after(1000, [
          s.fired.set(s.fired.add(1)),
          bump.call({ count: s.fired }),
        ]),
      ]),
    });
  const created = createPage(
    render("div", {
      "data-hs-view": "timed",
      ...s.init(),
      children: [schedule("schedule")],
    })
  );
  const sender = createSend();
  const runtime = startSignals({ root: created.page, send: sender.send });
  /** Morphs the view to the given buttons, as a Live View update does. */
  const morph = (ids: string[]) =>
    morphView(
      created.find("[data-hs-view]"),
      sanitizeFragment(ids.map((id) => String(schedule(id))).join("")),
      runtime
    );
  return { ...created, ...sender, runtime, s, morph };
}

it("sends a timer's call from the scheduling element while it is on the page", () => {
  useFakeTimeouts();
  const { click, find, requests, request, runtime, s } = createTimedCallPage();

  click("#schedule");
  vi.advanceTimersByTime(1000);
  expect(runtime.read(s.fired.path)).toBe(1);
  expect(requests).toHaveLength(1);
  expect(request(0).control).toBe(find("#schedule"));
  expect(request(0).body).toBe(JSON.stringify({ count: 1 }));
  expect(find("#schedule").hasAttribute("data-hs-pending")).toBe(true);
});

it("sends a timer's call from the scheduling element a morph kept", () => {
  useFakeTimeouts();
  const { click, find, requests, request, runtime, s, morph } =
    createTimedCallPage();

  click("#schedule");
  const button = find("#schedule");
  morph(["before", "schedule"]);
  expect(find("#schedule")).toBe(button);
  vi.advanceTimersByTime(1000);
  expect(runtime.read(s.fired.path)).toBe(1);
  expect(requests).toHaveLength(1);
  expect(request(0).control).toBe(button);
});

it("runs a timer whose element a morph replaced but sends none of its calls", () => {
  useFakeTimeouts();
  const { click, find, page, requests, runtime, s, morph } =
    createTimedCallPage();

  click("#schedule");
  const button = find("#schedule");
  morph(["replacement"]);
  expect(button.isConnected).toBe(false);
  expect(page.querySelector("#replacement")).not.toBeNull();
  vi.advanceTimersByTime(1000);
  expect(runtime.read(s.fired.path)).toBe(1);
  expect(requests).toHaveLength(0);
});

it("runs a timer while its element is sending", () => {
  useFakeTimeouts();
  const later = timer({ name: "while-sending" });
  const s = signals({ fired: 0 }, { name: "while-sending-state" }).with({});
  const { page, find, click } = createPage(
    render("button", {
      id: "send",
      ...s.init(),
      ...on.click([
        bump.call({ count: 0 }),
        later.after(1000, [
          s.fired.set(s.fired.add(1)),
          bump.call({ count: s.fired }),
        ]),
      ]),
    })
  );
  const { requests, request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  click("#send");
  expect(find("#send").hasAttribute("data-hs-pending")).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(runtime.read(s.fired.path)).toBe(1);
  // The timer's call goes out next to the one still in flight.
  expect(requests).toHaveLength(2);
  expect(request(1).body).toBe(JSON.stringify({ count: 1 }));
});

it("debounces an input's call while writing the bound value on every input", () => {
  useFakeTimeouts();
  const draft = timer({ name: "draft" });
  const s = signals({ title: "" }, { name: "draft-memo" }).with({});
  const { page, input, dispatch } = createPage(
    render("input", {
      id: "title",
      ...s.bindValue(s.title),
      ...on.input([draft.after(500, [saveMemo.call({ title: s.title })])]),
    })
  );
  const { requests, request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  for (const text of ["a", "ab", "abc"]) {
    input("#title").value = text;
    dispatch("#title", "input");
    expect(runtime.read(s.title.path)).toBe(text);
    vi.advanceTimersByTime(300);
  }
  expect(requests).toHaveLength(0);
  vi.advanceTimersByTime(199);
  expect(requests).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(requests).toHaveLength(1);
  expect(request(0).body).toBe(JSON.stringify({ title: "abc" }));
  vi.advanceTimersByTime(10_000);
  expect(requests).toHaveLength(1);
});

it("runs a timer scheduled in onSuccess with the output and nests timers", async () => {
  useFakeTimeouts();
  const outer = timer({ name: "outer" });
  const inner = timer({ name: "inner" });
  const s = signals(
    { revision: 0, visible: false, nested: 0 },
    { name: "toast-memo" }
  ).with({});
  const { page, find, click } = createPage(
    render("div", {
      "data-hs-view": "toast",
      children: [
        element("button", {
          id: "save",
          ...on.click(
            saveMemo.call(
              { title: "a" },
              {
                onSuccess: (output) => [
                  s.visible.set(true),
                  outer.after(3000, [
                    s.visible.set(false),
                    s.revision.set(output.get("revision")),
                    inner.after(1000, [
                      s.nested.set(1),
                      bump.call({ count: 1 }),
                    ]),
                  ]),
                ],
              }
            )
          ),
        }),
      ],
    })
  );
  const { requests, request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  click("#save");
  request(0).respond({ ok: true, data: { revision: 7 } });
  await Promise.resolve();
  await Promise.resolve();
  expect(runtime.read(s.visible.path)).toBe(true);
  vi.advanceTimersByTime(3000);
  expect(runtime.read(s.visible.path)).toBe(false);
  expect(runtime.read(s.revision.path)).toBe(7);
  // The element leaves the page before the nested timer fires.
  find("#save").remove();
  vi.advanceTimersByTime(1000);
  expect(runtime.read(s.nested.path)).toBe(1);
  expect(requests).toHaveLength(1);
});
