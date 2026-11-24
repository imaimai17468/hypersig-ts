import { expect, expectTypeOf, it } from "vite-plus/test";
import type * as elementEntry from "./element.js";
import type { AttributeValues, EventDetail } from "./element.js";
import type * as packageEntry from "./index.js";
import { CustomTag, customElement, event, json, signals } from "./index.js";
import type { JsonValue } from "./protocol.js";

const rating = customElement("star-rating", {
  attributes: {
    value: "number",
    max: "number",
    label: "string",
    readonly: "boolean",
  },
  events: { rate: event<number>(), "hover:star": event<{ star: number }>() },
  ownsChildren: true,
});

const plain = customElement("plain-box", { attributes: { value: "number" } });

it("declares a custom element as a value", () => {
  const declared = customElement("star-rating", {
    attributes: { value: "number" },
    events: { rate: event<number>() },
    ownsChildren: true,
  });
  expect(declared.tag).toBe("star-rating");
  expect(declared.ownsChildren).toBe(true);
  expect(declared.attributes).toEqual({ value: "number" });
  expect(declared.events).toEqual(["rate"]);
  expectTypeOf(declared.tag).toEqualTypeOf<"star-rating">();
  expectTypeOf(declared.ownsChildren).toEqualTypeOf<true>();

  const bare = customElement("bare-box");
  expect(bare.attributes).toEqual({});
  expect(bare.events).toEqual([]);
  expect(bare.ownsChildren).toBe(false);
});

it("records each attribute kind and infers the value types", () => {
  const typed = customElement("typed-box", {
    attributes: {
      name: "string",
      size: "number",
      open: "boolean",
      any: "json",
      items: json<string[]>(),
    },
    events: { pick: event<{ index: number }>(), clear: event() },
  });
  expect(typed.attributes).toEqual({
    name: "string",
    size: "number",
    open: "boolean",
    any: "json",
    items: "json",
  });
  expect(typed.events).toEqual(["pick", "clear"]);
  expectTypeOf<AttributeValues<typeof typed>>().toEqualTypeOf<{
    name: string;
    size: number;
    open: boolean;
    any: JsonValue;
    items: string[];
  }>();
  expectTypeOf<EventDetail<typeof typed, "pick">>().toEqualTypeOf<{
    index: number;
  }>();
  expectTypeOf<EventDetail<typeof typed, "clear">>().toEqualTypeOf<null>();
});

it("renders the declared tag with CustomTag", async () => {
  expect(String(await CustomTag({ of: rating, id: "r", max: 5 }))).toContain(
    '<star-rating id="r" max="5" data-hs-owns-children="">'
  );
  expect(String(await CustomTag({ of: rating, id: "r", value: 3 }))).toContain(
    '<star-rating id="r" value="3" data-hs-owns-children="">'
  );
  expect(String(await CustomTag({ of: plain, value: 1, children: "x" }))).toBe(
    '<plain-box value="1">x</plain-box>'
  );
  expect(
    String(
      await CustomTag({
        of: plain,
        class: "box",
        role: "img",
        "aria-label": "Box",
        "data-row": 2,
      })
    )
  ).toBe(
    '<plain-box class="box" role="img" aria-label="Box" data-row="2"></plain-box>'
  );
  // @ts-expect-error ownsChildren elements need an id
  void CustomTag({ of: rating, value: 3 });
  // @ts-expect-error The value attribute is a number.
  void CustomTag({ of: plain, value: "x" });
  // @ts-expect-error The element declares no attribute "size".
  void CustomTag({ of: plain, size: 1 });
});

const list = customElement("todo-list", {
  attributes: {
    items: json<string[]>(),
    label: json<string>(),
    empty: json<null>(),
  },
});

it("writes JSON attributes with JSON.stringify, strings and null included", async () => {
  expect(
    String(
      await CustomTag({ of: list, items: ["a"], label: "abc", empty: null })
    )
  ).toBe(
    '<todo-list items="[&quot;a&quot;]" label="&quot;abc&quot;" empty="null"></todo-list>'
  );
  // @ts-expect-error The items attribute is a list of strings.
  void CustomTag({ of: list, items: [1] });
});

it("binds JSON attributes in the same format and names them for the runtime", async () => {
  const todos = signals(
    { items: ["a"], label: "abc" },
    { name: "todo-json" }
  ).with({});
  const bound = todos.bindElement(list, {
    items: todos.items,
    label: todos.label,
    empty: null,
  });
  // The string keys are the attributes; a symbol key carries the same text for
  // CustomTag and is never rendered.
  expect(Object.fromEntries(Object.entries(bound))).toEqual({
    items: '["a"]',
    label: '"abc"',
    empty: "null",
    "data-hs-element-attr": JSON.stringify({
      items: ["sig", ["todo-json-1", "items"]],
      label: ["sig", ["todo-json-1", "label"]],
      empty: ["lit", null],
    }),
    "data-hs-element-json": JSON.stringify(["items", "label", "empty"]),
  });
  expect(
    Object.fromEntries(
      Object.entries(todos.bindElement(list, { items: todos.items }))
    )
  ).toEqual({
    items: '["a"]',
    "data-hs-element-attr": JSON.stringify({
      items: ["sig", ["todo-json-1", "items"]],
    }),
    "data-hs-element-json": JSON.stringify(["items"]),
  });
  // CustomTag keeps the values bindElement already wrote as JSON.
  expect(
    String(
      await CustomTag({
        of: list,
        ...todos.bindElement(list, { items: todos.items }),
      })
    )
  ).toContain('items="[&quot;a&quot;]"');
  // @ts-expect-error The items attribute is a list of strings, not a string.
  todos.bindElement(list, { items: todos.label });
});

it("rejects a tag that is not a custom element name", () => {
  // @ts-expect-error A custom element name needs a hyphen.
  expect(() => customElement("rating")).toThrow("rating");
  // @ts-expect-error A custom element name cannot hold an uppercase letter.
  expect(() => customElement("star-Rating")).toThrow("star-Rating");
  // TypeScript cannot check every character, so this one fails when called.
  expect(() => customElement("star-rating!")).toThrow("star-rating!");
});

it("binds declared attributes from a scope", () => {
  const scores = signals({ score: 3, locked: false }, { name: "rating-score" });
  const e = scores.with({});
  expect(e.bindElement(rating, { value: e.score, max: 5 })).toEqual({
    value: "3",
    max: "5",
    "data-hs-element-attr": JSON.stringify({
      value: ["sig", ["rating-score-1", "score"]],
      max: ["lit", 5],
    }),
  });

  const locked = scores.with({ locked: true });
  expect(
    locked.bindElement(rating, {
      readonly: locked.locked,
      label: locked.score.gt(2).choose("good", "bad"),
    })
  ).toEqual({
    readonly: "",
    label: "good",
    "data-hs-element-attr": JSON.stringify({
      readonly: ["sig", ["rating-score-1", "locked"]],
      label: [
        "if",
        ["gt", ["sig", ["rating-score-1", "score"]], ["lit", 2]],
        ["lit", "good"],
        ["lit", "bad"],
      ],
    }),
  });
  expect(e.bindElement(rating, { readonly: e.locked })).toEqual({
    "data-hs-element-attr": JSON.stringify({
      readonly: ["sig", ["rating-score-1", "locked"]],
    }),
  });

  // @ts-expect-error The element declares no attribute "size".
  e.bindElement(rating, { size: 1 });
  // @ts-expect-error The value attribute is a number.
  e.bindElement(rating, { value: "x" });
  // @ts-expect-error The value attribute is a number, not a string expression.
  e.bindElement(rating, { value: e.score.gt(1).choose("a", "b") });
});

it("serializes custom event handlers", () => {
  const scores = signals({ score: 0 }, { name: "rating-event" });
  expect(rating.on("rate", (detail) => scores.score.set(detail))).toEqual({
    "data-hs-on-custom": JSON.stringify([
      ["rate", [["set", ["rating-event-1", "score"], ["detail"]]]],
    ]),
  });
  expect(
    rating.on({
      rate: (detail) => [scores.score.set(detail)],
      "hover:star": (detail) => scores.score.set(detail.get("star")),
    })
  ).toEqual({
    "data-hs-on-custom": JSON.stringify([
      ["rate", [["set", ["rating-event-1", "score"], ["detail"]]]],
      [
        "hover:star",
        [["set", ["rating-event-1", "score"], ["get", ["detail"], "star"]]],
      ],
    ]),
  });
  // @ts-expect-error The element dispatches no "select" event.
  rating.on("select", () => []);
  // @ts-expect-error The rate detail is a number, not a string.
  rating.on("rate", (detail) => signals({ s: "" }).s.set(detail));
});

it("checks declared attribute and event names", () => {
  expect(() =>
    customElement(
      // @ts-expect-error An attribute name cannot start with "on".
      "bad-attr",
      { attributes: { onrate: "number" } }
    )
  ).toThrow("onrate");
  expect(() =>
    customElement(
      // @ts-expect-error An event name must be lowercase.
      "bad-event",
      { events: { Rate: event<number>() } }
    )
  ).toThrow("Rate");
  expect(() =>
    customElement(
      // @ts-expect-error A declared attribute cannot be id.
      "id-box",
      { attributes: { id: "string", size: "number" } }
    )
  ).toThrow("id");
  expect(() =>
    customElement(
      // @ts-expect-error An attribute kind is string, number, boolean or json.
      "kind-box",
      { attributes: { size: "integer" } }
    )
  ).toThrow("integer");
  expect(() =>
    customElement(
      // @ts-expect-error A data-* attribute cannot be json.
      "data-json-box",
      { attributes: { "data-items": json<string[]>() } }
    )
  ).toThrow("data-items");
  expect(() =>
    customElement(
      // @ts-expect-error A data-* attribute cannot be json, even untyped.
      "data-any-box",
      { attributes: { "data-any": "json" } }
    )
  ).toThrow("data-any");
});

it("leaves out handlers passed as undefined", () => {
  expect(rating.on({ rate: undefined })).toEqual({ "data-hs-on-custom": "[]" });
});

it("renders shadow part attributes", async () => {
  expect(
    String(await CustomTag({ of: plain, part: "box", exportparts: "star" }))
  ).toBe('<plain-box part="box" exportparts="star"></plain-box>');
});

const box = customElement("x-box", {
  attributes: { compact: "boolean", size: "number" },
});

it("renders a declared boolean attribute empty when true and leaves it out when false", async () => {
  expect(String(await CustomTag({ of: box, compact: true }))).toBe(
    '<x-box compact=""></x-box>'
  );
  expect(String(await CustomTag({ of: box, compact: false, size: 2 }))).toBe(
    '<x-box size="2"></x-box>'
  );

  const flags = signals({ on: true }, { name: "box-compact" });
  const shown = flags.with({});
  const bound = shown.bindElement(box, { compact: shown.on });
  expect(String(await CustomTag({ of: box, ...bound }))).toBe(
    `<x-box compact="" data-hs-element-attr="${JSON.stringify({
      compact: ["sig", ["box-compact-1", "on"]],
    }).replaceAll('"', "&quot;")}"></x-box>`
  );
  const hidden = flags.with({ on: false });
  expect(
    String(
      await CustomTag({
        of: box,
        ...hidden.bindElement(box, { compact: hidden.on }),
      })
    )
  ).not.toContain("compact=");
});

it("rejects the event names the runtime delegates", () => {
  for (const name of ["click", "input", "change", "submit"] as const) {
    expect(() =>
      customElement(
        // @ts-expect-error A custom event cannot take a name the runtime delegates.
        "delegated-event",
        { events: { [name]: event<number>() } }
      )
    ).toThrow(name);
  }
});

it("rejects the reserved custom element names", () => {
  // The type accepts these names, so they fail when called.
  expect(() => customElement("font-face")).toThrow("font-face");
  expect(() => customElement("annotation-xml")).toThrow("annotation-xml");
  expect(() => customElement("missing-glyph")).toThrow("missing-glyph");
});

it("does not bind id through bindElement", () => {
  const scope = signals({ name: "a" }, { name: "box-id" }).with({});
  expect(() =>
    // @ts-expect-error bindElement takes no id.
    scope.bindElement(box, { id: scope.name, size: 1 })
  ).toThrow("id");
});

const flagged = customElement("flag-box", {
  attributes: {
    "data-open": "boolean",
    "aria-checked": "boolean",
    open: "boolean",
    draggable: "boolean",
  },
});

it("renders a data-* or aria-* boolean as true or false text on every path", async () => {
  expect(
    String(
      await CustomTag({
        of: flagged,
        "data-open": true,
        "aria-checked": false,
        open: false,
      })
    )
  ).toBe('<flag-box data-open="true" aria-checked="false"></flag-box>');

  const flags = signals(
    { open: true, checked: false },
    { name: "flag-text" }
  ).with({});
  expect(
    flags.bindElement(flagged, {
      "data-open": flags.open,
      "aria-checked": flags.checked,
      open: flags.checked,
      draggable: flags.checked,
    })
  ).toEqual({
    "data-open": "true",
    "aria-checked": "false",
    draggable: "false",
    "data-hs-element-attr": JSON.stringify({
      "data-open": ["sig", ["flag-text-1", "open"]],
      "aria-checked": ["sig", ["flag-text-1", "checked"]],
      open: ["sig", ["flag-text-1", "checked"]],
      draggable: ["sig", ["flag-text-1", "checked"]],
    }),
  });
});

it("encodes a JSON prop written after or before bindElement for the same name", async () => {
  const todos = signals({ items: ["a"] }, { name: "todo-order" }).with({});
  const bound = todos.bindElement(list, { items: todos.items });
  expect(
    String(await CustomTag({ of: list, ...bound, items: ["b", "c"] }))
  ).toContain('items="[&quot;b&quot;,&quot;c&quot;]"');
  expect(
    String(await CustomTag({ of: list, items: ["b", "c"], ...bound }))
  ).toContain('items="[&quot;a&quot;]"');
});

it("encodes a JSON string prop written after bindElement for the same name", async () => {
  const titled = customElement("titled-card", {
    attributes: { label: json<string>() },
  });
  const card = signals({ label: "a" }, { name: "card-label" }).with({});
  const bound = card.bindElement(titled, { label: card.label });
  expect(
    String(await CustomTag({ of: titled, ...bound, label: "abc" }))
  ).toContain('label="&quot;abc&quot;"');
  expect(
    String(await CustomTag({ of: titled, label: "abc", ...bound }))
  ).toContain('label="&quot;a&quot;"');
  expect(
    String(
      await CustomTag({
        of: titled,
        label: "true",
        "data-hs-element-json": JSON.stringify(["label"]),
      })
    )
  ).toContain('label="&quot;true&quot;"');
});

it("encodes a JSON value that a hand-written data-hs-element-json names", async () => {
  const board = customElement("json-board", {
    attributes: { config: json<{ size: number }>() },
  });
  expect(
    String(
      await CustomTag({
        of: board,
        config: { size: 2 },
        "data-hs-element-json": JSON.stringify(["config"]),
      })
    )
  ).toContain('config="{&quot;size&quot;:2}"');
});

it("ignores a data-hs-element-json that is not JSON", async () => {
  expect(
    String(
      await CustomTag({
        of: list,
        items: ["a"],
        "data-hs-element-json": "[items",
      })
    )
  ).toContain('items="[&quot;a&quot;]"');
});

it("takes read-only arrays for JSON attributes", async () => {
  const items: readonly string[] = ["a"];
  expect(String(await CustomTag({ of: list, items }))).toContain(
    'items="[&quot;a&quot;]"'
  );
  const nested = customElement("nested-board", {
    attributes: { rows: json<{ cells: number[] }[]>() },
  });
  const rows: readonly { readonly cells: readonly number[] }[] = [
    { cells: [1] },
  ];
  expect(String(await CustomTag({ of: nested, rows }))).toContain(
    'rows="[{&quot;cells&quot;:[1]}]"'
  );
  // @ts-expect-error The items attribute is a list of strings, not numbers.
  void CustomTag({ of: list, items: [1] as readonly number[] });
});

it("exports the element types from hypersig.ts as from hypersig.ts/element", () => {
  type Declared = typeof rating;
  expectTypeOf<packageEntry.EventName<Declared>>().toEqualTypeOf<
    elementEntry.EventName<Declared>
  >();
  expectTypeOf<packageEntry.Emit<Declared>>().toEqualTypeOf<
    elementEntry.Emit<Declared>
  >();
  expectTypeOf<packageEntry.ElementImplementation<Declared>>().toEqualTypeOf<
    elementEntry.ElementImplementation<Declared>
  >();
  expectTypeOf<packageEntry.MountedElement<Declared>>().toEqualTypeOf<
    elementEntry.MountedElement<Declared>
  >();
  expectTypeOf<packageEntry.EventDetail<Declared, "rate">>().toEqualTypeOf<
    elementEntry.EventDetail<Declared, "rate">
  >();
});
