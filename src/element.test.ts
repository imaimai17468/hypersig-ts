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
    readonly: true,
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
  // @ts-expect-error The element dispatches no "change" event.
  rating.on("change", () => []);
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
