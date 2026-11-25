/** @jsxImportSource react */
import { act, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, it } from "vite-plus/test";
import { customElement, event, json } from "./element.js";
import type { Emit } from "./element.js";
import { reactElement } from "./react.js";

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
  });
});

const list = customElement("react-list", {
  attributes: { items: json<string[]>(), title: "string" },
  events: { pick: event<string>() },
  ownsChildren: true,
});

const log: string[] = [];

function List({
  items = [],
  title = "",
  emit,
}: {
  items?: string[];
  title?: string;
  emit: Emit<typeof list>;
}): ReactNode {
  const [renders, setRenders] = useState(0);
  useEffect(() => {
    log.push("effect");
    return () => {
      log.push("cleanup");
    };
  }, []);
  return (
    <div>
      <h2>{title}</h2>
      <p data-renders={renders}>{items.join(",")}</p>
      <button
        type="button"
        onClick={() => {
          setRenders((count) => count + 1);
          emit("pick", items[0] ?? "");
        }}
      >
        pick
      </button>
    </div>
  );
}

reactElement(list, List);

async function insert(attributes: Record<string, string>) {
  const element = document.createElement("react-list");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  await act(async () => {
    document.body.append(element);
  });
  return element;
}

it("renders the component when the element is inserted", async () => {
  const element = await insert({ items: '["a","b"]', title: "T" });
  expect(element.querySelector("h2")?.textContent).toBe("T");
  expect(element.querySelector("p")?.textContent).toBe("a,b");
});

it("renders again into the same root when an attribute changes", async () => {
  const element = await insert({ items: '["a"]' });
  await act(async () => {
    element.querySelector("button")?.click();
  });
  expect(element.querySelector("p")?.getAttribute("data-renders")).toBe("1");
  await act(async () => {
    element.setAttribute("items", '["x","y"]');
  });
  expect(element.querySelector("p")?.textContent).toBe("x,y");
  expect(element.querySelector("p")?.getAttribute("data-renders")).toBe("1");
});

it("unmounts the root when the element is removed", async () => {
  log.length = 0;
  const element = await insert({});
  expect(log).toEqual(["effect"]);
  await act(async () => {
    element.remove();
  });
  expect(log).toEqual(["effect", "cleanup"]);
  expect(element.childElementCount).toBe(0);
});

it("mounts a fresh root when a removed element is inserted again", async () => {
  log.length = 0;
  const element = await insert({ items: '["a"]' });
  await act(async () => {
    element.querySelector("button")?.click();
  });
  expect(element.querySelector("p")?.getAttribute("data-renders")).toBe("1");
  await act(async () => {
    element.remove();
  });
  await act(async () => {
    document.body.append(element);
  });
  expect(log).toEqual(["effect", "cleanup", "effect"]);
  expect(element.querySelector("p")?.textContent).toBe("a");
  expect(element.querySelector("p")?.getAttribute("data-renders")).toBe("0");
});

it("delivers emit to the element's listener", async () => {
  const element = await insert({ items: '["first"]' });
  const details: unknown[] = [];
  element.addEventListener("pick", (received) => {
    if (received instanceof CustomEvent) details.push(received.detail);
  });
  await act(async () => {
    element.querySelector("button")?.click();
  });
  expect(details).toEqual(["first"]);
});

it("rejects declarations and components that do not fit", () => {
  const plain = customElement("react-plain", {
    attributes: { count: "number" },
  });
  function Plain(_props: { count?: number; emit: Emit<typeof plain> }) {
    return null;
  }
  // @ts-expect-error a declaration without ownsChildren is rejected because React renders the children
  reactElement(plain, Plain);

  const owned = customElement("react-owned", {
    attributes: { count: "number" },
    ownsChildren: true,
  });
  function WrongProp(_props: { count?: string; emit: Emit<typeof owned> }) {
    return null;
  }
  // @ts-expect-error the component's count prop is a string but the declaration says number
  reactElement(owned, WrongProp);
  function RightProp(_props: { count?: number; emit: Emit<typeof owned> }) {
    return null;
  }
  expect(RightProp).toBeTypeOf("function");
});
