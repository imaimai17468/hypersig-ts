// The automatic JSX runtime that `<button {...props} />` compiles to.
import { jsx } from "hono/jsx/jsx-runtime";
import { expect, it } from "vite-plus/test";
import { refs } from "./index.js";
import { sanitizeFragment } from "./sanitize.js";

const serialize = (fragment: DocumentFragment) => {
  const container = document.createElement("div");
  container.append(fragment);
  return container;
};

it("keeps custom elements and their safe attributes", () => {
  const container = serialize(
    sanitizeFragment(
      `<star-rating value="3" onclick="x()" style="color:red" data-hs-stream="/s" data-hs-on-custom="[]" data-hs-element-json="[]"></star-rating>`
    )
  );
  const element = container.querySelector("star-rating");

  expect(element).not.toBeNull();
  expect(element?.getAttribute("value")).toBe("3");
  expect(element?.getAttribute("data-hs-on-custom")).toBe("[]");
  expect(element?.getAttribute("data-hs-element-json")).toBe("[]");
  expect(element?.hasAttribute("onclick")).toBe(false);
  expect(element?.hasAttribute("style")).toBe(false);
  expect(element?.hasAttribute("data-hs-stream")).toBe(false);
});

it("checks custom element attribute names beyond the default allowlist", () => {
  const container = serialize(
    sanitizeFragment(`<star-rating stars-max="5" onrate="x()"></star-rating>`)
  );
  const element = container.querySelector("star-rating");

  expect(element?.getAttribute("stars-max")).toBe("5");
  expect(element?.hasAttribute("onrate")).toBe(false);
});

it("does not admit customized built-in elements", () => {
  const container = serialize(
    sanitizeFragment(`<div is="x-y">text</div><p>kept</p>`)
  );

  // DOMPurify removes an element whose `is` it rejects when it returns a
  // fragment.
  expect(container.querySelector("[is]")).toBeNull();
  expect(container.querySelector("p")?.textContent).toBe("kept");
});

it("still removes scripts and templates", () => {
  const container = serialize(
    sanitizeFragment(
      `<script>x()</script><template><p>t</p></template><p>kept</p>`
    )
  );

  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("template")).toBeNull();
  expect(container.querySelector("p")?.textContent).toBe("kept");
});

it("keeps a keyed ref whose key holds markup, quotes and spaces", () => {
  const key = `<b> "a" 'b' & c`;
  const attrs = refs({ name: "sanitized-row" }).attr(key);
  const value = attrs["data-hs-ref"];
  const container = serialize(sanitizeFragment(String(jsx("button", attrs))));

  expect(container.querySelector("button")?.getAttribute("data-hs-ref")).toBe(
    value
  );
});
