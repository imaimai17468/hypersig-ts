import type { Child, JSX } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AnyCustomElement, AttributeValues } from "./element.js";
import {
  customElementAttributes,
  formatJsonAttribute,
  isJsonValue,
  rendersBooleanAsText,
} from "./protocol.js";

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
 * A `json` attribute renders with `JSON.stringify`. For the other kinds, a
 * `true` value renders the attribute empty and `false` leaves it out, except
 * for `aria-*`, `data-*`, `draggable`, `spellcheck` and `contenteditable`,
 * whose booleans render as `"true"` or `"false"`.
 * Bind a declared attribute to a signal with `scope.bindElement` instead, and
 * do not write the same attribute both ways: the later prop wins.
 */
export type TagProps<E extends AnyCustomElement> = Partial<AttributeValues<E>> &
  Omit<NamedHtmlAttributes, keyof AttributeValues<E>> & {
    role?: string;
    part?: string;
    exportparts?: string;
    children?: Child;
    [attribute: `aria-${string}`]: string | number | boolean | undefined;
    [attribute: `data-${string}`]: string | number | boolean | undefined;
  } & OwnedChildrenProps<E>;

/** The `json` attributes that `bindElement` already wrote in `props`. */
function readBoundJsonNames(
  props: Readonly<Record<string, unknown>>
): ReadonlySet<string> {
  const text = props[customElementAttributes.elementJson];
  if (typeof text !== "string") return new Set();
  const names: unknown = JSON.parse(text);
  return new Set(
    Array.isArray(names) ? names.filter((name) => typeof name === "string") : []
  );
}

/**
 * Writes `json` attributes with `JSON.stringify`. Hono renders `true` as
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
    if (
      Object.hasOwn(element.attributes, name) &&
      element.attributes[name] === "json" &&
      !boundJson.has(name)
    ) {
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
