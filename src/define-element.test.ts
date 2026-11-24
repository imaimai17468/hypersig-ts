import { expect, expectTypeOf, it } from "vite-plus/test";
import type {
  AttributeValues,
  ElementImplementation,
  Emit,
} from "./element.js";
import { customElement, defineElement, event, json } from "./element.js";

type Item = { key: string; done: boolean };

/** Records what `defineElement` hands to the implementation. */
function recordCalls<E extends Parameters<typeof defineElement>[0]>(
  declaration: E
) {
  const calls: (
    | { call: "mount"; props: Partial<AttributeValues<E>> }
    | { call: "update"; props: Partial<AttributeValues<E>> }
    | { call: "unmount" }
  )[] = [];
  const hosts: HTMLElement[] = [];
  let emit: Emit<E> | undefined;
  defineElement(declaration, {
    mount(host, props, emitEvent) {
      hosts.push(host);
      emit = emitEvent;
      calls.push({ call: "mount", props });
      return {
        update(next) {
          calls.push({ call: "update", props: next });
        },
        unmount() {
          calls.push({ call: "unmount" });
        },
      };
    },
  });
  return {
    calls,
    hosts,
    emit(): Emit<E> {
      if (!emit) throw new Error("Not mounted");
      return emit;
    },
  };
}

function create(tag: string, attributes: Record<string, string> = {}) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

it("registers the declared tag once", () => {
  const declaration = customElement("once-box");
  defineElement(declaration, {
    mount: () => ({ update() {}, unmount() {} }),
  });
  expect(customElements.get("once-box")).toBeDefined();
  expect(() =>
    defineElement(declaration, {
      mount: () => ({ update() {}, unmount() {} }),
    })
  ).toThrow('Custom element "once-box" is already defined');
});

it("mounts with props read by each attribute's declared kind", () => {
  const declaration = customElement("props-box", {
    attributes: {
      value: "number",
      flag: "boolean",
      label: "string",
      items: json<Item[]>(),
      "aria-busy": "boolean",
      "data-open": "boolean",
    },
  });
  const { calls, hosts } = recordCalls(declaration);
  const element = create("props-box", {
    value: "3",
    flag: "",
    label: "Hi",
    items: JSON.stringify([{ key: "a", done: false }]),
    "aria-busy": "false",
    "data-open": "true",
  });
  document.body.append(element);
  expect(hosts).toEqual([element]);
  expect(calls).toEqual([
    {
      call: "mount",
      props: {
        value: 3,
        flag: true,
        label: "Hi",
        items: [{ key: "a", done: false }],
        "aria-busy": false,
        "data-open": true,
      },
    },
  ]);
  element.remove();
});

it("leaves out attributes that are missing or do not read as their kind", () => {
  const declaration = customElement("missing-box", {
    attributes: {
      value: "number",
      empty: "number",
      flag: "boolean",
      "data-open": "boolean",
      label: "string",
      items: json<Item[]>(),
    },
  });
  const { calls } = recordCalls(declaration);
  const element = create("missing-box", {
    value: "x",
    empty: "",
    "data-open": "yes",
    items: "[{",
  });
  document.body.append(element);
  expect(calls).toStrictEqual([{ call: "mount", props: {} }]);
  element.remove();
});

it("updates once with every attribute changed in the same task", async () => {
  const declaration = customElement("batch-box", {
    attributes: { value: "number", max: "number", other: "string" },
  });
  const { calls } = recordCalls(declaration);
  const element = create("batch-box", { value: "1", max: "5" });
  document.body.append(element);
  element.setAttribute("value", "2");
  element.setAttribute("max", "10");
  element.setAttribute("undeclared", "ignored");
  expect(calls).toHaveLength(1);
  await Promise.resolve();
  expect(calls).toEqual([
    { call: "mount", props: { value: 1, max: 5 } },
    { call: "update", props: { value: 2, max: 10 } },
  ]);

  element.setAttribute("undeclared", "again");
  // Writing the value an attribute already holds is not a change.
  element.setAttribute("value", "2");
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  element.remove();
});

it("unmounts on removal and mounts again on reinsertion", async () => {
  const declaration = customElement("cycle-box", {
    attributes: { value: "number" },
  });
  const { calls } = recordCalls(declaration);
  const element = create("cycle-box", { value: "1" });
  document.body.append(element);
  element.remove();
  expect(calls).toEqual([
    { call: "mount", props: { value: 1 } },
    { call: "unmount" },
  ]);

  // An attribute change while detached reaches the next mount, not update.
  element.setAttribute("value", "2");
  await Promise.resolve();
  document.body.append(element);
  expect(calls.slice(2)).toEqual([{ call: "mount", props: { value: 2 } }]);
  element.remove();
});

it("unmounts and mounts once each when moved in the same task", async () => {
  const declaration = customElement("move-box", {
    attributes: { value: "number" },
  });
  const { calls } = recordCalls(declaration);
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(first, second);
  const element = create("move-box", { value: "1" });
  first.append(element);
  // A change made before the move does not update the new mount.
  element.setAttribute("value", "2");
  second.append(element);
  await Promise.resolve();
  expect(calls).toEqual([
    { call: "mount", props: { value: 1 } },
    { call: "unmount" },
    { call: "mount", props: { value: 2 } },
  ]);
  first.remove();
  second.remove();
});

it("does not update after unmount", async () => {
  const declaration = customElement("gone-box", {
    attributes: { value: "number" },
  });
  const { calls } = recordCalls(declaration);
  const element = create("gone-box", { value: "1" });
  document.body.append(element);
  element.setAttribute("value", "2");
  element.remove();
  await Promise.resolve();
  expect(calls).toEqual([
    { call: "mount", props: { value: 1 } },
    { call: "unmount" },
  ]);
});

it("emits a non-bubbling CustomEvent with the detail", () => {
  const declaration = customElement("emit-box", {
    events: { rate: event<number>(), clear: event() },
  });
  const recorded = recordCalls(declaration);
  const parent = document.createElement("div");
  const element = create("emit-box");
  parent.append(element);
  document.body.append(parent);
  const dispatched: Event[] = [];
  const bubbled: Event[] = [];
  element.addEventListener("rate", (event) => dispatched.push(event));
  element.addEventListener("clear", (event) => dispatched.push(event));
  parent.addEventListener("rate", (event) => bubbled.push(event));

  recorded.emit()("rate", 2);
  recorded.emit()("clear", null);
  expect(dispatched).toHaveLength(2);
  expect(dispatched[0]).toBeInstanceOf(CustomEvent);
  expect(dispatched[0]).toMatchObject({ bubbles: false, detail: 2 });
  expect(dispatched[1]).toMatchObject({ bubbles: false, detail: null });
  expect(bubbled).toEqual([]);
  parent.remove();
});

it("checks props, event names and details against the declaration", () => {
  const declaration = customElement("typed-box", {
    attributes: { value: "number", items: json<Item[]>() },
    events: { rate: event<number>() },
  });
  type Mount = ElementImplementation<typeof declaration>["mount"];
  expectTypeOf<Parameters<Mount>[1]>().toEqualTypeOf<{
    value?: number;
    items?: Item[];
  }>();
  expectTypeOf<
    Parameters<Emit<typeof declaration>>[0]
  >().toEqualTypeOf<"rate">();

  const emit: Emit<typeof declaration> = () => {};
  emit("rate", 3);
  // @ts-expect-error The declaration has no event "clear".
  emit("clear", null);
  // @ts-expect-error The "rate" detail is a number.
  emit("rate", "3");
  const implementation: ElementImplementation<typeof declaration> = {
    mount(_host, props) {
      // @ts-expect-error The declaration has no attribute "size".
      void props.size;
      // @ts-expect-error A number attribute is not a string.
      const text: string | undefined = props.value;
      void text;
      return {
        update(next) {
          // @ts-expect-error A json attribute keeps its declared type.
          const keys: string[] | undefined = next.items;
          void keys;
        },
        unmount() {},
      };
    },
  };
  void implementation;
});
