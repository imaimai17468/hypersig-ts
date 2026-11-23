// The automatic JSX runtime that `<span {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import { expect, it } from "vite-plus/test";
import type { Expr, Signal } from "./index.js";
import { lit, on, ref, signalFamily, signals, uuid } from "./index.js";

it("renders evaluated values for the request", () => {
  const editor = signals({ base: 0, published: 0 }, { name: "memo-editor" });
  const e = editor.with({ base: 3, published: 5 });

  expect(e.bindText(e.base)).toEqual({
    "data-hs-text": '["sig",["memo-editor-1","base"]]',
    children: "3",
  });
  expect(e.bindShow(e.published.gt(e.base))).not.toHaveProperty("hidden");
  const same = editor.with({ base: 5, published: 5 });
  expect(same.bindShow(same.published.gt(same.base))).toEqual({
    "data-hs-show":
      '["gt",["sig",["memo-editor-1","published"]],["sig",["memo-editor-1","base"]]]',
    hidden: true,
  });
  expect(e.init()["data-hs-signals"]).toBe(
    '[[["memo-editor-1","base"],3],[["memo-editor-1","published"],5]]'
  );
});

it("fills fields left out of with from the initial values", () => {
  const editor = signals(
    { base: 0, operation: "start" },
    { name: "partial-editor" }
  );
  const e = editor.with({ base: 2 });

  expect(e.bindText(e.operation).children).toBe("start");
  expect(e.init()["data-hs-signals"]).toBe(
    '[[["partial-editor-1","base"],2],[["partial-editor-1","operation"],"start"]]'
  );
  expect(e.with({ operation: "next" }).bindText(e.base.add(1)).children).toBe(
    "3"
  );
});

it("reads other groups at their initial values and builtins as false", () => {
  const other = signals({ count: 7 }, { name: "other-group" });
  const view = signals({ label: "n" }, { name: "reader" }).with({});

  expect(view.bindText(other.count.mul(2)).children).toBe("14");
  expect(view.bindText(view.label.concat("!")).children).toBe("n!");
  expect(view.bindShow(view.label.eq("n")).hidden).toBeUndefined();
  expect(view.bindShow(view.label.ne("n")).hidden).toBe(true);
  expect(view.bindText(uuid()).children).toBe("");
  expect(
    view.bindText(view.label.eq("n").then(lit("yes"), "no")).children
  ).toBe("yes");
});

it("renders with Hono JSX", () => {
  const editor = signals({ base: 0 }, { name: "jsx-editor" });
  const e = editor.with({ base: 3 });

  expect(String(jsx("span", { ...e.bindText(e.base) }))).toBe(
    '<span data-hs-text="[&quot;sig&quot;,[&quot;jsx-editor-1&quot;,&quot;base&quot;]]">3</span>'
  );
});

it("numbers groups per name", () => {
  const unnamed = signals({ value: 1 });
  const first = signals({ value: 1 }, { name: "counted" });
  const second = signals({ value: 1 }, { name: "counted" });
  const keyed = signalFamily({ value: 1 }, { name: "counted" });
  const focusTarget = ref();

  expect(unnamed.value.path).toEqual(["signal-1", "value"]);
  expect(first.value.path).toEqual(["counted-1", "value"]);
  expect(second.value.path).toEqual(["counted-2", "value"]);
  expect(keyed.at("k").value.path).toEqual(["counted-3", "k", "value"]);
  expect(focusTarget.attr()).toEqual({ "data-hs-ref": "ref-1" });
  expect(focusTarget.focus()).toEqual(["focus", "ref-1"]);
  // @ts-expect-error A signal group name must be an identifier.
  expect(() => signals({ value: 1 }, { name: "bad name" })).toThrow(
    "Signal name"
  );
});

it("keys family members by arbitrary data", () => {
  const rows = signalFamily({ completed: false }, { name: "todo-row" });
  const odd = rows.at('a"/.b');
  const plain = rows.at("a");

  expect(odd.completed.path).toEqual(["todo-row-1", 'a"/.b', "completed"]);
  expect(plain.completed.path).toEqual(["todo-row-1", "a", "completed"]);
  const oddScope = odd.with({ completed: true });
  expect(JSON.parse(oddScope.init()["data-hs-signals"])).toEqual([
    [["todo-row-1", 'a"/.b', "completed"], true],
  ]);
  expect(JSON.parse(plain.with({}).init()["data-hs-signals"])).toEqual([
    [["todo-row-1", "a", "completed"], false],
  ]);
  expect(oddScope.bindShow(odd.completed).hidden).toBeUndefined();
  expect(oddScope.bindShow(plain.completed).hidden).toBe(true);
});

it("binds only allowed attributes", () => {
  const toggle = signals({ flag: true, note: "x" }, { name: "attr-group" });
  const shown = toggle.with({ flag: true });
  const attrs = shown.bindAttr({
    "aria-pressed": shown.flag,
    disabled: shown.flag,
    "data-note": shown.note,
  });

  expect(attrs).toEqual({
    "aria-pressed": "true",
    disabled: true,
    "data-note": "x",
    "data-hs-attr": JSON.stringify({
      "aria-pressed": ["sig", ["attr-group-1", "flag"]],
      disabled: ["sig", ["attr-group-1", "flag"]],
      "data-note": ["sig", ["attr-group-1", "note"]],
    }),
  });
  const hidden = toggle.with({ flag: false });
  const off = hidden.bindAttr({
    "aria-pressed": hidden.flag,
    disabled: hidden.flag,
  });
  expect(off).not.toHaveProperty("disabled");
  expect(off["aria-pressed"]).toBe("false");
  // @ts-expect-error href could navigate to a value from a signal.
  expect(() => shown.bindAttr({ href: lit("/") })).toThrow("href");
  // @ts-expect-error data-hs-* attributes belong to the runtime.
  expect(() => shown.bindAttr({ "data-hs-text": lit("x") })).toThrow(
    "data-hs-text"
  );
});

it("binds input values by signal type", () => {
  const form = signals(
    { title: "", revision: 0, done: false },
    { name: "form-group" }
  );
  const filled = form.with({ title: "Hi", revision: 4, done: true });

  expect(filled.bindValue(filled.title)).toEqual({
    "data-hs-bind": '["form-group-1","title"]',
    value: "Hi",
  });
  expect(filled.bindValue(filled.revision)).toEqual({
    "data-hs-bind": '["form-group-1","revision"]',
    value: "4",
  });
  expect(filled.bindValue(filled.done)).toEqual({
    "data-hs-bind": '["form-group-1","done"]',
    checked: true,
  });
  expect(form.with({ done: false }).bindValue(form.done)).toEqual({
    "data-hs-bind": '["form-group-1","done"]',
  });
});

it("serializes statements and checks types", () => {
  const group = signals(
    { base: 0, published: 0, flag: false, memo: { title: "t" } },
    { name: "stmt-group" }
  );
  const e = group.with({});

  expect(on.click([e.base.set(e.published), e.flag.toggle()])).toEqual({
    "data-hs-on-click":
      '[["set",["stmt-group-1","base"],["sig",["stmt-group-1","published"]]],["toggle",["stmt-group-1","flag"]]]',
  });
  expect(on.input(e.base.set(1))).toEqual({
    "data-hs-on-input": '[["set",["stmt-group-1","base"],["lit",1]]]',
  });
  expect(
    on.change(e.flag.set(e.base.sub(1).le(0).and(true).or(false).not()))
  ).toEqual({
    "data-hs-on-change": JSON.stringify([
      [
        "set",
        ["stmt-group-1", "flag"],
        [
          "not",
          [
            "or",
            [
              "and",
              [
                "le",
                ["sub", ["sig", ["stmt-group-1", "base"]], ["lit", 1]],
                ["lit", 0],
              ],
              ["lit", true],
            ],
            ["lit", false],
          ],
        ],
      ],
    ]),
  });
  const title: Expr<string> = e.memo.get("title");
  expect(title.node).toEqual([
    "get",
    ["sig", ["stmt-group-1", "memo"]],
    "title",
  ]);
  expect(e.bindText(title).children).toBe("t");
  expect(e.base.ge(e.published).node[0]).toBe("ge");
  expect(e.base.lt(1).node[0]).toBe("lt");

  // @ts-expect-error A number signal cannot take a string.
  e.base.set("x");
  // @ts-expect-error A number signal cannot take a string expression.
  e.base.set(e.memo.get("title"));
  // @ts-expect-error toggle exists only on boolean signals.
  e.base.toggle();
  const hasAddOnBoolean: "add" extends keyof Expr<boolean> ? true : false =
    false;
  expect(hasAddOnBoolean).toBe(false);
  // @ts-expect-error The memo object has no field named "body".
  e.memo.get("body");
  // @ts-expect-error Signal values are JSON.
  signals({ at: new Date() });
  // @ts-expect-error A field named "with" would hide the scope method.
  expect(() => signals({ with: 1 })).toThrow('"with"');
  const flag: Signal<boolean> = e.flag;
  expect(flag.path).toEqual(["stmt-group-1", "flag"]);
});
