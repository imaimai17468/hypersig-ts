import type { Child, JSX } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AnyCustomElement, AttributeValues } from "./element.js";
import {
  customElementAttributes,
  formatJsonAttribute,
  isJsonValue,
  rendersBooleanAsText,
} from "./protocol.js";
import type { ReadonlyJson } from "./signal.js";

/** Hono JSX lets an element take any attribute; this keeps the named ones. */
type NamedHtmlAttributes = {
  [
    K in keyof JSX.IntrinsicElements["div"] as string extends K
      ? never
      : number extends K
        ? never
        : K
  ]: JSX.IntrinsicElements["div"][K];
};

/** An element whose JavaScript renders its children is kept by its `id`. */
type OwnedChildrenProps<E extends AnyCustomElement> =
  E["ownsChildren"] extends false ? unknown : { id: string };

/**
 * The props `CustomTag` takes besides `of`: the HTML attributes Hono JSX
 * names, `role`, `part`, `exportparts`, `aria-*`, `data-*`, `children`, and
 * the declared attributes as fixed values. An element declared with
 * `ownsChildren` needs an `id`: a Live View update keeps its children only
 * when the tag and `id` match.
 * A `json` attribute takes its value type, read-only arrays included, and
 * renders with `JSON.stringify`. A value that is not JSON, such as `NaN` or
 * one nested more than 64 levels deep, throws a `TypeError`. For the other
 * kinds, a `true` value renders the attribute empty and `false` leaves it
 * out, except for `aria-*`, `data-*`, `draggable`, `spellcheck` and
 * `contenteditable`, whose booleans render as `"true"` or `"false"`.
 * Bind a declared attribute to a signal with `scope.bindElement` instead.
 * When a prop and `bindElement` write the same attribute, the later one wins;
 * a `json` attribute named in `data-hs-element-json` takes a string as text
 * `bindElement` already encoded, so give the prop a value other than a string.
 */
export type TagProps<E extends AnyCustomElement> = {
  [Name in keyof AttributeValues<E>]?: ReadonlyJson<AttributeValues<E>[Name]>;
} & Omit<NamedHtmlAttributes, keyof AttributeValues<E>> & {
    role?: string;
    part?: string;
    exportparts?: string;
    children?: Child;
    [attribute: `aria-${string}`]: string | number | boolean | undefined;
    [attribute: `data-${string}`]: string | number | boolean | undefined;
  } & OwnedChildrenProps<E>;

/**
 * The `json` attributes that `bindElement` already wrote in `props`. Text
 * that is not a JSON list names none.
 */
function readBoundJsonNames(
  props: Readonly<Record<string, unknown>>
): ReadonlySet<string> {
  const text = props[customElementAttributes.elementJson];
  if (typeof text !== "string") return new Set();
  let names: unknown;
  try {
    names = JSON.parse(text);
  } catch {
    return new Set();
  }
  return new Set(
    Array.isArray(names) ? names.filter((name) => typeof name === "string") : []
  );
}

/**
 * Writes `json` attributes with `JSON.stringify`, except a string under a
 * name `bindElement` marked, which it already wrote. Hono renders `true` as
 * `"true"` for attribute names outside its own list, so another boolean
 * becomes an empty value or no attribute here.
 */
function renderProps(
  element: AnyCustomElement,
  props: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const boundJson = readBoundJsonNames(props);
  const rendered: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    const isJson =
      Object.hasOwn(element.attributes, name) &&
      element.attributes[name] === "json";
    const isEncoded = boundJson.has(name) && typeof value === "string";
    if (isJson && !isEncoded) {
      if (value !== undefined) rendered[name] = renderJson(name, value);
    } else if (typeof value !== "boolean" || rendersBooleanAsText(name)) {
      rendered[name] = value;
    } else if (value) rendered[name] = "";
  }
  return rendered;
}

function renderJson(name: string, value: unknown): string {
  if (!isJsonValue(value)) {
    throw new TypeError(`Attribute "${name}" holds a value that is not JSON`);
  }
  return formatJsonAttribute(value);
}

/**
 * Renders the custom element `of` declares, with its tag name. An element
 * declared with `ownsChildren` gets `data-hs-owns-children`.
 */
export function CustomTag<E extends AnyCustomElement>(
  props: { of: E } & NoInfer<TagProps<E>>
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const { of: element, ...rest } = props;
  const marker = element.ownsChildren
    ? { [customElementAttributes.ownsChildren]: "" }
    : {};
  const Tag = element.tag;
  return <Tag {...renderProps(element, rest)} {...marker} />;
}
