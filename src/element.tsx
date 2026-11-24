import type { Child, JSX } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  CustomTagName,
  IsCustomAttributeName,
  IsCustomEventName,
} from "./identifier.js";
import type { JsonValue, StmtNode } from "./protocol.js";
import {
  customElementAttributes,
  isCustomElementName,
  isCustomEventName,
} from "./protocol.js";
import type { Expr } from "./signal.js";
import { exprOf, listStmts } from "./signal.js";

/**
 * Describes the attributes a custom element reads and the events it
 * dispatches. hypersig.ts cannot compare this with the element's JavaScript:
 * an event the script never dispatches runs nothing, and a `detail` of another
 * shape reaches the statements as it is (`null` when it is not JSON).
 */
export interface CustomElementSpec {
  attributes: Record<string, string | number | boolean>;
  events: Record<string, JsonValue>;
}

type Statements = StmtNode | readonly StmtNode[];

type EventHandler<Detail extends JsonValue> = (
  detail: Expr<Detail>
) => Statements;

type EventHandlers<Spec extends CustomElementSpec> = {
  readonly [Name in keyof Spec["events"] & string]?:
    | EventHandler<Spec["events"][Name]>
    | undefined;
};

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

/**
 * The props of `Element`: the HTML attributes Hono JSX names, `role`, `part`,
 * `exportparts`, `aria-*`, `data-*`, `children`, and the declared attributes as fixed values.
 * Bind a declared attribute to a signal with `scope.bindElement` instead, and
 * do not write the same attribute both ways: the later prop wins.
 */
export type ElementProps<Spec extends CustomElementSpec> = Partial<
  Spec["attributes"]
> &
  Omit<NamedHtmlAttributes, keyof Spec["attributes"]> & {
    role?: string;
    part?: string;
    exportparts?: string;
    children?: Child;
    [attribute: `aria-${string}`]: string | number | boolean | undefined;
    [attribute: `data-${string}`]: string | number | boolean | undefined;
  };

export interface CustomElement<Spec extends CustomElementSpec> {
  readonly tag: string;
  /** Whether the element's JavaScript renders its children. */
  readonly ownsChildren: boolean;
  /** Renders the element with the declared tag name. */
  Element: (
    props: ElementProps<Spec>
  ) => HtmlEscapedString | Promise<HtmlEscapedString>;
  /**
   * Runs the statements when the element dispatches the event, with `detail`
   * standing for the event's `detail`. To handle several events on one
   * element, pass them in one object: spreading two results keeps only the
   * later one. A handler left `undefined` adds nothing.
   */
  on<Name extends keyof Spec["events"] & string>(
    event: Name,
    handler: EventHandler<Spec["events"][Name]>
  ): { [customElementAttributes.onCustom]: string };
  on(handlers: EventHandlers<Spec>): {
    [customElementAttributes.onCustom]: string;
  };
}

type InvalidAttributeName<Spec extends CustomElementSpec> = {
  [
    K in keyof Spec["attributes"] & string
  ]: IsCustomAttributeName<K> extends true ? never : K;
}[keyof Spec["attributes"] & string];

type InvalidEventName<Spec extends CustomElementSpec> = {
  [K in keyof Spec["events"] & string]: IsCustomEventName<K> extends true
    ? never
    : K;
}[keyof Spec["events"] & string];

/**
 * Resolves to a message type naming the first rule a declaration breaks, so
 * the tag argument shows the error.
 */
type CheckedTagName<Spec extends CustomElementSpec> = [
  InvalidAttributeName<Spec>,
] extends [never]
  ? [InvalidEventName<Spec>] extends [never]
    ? CustomTagName
    : `Event "${InvalidEventName<Spec>}" needs a lowercase letter followed by lowercase letters, digits, -, ., : or _`
  : `Attribute "${InvalidAttributeName<Spec>}" needs a lowercase name that is not on*, style or data-hs-*`;

type HandlerEntry = [string, EventHandler<JsonValue> | undefined];

function serializeHandlers(entries: readonly HandlerEntry[]): string {
  const detail = exprOf<JsonValue>(["detail"]);
  const pairs: [string, StmtNode[]][] = [];
  for (const [event, handler] of entries) {
    if (handler === undefined) continue;
    if (!isCustomEventName(event)) {
      throw new TypeError(`Custom event name "${event}" is not valid`);
    }
    pairs.push([event, listStmts(handler(detail))]);
  }
  return JSON.stringify(pairs);
}

/**
 * Declares a custom element whose JavaScript the application loads. The tag
 * name starts with a lowercase letter, holds a `-`, and has only lowercase
 * letters, digits, `-`, `.` and `_`; characters other than letters are checked
 * when this is called. With `ownsChildren`, the element's JavaScript renders
 * its children, and a Live View update keeps them while it updates the
 * element's attributes.
 */
export function customElement<
  Spec extends CustomElementSpec = { attributes: {}; events: {} },
>(
  tag: CheckedTagName<Spec>,
  options?: { ownsChildren?: boolean }
): CustomElement<Spec>;
export function customElement(
  tag: string,
  options?: { ownsChildren?: boolean }
): CustomElement<CustomElementSpec> {
  if (!isCustomElementName(tag)) {
    throw new TypeError(`Custom element name "${tag}" is not valid`);
  }
  const ownsChildren = options?.ownsChildren ?? false;
  const marker = ownsChildren
    ? { [customElementAttributes.ownsChildren]: "" }
    : {};
  const Tag = tag;
  return {
    tag,
    ownsChildren,
    Element: (props) => <Tag {...props} {...marker} />,
    on: (
      eventOrHandlers:
        | string
        | Readonly<Record<string, EventHandler<JsonValue> | undefined>>,
      handler?: EventHandler<JsonValue>
    ) => ({
      [customElementAttributes.onCustom]: serializeHandlers(
        typeof eventOrHandlers === "string"
          ? [[eventOrHandlers, handler]]
          : Object.entries(eventOrHandlers)
      ),
    }),
  };
}
