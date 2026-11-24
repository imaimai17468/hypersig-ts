import type {
  CustomTagName,
  IsCustomAttributeName,
  IsCustomEventName,
} from "./identifier.js";
import type { JsonValue, StmtNode } from "./protocol.js";
import {
  customElementAttributes,
  isBindableCustomAttribute,
  isCustomElementName,
  isCustomEventName,
} from "./protocol.js";
import type { Expr } from "./signal.js";
import { exprOf, listStmts } from "./signal.js";

/** How an attribute's text maps to a value. */
export type AttributeKind = "string" | "number" | "boolean" | "json";

declare const jsonType: unique symbol;
declare const detailType: unique symbol;
declare const declaredTypes: unique symbol;

/** A `json` attribute whose value has the type `T`. */
export interface JsonAttribute<T extends JsonValue> {
  readonly kind: "json";
  /** Carries the value type. Never set at runtime. */
  readonly [jsonType]?: T;
}

/** An event whose `detail` has the type `Detail`. */
export interface EventSpec<Detail extends JsonValue> {
  readonly kind: "event";
  /** Carries the detail type. Never set at runtime. */
  readonly [detailType]?: Detail;
}

type AttributeSpec = AttributeKind | JsonAttribute<JsonValue>;

type AttributeSpecs = Record<string, AttributeSpec>;

type EventSpecs = Record<string, EventSpec<JsonValue>>;

/**
 * Declares a `json` attribute. Its value is written with `JSON.stringify`, so
 * a string renders as `"\"abc\""` and `null` as `"null"`.
 */
export function json<T extends JsonValue = JsonValue>(): JsonAttribute<T> {
  return { kind: "json" };
}

/**
 * Declares an event. Only its name is used at runtime. Without a type
 * argument, `detail` is `null` (`NoInfer` keeps the surrounding object from
 * choosing another type).
 */
export function event<Detail extends JsonValue = null>(): EventSpec<
  NoInfer<Detail>
> {
  return { kind: "event" };
}

type KindOf<Spec extends AttributeSpec> =
  Spec extends JsonAttribute<JsonValue> ? "json" : Spec;

type ValueOf<Spec extends AttributeSpec> =
  Spec extends JsonAttribute<infer T>
    ? T
    : Spec extends "string"
      ? string
      : Spec extends "number"
        ? number
        : Spec extends "boolean"
          ? boolean
          : JsonValue;

type DetailOf<Spec extends EventSpec<JsonValue>> =
  Spec extends EventSpec<infer Detail> ? Detail : never;

type Statements = StmtNode | readonly StmtNode[];

type EventHandler<Detail extends JsonValue> = (
  detail: Expr<Detail>
) => Statements;

type EventHandlers<Events extends EventSpecs> = {
  readonly [Name in keyof Events & string]?:
    | EventHandler<DetailOf<Events[Name]>>
    | undefined;
};

type CustomEventAttributes = { [customElementAttributes.onCustom]: string };

export interface CustomElement<
  Tag extends string,
  Attributes extends AttributeSpecs,
  Events extends EventSpecs,
  Owns extends boolean,
> {
  readonly tag: Tag;
  /** Whether the element's JavaScript renders its children. */
  readonly ownsChildren: Owns;
  /** The kind of each declared attribute, by name. */
  readonly attributes: {
    readonly [Name in keyof Attributes]: KindOf<Attributes[Name]>;
  };
  /** The names of the declared events. */
  readonly events: readonly (keyof Events & string)[];
  /** Carries the declared value types. Never set at runtime. */
  readonly [declaredTypes]?: { attributes: Attributes; events: Events };
  /**
   * Runs the statements when the element dispatches the event, with `detail`
   * standing for the event's `detail`. To handle several events on one
   * element, pass them in one object: spreading two results keeps only the
   * later one. A handler left `undefined` adds nothing. The browser runtime
   * starts listening on the next render after the element is inserted, so an
   * event dispatched synchronously in `connectedCallback` runs nothing.
   */
  on<Name extends keyof Events & string>(
    event: Name,
    handler: EventHandler<DetailOf<Events[Name]>>
  ): CustomEventAttributes;
  on(handlers: EventHandlers<Events>): CustomEventAttributes;
}

/** Any declaration, whatever its tag, attributes and events. */
export type AnyCustomElement = CustomElement<
  string,
  AttributeSpecs,
  EventSpecs,
  boolean
>;

type DeclaredTypes<E extends AnyCustomElement> = NonNullable<
  E[typeof declaredTypes]
>;

/** The value type of each attribute the declaration names. */
export type AttributeValues<E extends AnyCustomElement> = {
  -readonly [Name in keyof DeclaredTypes<E>["attributes"]]: ValueOf<
    DeclaredTypes<E>["attributes"][Name]
  >;
};

/** The names of the declared events. */
export type EventName<E extends AnyCustomElement> =
  keyof DeclaredTypes<E>["events"] & string;

/** The `detail` type of the declared event `Name`. */
export type EventDetail<
  E extends AnyCustomElement,
  Name extends keyof DeclaredTypes<E>["events"],
> = DetailOf<DeclaredTypes<E>["events"][Name]>;

type InvalidAttributeName<Attributes extends AttributeSpecs> = {
  [K in keyof Attributes & string]: IsCustomAttributeName<K> extends true
    ? never
    : K;
}[keyof Attributes & string];

type JsonDataAttributeName<Attributes extends AttributeSpecs> = {
  [K in keyof Attributes & string]: K extends `data-${string}`
    ? KindOf<Attributes[K]> extends "json"
      ? K
      : never
    : never;
}[keyof Attributes & string];

type InvalidEventName<Events extends EventSpecs> = {
  [K in keyof Events & string]: IsCustomEventName<K> extends true ? never : K;
}[keyof Events & string];

/**
 * Resolves to `Tag` when the declaration follows the rules, and otherwise to
 * a message type naming the first rule it breaks, so the tag argument shows
 * the error.
 */
type CheckedTag<
  Tag extends string,
  Attributes extends AttributeSpecs,
  Events extends EventSpecs,
> = [InvalidAttributeName<Attributes>] extends [never]
  ? [JsonDataAttributeName<Attributes>] extends [never]
    ? [InvalidEventName<Events>] extends [never]
      ? Tag extends CustomTagName
        ? Tag
        : "A custom element name starts with a lowercase letter, holds a -, and has no uppercase letter"
      : `Event "${InvalidEventName<Events>}" needs a lowercase letter followed by lowercase letters, digits, -, ., : or _, and cannot be click, input, change or submit`
    : `Attribute "${JsonDataAttributeName<Attributes>}" is a data-* attribute, which holds a string, number or boolean, not json`
  : `Attribute "${InvalidAttributeName<Attributes>}" needs a lowercase name that is not on*, style, id or data-hs-*`;

type HandlerEntry = [string, EventHandler<JsonValue> | undefined];

function serializeHandlers(entries: readonly HandlerEntry[]): string {
  const detail = exprOf<JsonValue>(["detail"]);
  const pairs: [string, StmtNode[]][] = [];
  for (const [name, handler] of entries) {
    if (handler === undefined) continue;
    if (!isCustomEventName(name)) {
      throw new TypeError(`Custom event name "${name}" is not valid`);
    }
    pairs.push([name, listStmts(handler(detail))]);
  }
  return JSON.stringify(pairs);
}

function kindOf(name: string, spec: unknown): AttributeKind {
  if (
    spec === "string" ||
    spec === "number" ||
    spec === "boolean" ||
    spec === "json"
  ) {
    return spec;
  }
  if (
    typeof spec === "object" &&
    spec !== null &&
    "kind" in spec &&
    spec.kind === "json"
  ) {
    return "json";
  }
  throw new TypeError(
    `Attribute "${name}" has kind ${JSON.stringify(spec)}, not string, number, boolean or json`
  );
}

function readAttributeKinds(
  attributes: Readonly<Record<string, unknown>>
): Record<string, AttributeKind> {
  const kinds: Record<string, AttributeKind> = {};
  for (const [name, spec] of Object.entries(attributes)) {
    if (!isBindableCustomAttribute(name)) {
      throw new TypeError(
        `Custom element attribute name "${name}" is not valid`
      );
    }
    const kind = kindOf(name, spec);
    // `CustomTag` passes every data-* prop through as a string, number or
    // boolean, so it cannot render a json value under that name.
    if (kind === "json" && name.startsWith("data-")) {
      throw new TypeError(
        `Attribute "${name}" is a data-* attribute, which cannot be json`
      );
    }
    kinds[name] = kind;
  }
  return kinds;
}

function readEventNames(events: Readonly<Record<string, unknown>>): string[] {
  const names = Object.keys(events);
  for (const name of names) {
    if (!isCustomEventName(name)) {
      throw new TypeError(`Custom event name "${name}" is not valid`);
    }
  }
  return names;
}

/**
 * Declares a custom element whose JavaScript the application loads. Import
 * the declaration on the server to render and bind the element, and in the
 * browser to implement it.
 *
 * The tag name starts with a lowercase letter, holds a `-`, and has only
 * lowercase letters, digits, `-`, `.` and `_`. An attribute name is lowercase
 * and is not `on*`, `style`, `id` or `data-hs-*`. An event name is lowercase
 * and is not `click`, `input`, `change` or `submit`. TypeScript checks what it
 * can on literal names; characters other than letters, the names HTML
 * reserves such as `font-face`, and an attribute kind other than the four
 * throw when this is called. A `data-*` attribute cannot be `json`.
 *
 * With `ownsChildren`, the element's JavaScript renders its children, and a
 * Live View update keeps them while it updates the element's attributes. The
 * browser runtime ignores hypersig attributes inside those children: their
 * bindings, handlers, snapshots and refs do nothing.
 */
export function customElement<
  const Tag extends string,
  const Attributes extends AttributeSpecs = Record<never, never>,
  const Events extends EventSpecs = Record<never, never>,
  const Owns extends boolean = false,
>(
  tag: CheckedTag<Tag, Attributes, Events>,
  options?: { attributes?: Attributes; events?: Events; ownsChildren?: Owns }
): CustomElement<Tag, Attributes, Events, Owns>;
export function customElement(
  tag: string,
  options?: {
    attributes?: Readonly<Record<string, unknown>>;
    events?: Readonly<Record<string, unknown>>;
    ownsChildren?: boolean;
  }
): AnyCustomElement {
  if (!isCustomElementName(tag)) {
    throw new TypeError(`Custom element name "${tag}" is not valid`);
  }
  return {
    tag,
    ownsChildren: options?.ownsChildren ?? false,
    attributes: readAttributeKinds(options?.attributes ?? {}),
    events: readEventNames(options?.events ?? {}),
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

export { defineElement } from "./define-element.js";
export type {
  ElementImplementation,
  Emit,
  MountedElement,
} from "./define-element.js";
