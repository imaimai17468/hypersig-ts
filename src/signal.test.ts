// The automatic JSX runtime that `<span {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import { expect, it } from "vite-plus/test";
import type { Expr, Signal, SignalRefs } from "./index.js";
import {
  lit,
  on,
  ref,
  refs,
  signalFamily,
  signals,
  timer,
  uuid,
  when,
} from "./index.js";
import { exprOf } from "./signal.js";

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

it("marks fields left out of with as defaults filled from the initial values", () => {
  const editor = signals(
    { base: 0, operation: "start" },
    { name: "partial-editor" }
  );
  const e = editor.with({ base: 2 });

  expect(e.bindText(e.operation).children).toBe("start");
  expect(e.init()["data-hs-signals"]).toBe(
    '[[["partial-editor-1","base"],2],[["partial-editor-1","operation"],"start",0]]'
  );
  expect(e.with({ operation: "next" }).bindText(e.base.add(1)).children).toBe(
    "3"
  );
  // @ts-expect-error With exactOptionalPropertyTypes, undefined is not a field value.
  const unset = editor.with({ base: 2, operation: undefined });
  expect(unset.init()["data-hs-signals"]).toBe(
    '[[["partial-editor-1","base"],2],[["partial-editor-1","operation"],"start",0]]'
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
  const pending = exprOf<boolean>(["sig", ["$pending", "/x"]]);
  expect(view.bindText(pending).children).toBe("false");
  expect(
    view.bindText(view.label.eq("n").choose(lit("yes"), "no")).children
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
  // @ts-expect-error A ref name must be an identifier.
  expect(() => ref({ name: "bad name" })).toThrow("Ref name");
  const runtimeName: string = "also bad";
  expect(() => ref({ name: runtimeName })).toThrow("Ref name");
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
    [["todo-row-1", "a", "completed"], false, 0],
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
  // @ts-expect-error With exactOptionalPropertyTypes, undefined is not an expression.
  const skipped = shown.bindAttr({
    disabled: undefined,
    "data-note": shown.note,
  });
  expect(skipped).toEqual({
    "data-note": "x",
    "data-hs-attr": JSON.stringify({
      "data-note": ["sig", ["attr-group-1", "note"]],
    }),
  });
  const removed = shown.bindAttr({
    "aria-activedescendant": lit(null),
    "data-note": shown.flag.choose<string | null>(null, "x"),
    hidden: lit(null),
  });
  expect(removed).toEqual({
    "data-hs-attr": JSON.stringify({
      "aria-activedescendant": ["lit", null],
      "data-note": [
        "if",
        ["sig", ["attr-group-1", "flag"]],
        ["lit", null],
        ["lit", "x"],
      ],
      hidden: ["lit", null],
    }),
  });
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
    "data-hs-bind": '[["form-group-1","title"],"string"]',
    value: "Hi",
  });
  expect(filled.bindValue(filled.revision)).toEqual({
    "data-hs-bind": '[["form-group-1","revision"],"number"]',
    value: "4",
  });
  expect(filled.bindValue(filled.done)).toEqual({
    "data-hs-bind": '[["form-group-1","done"],"boolean"]',
    checked: true,
  });
  expect(form.with({ done: false }).bindValue(form.done)).toEqual({
    "data-hs-bind": '[["form-group-1","done"],"boolean"]',
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

it("builds string, number and array expression nodes", () => {
  const s = exprOf<string>(["sig", ["g", "s"]]);
  const n = exprOf<number>(["sig", ["g", "n"]]);
  const list = exprOf<readonly string[]>(["sig", ["g", "list"]]);
  const sig = (name: string) => ["sig", ["g", name]];

  expect(s.length().node).toEqual(["length", sig("s")]);
  expect(list.length().node).toEqual(["length", sig("list")]);
  expect(s.trim().node).toEqual(["trim", sig("s")]);
  expect(s.lower().node).toEqual(["lower", sig("s")]);
  expect(s.includes("a").node).toEqual(["includes", sig("s"), ["lit", "a"]]);
  expect(s.includes(s.trim()).node).toEqual([
    "includes",
    sig("s"),
    ["trim", sig("s")],
  ]);
  expect(n.clamp(0, n.add(1)).node).toEqual([
    "clamp",
    sig("n"),
    ["lit", 0],
    ["add", sig("n"), ["lit", 1]],
  ]);
  expect(n.mod(3).node).toEqual(["mod", sig("n"), ["lit", 3]]);
  expect(list.at(n, "none").node).toEqual([
    "at",
    sig("list"),
    sig("n"),
    ["lit", "none"],
  ]);

  const typed: Expr<string> = list.at(0, s);
  expect(typed.node[0]).toBe("at");
  const lengthOfLength: Expr<number> = s.length().clamp(0, 1);
  expect(lengthOfLength.node[0]).toBe("clamp");

  // @ts-expect-error A number has no trim.
  expect(n.trim).toBeDefined();
  // @ts-expect-error A string has no mod.
  expect(s.mod).toBeDefined();
  // @ts-expect-error The fallback must have the element type of the array.
  list.at(0, 1);
  const modes = signals(
    { order: ["light", "dark"] as readonly ("light" | "dark")[] },
    { name: "at-modes" }
  );
  const mode: Expr<"light" | "dark"> = modes.order.at(0, "light");
  expect(mode.node[0]).toBe("at");
  // @ts-expect-error The fallback cannot widen a union of literal elements.
  modes.order.at(0, "sepia");
  // @ts-expect-error A number has no length.
  expect(n.length).toBeDefined();
  // @ts-expect-error includes takes a string.
  s.includes(1);
  // @ts-expect-error A string has no at.
  expect(s.at).toBeDefined();
});

it("evaluates array and string expressions on signal values", () => {
  const picker = signals(
    { items: ["a", "b", "c"], index: 4, query: "  Hi " },
    { name: "picker" }
  );
  const p = picker.with({});
  const wrapped = p.index.mod(p.items.length());

  expect(p.bindText(wrapped).children).toBe("1");
  expect(p.bindText(p.items.at(wrapped, "none")).children).toBe("b");
  expect(p.bindText(p.items.at(9, "none")).children).toBe("none");
  expect(p.bindText(p.query.trim().lower()).children).toBe("hi");
  expect(p.bindShow(p.query.lower().includes("hi")).hidden).toBeUndefined();
  expect(p.bindText(p.index.clamp(0, 2)).children).toBe("2");
  const item: Signal<string> = signals({ s: "x" }, { name: "item" }).s;
  expect(p.items.at(0, item).node[0]).toBe("at");
});

it("renders roving focus attributes on the server", () => {
  const s = signals(
    { closed: false, open: true, id: "tab-b", index: 2 },
    { name: "roving-attrs" }
  );
  const c = s.with({});
  const shown = c.bindAttr({
    hidden: s.closed,
    "aria-selected": s.open,
    "aria-activedescendant": s.id,
    "aria-controls": s.id,
    "aria-label": s.id,
    tabindex: s.index,
  });
  expect(shown.hidden).toBeUndefined();
  expect(shown["aria-selected"]).toBe("true");
  expect(shown["aria-activedescendant"]).toBe("tab-b");
  expect(shown["aria-controls"]).toBe("tab-b");
  expect(shown["aria-label"]).toBe("tab-b");
  expect(shown.tabindex).toBe("2");
  expect(s.with({ closed: true }).bindAttr({ hidden: s.closed }).hidden).toBe(
    true
  );
});

it("builds keyed refs that tell a key containing separators apart", () => {
  const tabs: SignalRefs = refs({ name: "tab" });
  const s = signals({ key: "b" }, { name: "keyed-focus" });
  expect(tabs.attr('a"b. c')).toEqual({
    "data-hs-ref": JSON.stringify(["tab-1", 'a"b. c']),
  });
  expect(tabs.attr("")).toEqual({
    "data-hs-ref": JSON.stringify(["tab-1", ""]),
  });
  expect(tabs.focus("b")).toEqual(["focus-key", "tab-1", ["lit", "b"]]);
  expect(tabs.focus(s.key)).toEqual([
    "focus-key",
    "tab-1",
    ["sig", ["keyed-focus-1", "key"]],
  ]);
  const keyTypes = signals(
    { index: 0, flag: false, keys: ["a"] },
    { name: "focus-key-types" }
  );
  // @ts-expect-error A number expression never matches a string key.
  tabs.focus(keyTypes.index);
  // @ts-expect-error A boolean expression never matches a string key.
  tabs.focus(keyTypes.flag);
  // @ts-expect-error An array expression never matches a string key.
  tabs.focus(keyTypes.keys);
  // @ts-expect-error A refs name must be an identifier.
  expect(() => refs({ name: "bad name" })).toThrow("Ref name");
  const runtimeName: string = "also bad";
  expect(() => refs({ name: runtimeName })).toThrow("Ref name");
  expect(refs().attr("x")["data-hs-ref"]).toBe(JSON.stringify(["refs-1", "x"]));
});

it("writes key maps and focus handlers as statements per key", () => {
  const s = signals({ active: 0, open: false }, { name: "key-map" }).with({});
  const down = s.active.set(s.active.add(1));
  expect(
    on.keydown({
      ArrowDown: down,
      "Shift+Tab": [s.open.set(false)],
      "Control+Alt+Shift+Meta+Home": [],
      "Control+Shift+z": [],
      "Alt+Shift+Meta+?": [],
      "Control+ä": [],
      a: [],
      "+": [],
      " ": [],
      "Shift+ ": [],
      1: [],
      あ: [],
    })
  ).toEqual({
    "data-hs-on-keydown": JSON.stringify([
      ["1", []],
      ["ArrowDown", [down]],
      ["Shift+Tab", [s.open.set(false)]],
      ["Control+Alt+Shift+Meta+Home", []],
      ["Control+Shift+z", []],
      ["Alt+Shift+Meta+?", []],
      ["Control+ä", []],
      ["a", []],
      ["+", []],
      [" ", []],
      ["Shift+ ", []],
      ["あ", []],
    ]),
  });
  expect(on.keydown({})).toEqual({ "data-hs-on-keydown": "[]" });
  expect(on.focusEnter(s.open.set(true))).toEqual({
    "data-hs-on-focus-enter": JSON.stringify([s.open.set(true)]),
  });
  expect(on.focusLeave([s.open.set(false)])).toEqual({
    "data-hs-on-focus-leave": JSON.stringify([s.open.set(false)]),
  });
});

it("rejects key names outside the named keys, single characters and the modifier order", () => {
  // @ts-expect-error "Entr" is not a key name.
  expect(() => on.keydown({ Entr: [] })).toThrow('"Entr"');
  // @ts-expect-error Modifiers go in the order Control, Alt, Shift, Meta.
  expect(() => on.keydown({ "Shift+Control+Enter": [] })).toThrow(
    '"Shift+Control+Enter"'
  );
  // @ts-expect-error A character key is one character.
  expect(() => on.keydown({ ab: [] })).toThrow('"ab"');
  // @ts-expect-error A modifier needs a key after it.
  expect(() => on.keydown({ "Shift+": [] })).toThrow('"Shift+"');
  // @ts-expect-error A key name is not empty.
  expect(() => on.keydown({ "": [] })).toThrow('""');
  // @ts-expect-error Shift is ignored for a character key, written as the character.
  expect(() => on.keydown({ "Shift+?": [] })).toThrow('write "?" itself');
  // @ts-expect-error A character after Control, Alt or Meta is written in lowercase.
  expect(() => on.keydown({ "Control+Z": [] })).toThrow('write "Control+z"');
  // @ts-expect-error Shift does not change how the character is written.
  expect(() => on.keydown({ "Shift+Meta+Z": [] })).toThrow(
    'write "Shift+Meta+z"'
  );
  // @ts-expect-error A number key is one digit.
  expect(() => on.keydown({ 12: [] })).toThrow('"12"');
  const name: string = "Control";
  // A computed name is a string, which the types cannot check.
  expect(() => on.keydown({ ["Shift+" + name]: [] })).toThrow(
    '"Shift+Control"'
  );
  expect(() => on.keydown({ ["Meta+Alt+" + name]: [] })).toThrow(
    '"Meta+Alt+Control"'
  );
  const character: string = "A";
  expect(() => on.keydown({ ["Shift+" + character]: [] })).toThrow(
    'write "A" itself'
  );
  expect(() => on.keydown({ ["Alt+" + character]: [] })).toThrow(
    'write "Alt+a"'
  );
});

it("writes timer statements that reschedule or cancel one reservation", () => {
  const toast = timer({ name: "toast" });
  const s = signals({ visible: true }, { name: "toast-state" }).with({});
  expect(toast.after(3000, s.visible.set(false))).toEqual([
    "after",
    "toast-1",
    3000,
    [s.visible.set(false)],
  ]);
  expect(toast.after(0, [])).toEqual(["after", "toast-1", 0, []]);
  expect(toast.cancel()).toEqual(["cancel", "toast-1"]);
  expect(
    toast.after(10, [timer({ name: "toast" }).after(5, s.visible.toggle())])
  ).toEqual([
    "after",
    "toast-1",
    10,
    [["after", "toast-2", 5, [s.visible.toggle()]]],
  ]);
  expect(timer().cancel()).toEqual(["cancel", "timer-1"]);
  // @ts-expect-error A timer name must be an identifier.
  expect(() => timer({ name: "bad name" })).toThrow("Timer name");
  const runtimeName: string = "also bad";
  expect(() => timer({ name: runtimeName })).toThrow("Timer name");
});

it("rejects a delay that is not a non-negative integer when after is called", () => {
  const t = timer({ name: "delay" });
  expect(() => t.after(-1, [])).toThrow(RangeError);
  expect(() => t.after(1.5, [])).toThrow(RangeError);
  expect(() => t.after(Number.NaN, [])).toThrow(RangeError);
  expect(() => t.after(Number.POSITIVE_INFINITY, [])).toThrow(RangeError);
  // Browsers fire a setTimeout delay above 2^31 - 1 almost at once.
  expect(() => t.after(2_147_483_648, [])).toThrow(RangeError);
  expect(t.after(2_147_483_647, [])).toEqual([
    "after",
    "delay-1",
    2_147_483_647,
    [],
  ]);
});

it("writes a condition with the statements of each branch", () => {
  const s = signals({ open: false, count: 0 }, { name: "when-branches" });
  const open = ["sig", ["when-branches-1", "open"]];
  expect(when(s.open, s.count.set(1))).toEqual([
    "when",
    open,
    [["set", ["when-branches-1", "count"], ["lit", 1]]],
    [],
  ]);
  const hide = timer({ name: "when-hide" });
  expect(
    when(
      s.count.gt(2),
      [s.open.set(false), hide.cancel()],
      [when(s.open, hide.after(5, s.open.toggle()))]
    )
  ).toEqual([
    "when",
    ["gt", ["sig", ["when-branches-1", "count"]], ["lit", 2]],
    [
      ["set", ["when-branches-1", "open"], ["lit", false]],
      ["cancel", "when-hide-1"],
    ],
    [["when", open, [["after", "when-hide-1", 5, [s.open.toggle()]]], []]],
  ]);
  expect(when(true, [])).toEqual(["when", ["lit", true], [], []]);
  // @ts-expect-error The condition must be a boolean expression.
  when(s.count, []);
});
