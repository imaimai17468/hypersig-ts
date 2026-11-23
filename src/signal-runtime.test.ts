// The automatic JSX runtime that `<span {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import * as v from "valibot";
import { expect, it } from "vite-plus/test";
import {
  createHypersig,
  createMemoryPubSub,
  on,
  ref,
  signals,
  uuid,
} from "./index.js";
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

/** A counter in a Live View whose button bumps it optimistically. */
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

it("shows an optimistic change before the response and keeps it on success", async () => {
  const todo = signals(
    { completed: false, revision: 0 },
    { name: "optimistic-todo" }
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

it("reverts on failure unless the server sent a newer value", async () => {
  const { find, click, request, runtime, c, sendSnapshot } = createBumpPage();

  click("#bump");
  expect(runtime.read(c.count.path)).toBe(2);
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(c.count.path)).toBe(1);
  expect(runtime.read(c.failed.path)).toBe(true);
  expect(find("#count").textContent).toBe("1");

  click("#bump");
  expect(runtime.read(c.failed.path)).toBe(false);
  sendSnapshot(5, 2);
  request(1).respond({ ok: false });
  await settle();
  expect(runtime.read(c.count.path)).toBe(5);
  expect(find("#count").textContent).toBe("5");
});

it("holds snapshots while a call is pending and applies the latest on success", async () => {
  const { find, click, request, runtime, c, sendSnapshot } = createBumpPage();

  click("#bump");
  sendSnapshot(3, 2);
  await settle();
  expect(find("#count").textContent).toBe("2");
  expect(runtime.read(c.revision.path)).toBe(2);
  sendSnapshot(4, 3);
  await settle();
  expect(find("#count").textContent).toBe("2");

  request(0).respond({ ok: true, data: 4 });
  await settle();
  expect(find("#count").textContent).toBe("4");
  expect(runtime.read(c.failed.path)).toBe(false);

  sendSnapshot(6, 4);
  await settle();
  expect(find("#count").textContent).toBe("6");
});

it("reverts on a network error", async () => {
  const { click, request, runtime, c } = createBumpPage();

  click("#bump");
  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(c.count.path)).toBe(1);
  expect(runtime.read(c.failed.path)).toBe(true);

  click("#bump");
  expect(runtime.read(c.count.path)).toBe(2);
  request(1).fail();
  await settle();
  expect(runtime.read(c.count.path)).toBe(1);
  expect(runtime.read(c.failed.path)).toBe(true);
  expect(runtime.read(["$pending", bump.url])).toBe(false);
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

it("reverts only the paths written since the previous call, to their value before the handler", async () => {
  const both = signals({ count: 1, open: false }, { name: "two-calls" });
  const b = both.with({});
  const { page, click } = createPage(
    render("button", {
      id: "both",
      ...b.init(),
      ...on.click([
        b.count.set(b.count.add(1)),
        b.count.set(b.count.add(1)),
        bump.call({ count: b.count }),
        b.open.toggle(),
        saveMemo.call({ title: "t" }),
      ]),
    })
  );
  const { request, send } = createSend();
  const runtime = startSignals({ root: page, send });

  click("#both");
  expect(runtime.read(b.count.path)).toBe(3);
  expect(runtime.read(b.open.path)).toBe(true);
  request(1).respond({ ok: false });
  await settle();
  expect(runtime.read(b.open.path)).toBe(false);
  expect(runtime.read(b.count.path)).toBe(3);

  request(0).respond({ ok: false });
  await settle();
  expect(runtime.read(b.count.path)).toBe(1);
});
