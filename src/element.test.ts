import { expect, it } from "vite-plus/test";
import { customElement, signals } from "./index.js";

const rating = customElement<{
  attributes: { value: number; max: number; label: string; readonly: boolean };
  events: { rate: number; "hover:star": { star: number } };
}>("star-rating", { ownsChildren: true });

const plain = customElement<{
  attributes: { value: number };
  events: Record<never, never>;
}>("plain-box");

it("declares a custom element and renders its tag", async () => {
  expect(rating.tag).toBe("star-rating");
  expect(rating.ownsChildren).toBe(true);
  expect(String(await rating.Element({ id: "r", max: 5 }))).toContain(
    '<star-rating id="r" max="5" data-hs-owns-children="">'
  );
  expect(String(await plain.Element({ value: 1, children: "x" }))).toBe(
    '<plain-box value="1">x</plain-box>'
  );
  expect(plain.ownsChildren).toBe(false);
  expect(
    String(
      await plain.Element({
        class: "box",
        role: "img",
        "aria-label": "Box",
        "data-row": 2,
      })
    )
  ).toBe(
    '<plain-box class="box" role="img" aria-label="Box" data-row="2"></plain-box>'
  );
  // @ts-expect-error The value attribute is a number.
  void plain.Element({ value: "x" });
  // @ts-expect-error The element declares no attribute "size".
  void plain.Element({ size: 1 });
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
  const handlerAttribute = customElement<{
    attributes: { onrate: number };
    events: {};
  }>(
    // @ts-expect-error An attribute name cannot start with "on".
    "bad-attr"
  );
  // The declaration exists only as a type, so binding checks the name.
  expect(() =>
    signals({ n: 0 }).with({}).bindElement(handlerAttribute, { onrate: 1 })
  ).toThrow("onrate");
  const uppercaseEvent = customElement<{
    attributes: {};
    events: { Rate: number };
  }>(
    // @ts-expect-error An event name must be lowercase.
    "bad-event"
  );
  // The declaration exists only as a type, so serializing checks the name.
  expect(() => uppercaseEvent.on("Rate", () => [])).toThrow("Rate");
});

it("leaves out handlers passed as undefined", () => {
  expect(rating.on({ rate: undefined })).toEqual({ "data-hs-on-custom": "[]" });
});

it("renders shadow part attributes", async () => {
  expect(
    String(await plain.Element({ part: "box", exportparts: "star" }))
  ).toBe('<plain-box part="box" exportparts="star"></plain-box>');
});

const box = customElement<{
  attributes: { compact: boolean; size: number };
  events: Record<never, never>;
}>("x-box");

it("renders a declared boolean attribute empty when true and leaves it out when false", async () => {
  expect(String(await box.Element({ compact: true }))).toBe(
    '<x-box compact=""></x-box>'
  );
  expect(String(await box.Element({ compact: false, size: 2 }))).toBe(
    '<x-box size="2"></x-box>'
  );

  const flags = signals({ on: true }, { name: "box-compact" });
  const shown = flags.with({});
  const bound = shown.bindElement(box, { compact: shown.on });
  expect(String(await box.Element(bound))).toBe(
    `<x-box compact="" data-hs-element-attr="${JSON.stringify({
      compact: ["sig", ["box-compact-1", "on"]],
    }).replaceAll('"', "&quot;")}"></x-box>`
  );
  const hidden = flags.with({ on: false });
  expect(
    String(await box.Element(hidden.bindElement(box, { compact: hidden.on })))
  ).not.toContain("compact=");
});

it("rejects the event names the runtime delegates", () => {
  for (const name of ["click", "input", "change", "submit"] as const) {
    const delegated = customElement<{
      attributes: {};
      events: Record<typeof name, number>;
    }>(
      // @ts-expect-error A custom event cannot take a name the runtime delegates.
      "delegated-event"
    );
    expect(() => delegated.on(name, () => [])).toThrow(name);
  }
});

it("rejects the reserved custom element names", () => {
  // The type accepts these names, so they fail when called.
  expect(() => customElement("font-face")).toThrow("font-face");
  expect(() => customElement("annotation-xml")).toThrow("annotation-xml");
  expect(() => customElement("missing-glyph")).toThrow("missing-glyph");
});

it("does not bind id through bindElement", () => {
  const withId = customElement<{
    attributes: { id: string; size: number };
    events: {};
  }>(
    // @ts-expect-error A declared attribute cannot be id.
    "id-box"
  );
  const scope = signals({ name: "a" }, { name: "box-id" }).with({});
  expect(() =>
    // @ts-expect-error bindElement takes no id even when the spec declares it.
    scope.bindElement(withId, { id: scope.name, size: 1 })
  ).toThrow("id");
});

const flagged = customElement<{
  attributes: {
    "data-open": boolean;
    "aria-checked": boolean;
    open: boolean;
    draggable: boolean;
  };
  events: Record<never, never>;
}>("flag-box");

it("renders a data-* or aria-* boolean as true or false text on every path", async () => {
  expect(
    String(
      await flagged.Element({
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
