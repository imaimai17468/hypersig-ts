import type { AnyCustomElement, AttributeValues } from "./element.js";
import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText, isTruthy } from "./evaluate.js";
import type { Identifier } from "./identifier.js";
import { identifierPattern } from "./identifier.js";
import type {
  ExprNode,
  JsonValue,
  SignalPath,
  SnapshotEntry,
  StmtNode,
} from "./protocol.js";
import type { bindableAttributes } from "./protocol.js";
import {
  booleanAttributes,
  customElementAttributes,
  defaultMark,
  eventAttributes,
  formatJsonAttribute,
  isBindableAttribute,
  isBindableCustomAttribute,
  isDelay,
  rendersBooleanAsText,
  signalAttributes,
} from "./protocol.js";

type JsonObject = { readonly [key: string]: JsonValue | undefined };

declare const valueType: unique symbol;

interface ExprBase<T extends JsonValue> {
  readonly node: ExprNode;
  /** Carries the value type for assignability checks. Never set at runtime. */
  readonly [valueType]?: T;
  eq(other: T | Expr<T>): Expr<boolean>;
  ne(other: T | Expr<T>): Expr<boolean>;
}

interface NumberMethods {
  add(other: number | Expr<number>): Expr<number>;
  sub(other: number | Expr<number>): Expr<number>;
  mul(other: number | Expr<number>): Expr<number>;
  gt(other: number | Expr<number>): Expr<boolean>;
  ge(other: number | Expr<number>): Expr<boolean>;
  lt(other: number | Expr<number>): Expr<boolean>;
  le(other: number | Expr<number>): Expr<boolean>;
  /**
   * Keeps the value within `min..max`. Evaluates to `min` when `min > max` or
   * when the value or `max` is not a number, and to `0` when `min` is not a
   * number.
   */
  clamp(min: number | Expr<number>, max: number | Expr<number>): Expr<number>;
  /**
   * The remainder in `0..n` (exclusive) for a positive `n`, so a negative
   * value wraps around. Evaluates to `0` when `n` is `0`.
   */
  mod(n: number | Expr<number>): Expr<number>;
}

interface BooleanMethods {
  not(): Expr<boolean>;
  and(other: boolean | Expr<boolean>): Expr<boolean>;
  or(other: boolean | Expr<boolean>): Expr<boolean>;
  choose<R extends JsonValue>(
    whenTrue: R | Expr<R>,
    whenFalse: R | Expr<R>
  ): Expr<R>;
}

interface StringMethods {
  concat(other: string | Expr<string>): Expr<string>;
  /** UTF-16 code units (`String.prototype.length`), not characters. */
  length(): Expr<number>;
  /** Removes leading and trailing whitespace. */
  trim(): Expr<string>;
  /** `toLowerCase()`, which does not depend on the locale. */
  lower(): Expr<string>;
  /** Whether `other` is a substring. Every string includes `""`. */
  includes(other: string | Expr<string>): Expr<boolean>;
}

interface ArrayMethods {
  /**
   * The element at `index`. Evaluates to `fallback` when `index` is not an
   * integer inside the array, so the result keeps the element type.
   */
  at<Item extends JsonValue>(
    this: Expr<readonly Item[]>,
    index: number | Expr<number>,
    fallback: NoInfer<Item> | Expr<NoInfer<Item>>
  ): Expr<Item>;
  length(): Expr<number>;
}

/** A missing optional field evaluates to `null`. */
type FieldValue<Value> = Extract<
  undefined extends Value ? Exclude<Value, undefined> | null : Value,
  JsonValue
>;

interface ObjectMethods<T> {
  get<K extends keyof T & string>(key: K): Expr<FieldValue<T[K]>>;
}

/**
 * An expression the browser runtime evaluates from signal values. The
 * methods available depend on the value type.
 */
export type Expr<T extends JsonValue> = ExprBase<T> &
  ([T] extends [number] ? NumberMethods : unknown) &
  ([T] extends [boolean] ? BooleanMethods : unknown) &
  ([T] extends [string] ? StringMethods : unknown) &
  ([T] extends [JsonObject] ? ObjectMethods<T> : unknown) &
  ([T] extends [readonly JsonValue[]] ? ArrayMethods : unknown);

/** A value the browser keeps in its signal store at `path`. */
export type Signal<T extends JsonValue> = Expr<T> & {
  readonly path: SignalPath;
  set(value: T | Expr<T>): StmtNode;
  toggle: [T] extends [boolean] ? () => StmtNode : never;
};

type SignalValues = Record<string, JsonValue>;

export type SignalGroup<Values extends SignalValues> = {
  readonly [K in keyof Values]: Signal<Values[K]>;
} & {
  /**
   * Returns a scope that renders bindings with these values for the current
   * request. Fields left out keep their initial values.
   */
  with(values: Partial<Values>): SignalScope<Values>;
};

type BindableAttribute = (typeof bindableAttributes)[number] | `data-${string}`;

type AttributeBindings<Attrs> = {
  readonly [K in keyof Attrs]: K extends `data-hs-${string}`
    ? never
    : K extends BindableAttribute
      ? Expr<JsonValue>
      : never;
};

/** A signal holds arrays as read-only arrays. */
export type ReadonlyJson<Value> = Value extends readonly (infer Item)[]
  ? readonly ReadonlyJson<Item>[]
  : Value extends JsonObject
    ? { readonly [K in keyof Value]: ReadonlyJson<Value[K]> }
    : Value;

/** `id` is left out: an owned element whose `id` changed is replaced. */
type ElementBindings<Values extends Record<string, JsonValue>> = {
  readonly [K in Exclude<keyof Values, "id">]?:
    | Values[K]
    | Expr<ReadonlyJson<Values[K]>>;
};

export type SignalScope<Values extends SignalValues> = SignalGroup<Values> & {
  /**
   * Writes every field so the browser runtime loads them. Fields passed to
   * `with` replace the browser's value; the others fill it only when the
   * browser has none. A field passed as `undefined` counts as left out.
   */
  init(): { [signalAttributes.signals]: string };
  /** Renders the evaluated text as `children`. */
  bindText(expr: Expr<JsonValue>): {
    [signalAttributes.text]: string;
    children: string;
  };
  bindShow(expr: Expr<boolean>): {
    [signalAttributes.show]: string;
    hidden?: true;
  };
  /**
   * Binds `disabled`, `checked`, `hidden`, `tabindex`, `aria-pressed`,
   * `aria-expanded`, `aria-current`, `aria-hidden`, `aria-invalid`,
   * `aria-busy`, `aria-activedescendant`, `aria-selected`, `aria-controls`,
   * `aria-label`, and `data-*` attributes other than `data-hs-*`. Throws for
   * any other name.
   */
  bindAttr<Attrs extends Partial<Record<BindableAttribute, Expr<JsonValue>>>>(
    attrs: Attrs & AttributeBindings<Attrs>
  ): Record<string, string | true> & { [signalAttributes.attr]: string };
  /**
   * Binds the attributes a custom element declares, each to a value or an
   * expression of the declared type. A `json` attribute renders with
   * `JSON.stringify` and is named in `data-hs-element-json` so the browser
   * runtime writes it the same way. Otherwise a `true` value renders the
   * attribute empty and `false` leaves it out; other values render as text. Throws for
   * a name that is not lowercase, starts with `on` (including names such as
   * `once`), is `style` or `id`, or starts with `data-hs-`. Only the type checks
   * that a key is declared: an object from a variable with extra keys still
   * writes them.
   */
  bindElement<E extends AnyCustomElement>(
    element: E,
    values: ElementBindings<AttributeValues<E>>
  ): Record<string, string> & {
    [customElementAttributes.elementAttr]: string;
    [customElementAttributes.elementJson]?: string;
  };
  bindValue(signal: Signal<string> | Signal<number> | Signal<boolean>): {
    [signalAttributes.bind]: string;
    value?: string;
    checked?: true;
  };
};

/** Inference keeps `true` and `false` literal; a signal can hold either. */
type Widened<Value> = Value extends boolean
  ? boolean
  : Value extends readonly (infer Item)[]
    ? readonly Widened<Item>[]
    : Value extends JsonObject
      ? { [K in keyof Value]: Widened<Value[K]> }
      : Value;

type WidenedValues<Values extends SignalValues> = {
  [K in keyof Values]: Widened<Values[K]>;
};

const scopeMembers = [
  "with",
  "init",
  "bindText",
  "bindShow",
  "bindAttr",
  "bindElement",
  "bindValue",
] as const;

type ReservedFields = {
  readonly [K in (typeof scopeMembers)[number]]?: never;
};

/**
 * Checks a literal `name` when a group is written. A name typed as `string` is
 * checked when the group is created.
 */
interface NameOption<Name extends string> {
  name?: string extends Name ? string : Identifier<Name>;
}

interface AnyExpr {
  readonly node: ExprNode;
}

type ExprInput = JsonValue | AnyExpr;

type BinaryOperator = Extract<ExprNode, [string, ExprNode, ExprNode]>[0];

function combine(
  operator: BinaryOperator,
  left: AnyExpr,
  right: ExprInput
): ExprHandle {
  return new ExprHandle([operator, left.node, nodeOf(right)]);
}

class ExprHandle {
  constructor(readonly node: ExprNode) {}

  eq(other: ExprInput): ExprHandle {
    return combine("eq", this, other);
  }
  ne(other: ExprInput): ExprHandle {
    return combine("ne", this, other);
  }
  add(other: ExprInput): ExprHandle {
    return combine("add", this, other);
  }
  sub(other: ExprInput): ExprHandle {
    return combine("sub", this, other);
  }
  mul(other: ExprInput): ExprHandle {
    return combine("mul", this, other);
  }
  gt(other: ExprInput): ExprHandle {
    return combine("gt", this, other);
  }
  ge(other: ExprInput): ExprHandle {
    return combine("ge", this, other);
  }
  lt(other: ExprInput): ExprHandle {
    return combine("lt", this, other);
  }
  le(other: ExprInput): ExprHandle {
    return combine("le", this, other);
  }
  and(other: ExprInput): ExprHandle {
    return combine("and", this, other);
  }
  or(other: ExprInput): ExprHandle {
    return combine("or", this, other);
  }
  concat(other: ExprInput): ExprHandle {
    return combine("concat", this, other);
  }
  includes(other: ExprInput): ExprHandle {
    return combine("includes", this, other);
  }
  mod(other: ExprInput): ExprHandle {
    return combine("mod", this, other);
  }
  length(): ExprHandle {
    return new ExprHandle(["length", this.node]);
  }
  trim(): ExprHandle {
    return new ExprHandle(["trim", this.node]);
  }
  lower(): ExprHandle {
    return new ExprHandle(["lower", this.node]);
  }
  clamp(min: ExprInput, max: ExprInput): ExprHandle {
    return new ExprHandle(["clamp", this.node, nodeOf(min), nodeOf(max)]);
  }
  at(index: ExprInput, fallback: ExprInput): ExprHandle {
    return new ExprHandle(["at", this.node, nodeOf(index), nodeOf(fallback)]);
  }
  not(): ExprHandle {
    return new ExprHandle(["not", this.node]);
  }
  choose(whenTrue: ExprInput, whenFalse: ExprInput): ExprHandle {
    return new ExprHandle([
      "if",
      this.node,
      nodeOf(whenTrue),
      nodeOf(whenFalse),
    ]);
  }
  get(key: string): ExprHandle {
    return new ExprHandle(["get", this.node, key]);
  }
}

class SignalHandle extends ExprHandle {
  constructor(readonly path: SignalPath) {
    super(["sig", path]);
  }

  set(value: ExprInput): StmtNode {
    return ["set", this.path, nodeOf(value)];
  }
  toggle(): StmtNode {
    return ["toggle", this.path];
  }
}

/** Every `Expr` is created here, so the class tells expressions from JSON. */
function isExpr(value: ExprInput): value is AnyExpr {
  return value instanceof ExprHandle;
}

export function nodeOf(value: ExprInput): ExprNode {
  return isExpr(value) ? value.node : ["lit", value];
}

/** Wraps a syntax tree node in the typed expression API. */
export function exprOf<T extends JsonValue>(node: ExprNode): Expr<T>;
export function exprOf(node: ExprNode): ExprHandle {
  return new ExprHandle(node);
}

export function lit<T extends JsonValue>(value: T): Expr<T>;
export function lit(value: JsonValue): ExprHandle {
  return new ExprHandle(["lit", value]);
}

/** A new `crypto.randomUUID()` in the browser. Renders as `""` on the server. */
export function uuid(): Expr<string>;
export function uuid(): ExprHandle {
  return new ExprHandle(["uuid"]);
}

const nameCounters = new Map<string, number>();

function assignId(kind: "Signal" | "Ref" | "Timer", name: string): string {
  if (!identifierPattern.test(name)) {
    throw new TypeError(
      `${kind} name "${name}" must be 1 to 64 letters, digits, _ or -`
    );
  }
  const count = (nameCounters.get(name) ?? 0) + 1;
  nameCounters.set(name, count);
  return `${name}-${count}`;
}

type Registration =
  | { kind: "group"; initial: SignalValues }
  | { kind: "family"; initial: SignalValues };

/** Initial values by ID, read when a scope evaluates another group's signal. */
const registrations = new Map<string, Registration>();

function readInitial(path: SignalPath): JsonValue | undefined {
  const [id, ...rest] = path;
  const registration = id === undefined ? undefined : registrations.get(id);
  if (registration === undefined) return undefined;
  const field =
    registration.kind === "group"
      ? rest.length === 1
        ? rest[0]
        : undefined
      : rest.length === 2
        ? rest[1]
        : undefined;
  return field !== undefined && Object.hasOwn(registration.initial, field)
    ? registration.initial[field]
    : undefined;
}

function register(
  kind: Registration["kind"],
  name: string | undefined,
  initial: SignalValues
): string {
  for (const member of scopeMembers) {
    if (Object.hasOwn(initial, member)) {
      throw new TypeError(
        `Signal field "${member}" is reserved for the scope method`
      );
    }
  }
  const id = assignId("Signal", name ?? "signal");
  registrations.set(id, { kind, initial });
  return id;
}

function isPrefixOf(prefix: SignalPath, path: SignalPath): boolean {
  return (
    path.length === prefix.length + 1 &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

type GroupObject = { readonly [key: string]: unknown };

function createGroup(
  prefix: SignalPath,
  initial: SignalValues,
  values?: SignalValues
): GroupObject {
  const fields = Object.keys(initial);
  const signalsByField = Object.fromEntries(
    fields.map((field) => [field, new SignalHandle([...prefix, field])])
  );
  const withValues = (next: SignalValues) =>
    createGroup(prefix, initial, { ...values, ...next });
  if (values === undefined) return { ...signalsByField, with: withValues };

  const context: EvaluationContext = {
    read(path) {
      if (path[0]?.startsWith("$")) return false;
      const field = path.at(-1);
      if (field !== undefined && isPrefixOf(prefix, path)) {
        if (Object.hasOwn(values, field)) return values[field];
        if (Object.hasOwn(initial, field)) return initial[field];
      }
      return readInitial(path);
    },
    uuid: () => "",
  };
  const valueOf = (expr: ExprHandle) => evaluate(expr.node, context);

  return {
    ...signalsByField,
    with: withValues,
    init: () => ({
      [signalAttributes.signals]: JSON.stringify(
        Object.entries(initial).map(([field, initialValue]): SnapshotEntry => {
          const path = [...prefix, field];
          const value = Object.hasOwn(values, field)
            ? values[field]
            : undefined;
          return value === undefined
            ? [path, initialValue, defaultMark]
            : [path, value];
        })
      ),
    }),
    bindText: (expr: ExprHandle) => ({
      [signalAttributes.text]: JSON.stringify(expr.node),
      children: formatText(valueOf(expr)),
    }),
    bindShow: (expr: ExprHandle) => ({
      [signalAttributes.show]: JSON.stringify(expr.node),
      ...(isTruthy(valueOf(expr)) ? {} : { hidden: true }),
    }),
    bindAttr: (attrs: Readonly<Record<string, ExprHandle | undefined>>) =>
      bindAttributes(attrs, valueOf),
    bindElement: (
      element: AnyCustomElement,
      values: Readonly<Record<string, ExprInput | undefined>>
    ) => bindElementAttributes(element, values, valueOf),
    bindValue: (signal: SignalHandle) => {
      const kind = inputKindOf(signal.path);
      const value = valueOf(signal);
      const bound = {
        [signalAttributes.bind]: JSON.stringify([signal.path, kind]),
      };
      if (kind !== "boolean") return { ...bound, value: formatText(value) };
      return isTruthy(value) ? { ...bound, checked: true } : bound;
    },
  };
}

type InputKind = "string" | "number" | "boolean";

/** Tells the browser how to convert an input's value for this signal. */
function inputKindOf(path: SignalPath): InputKind {
  const initial = readInitial(path);
  if (typeof initial === "string") return "string";
  if (typeof initial === "number") return "number";
  if (typeof initial === "boolean") return "boolean";
  throw new TypeError(`Cannot bind an input to signal ${JSON.stringify(path)}`);
}

const booleanAttributeNames: ReadonlySet<string> = new Set(booleanAttributes);

function bindAttributes(
  attrs: Readonly<Record<string, ExprHandle | undefined>>,
  valueOf: (expr: ExprHandle) => JsonValue
): Record<string, string | true> {
  const rendered: Record<string, string | true> = {};
  const nodes: Record<string, ExprNode> = {};
  for (const [name, expr] of Object.entries(attrs)) {
    if (expr === undefined) continue;
    if (!isBindableAttribute(name)) {
      throw new TypeError(`Cannot bind attribute "${name}" to a signal`);
    }
    nodes[name] = expr.node;
    const value = valueOf(expr);
    if (!booleanAttributeNames.has(name)) rendered[name] = formatText(value);
    else if (isTruthy(value)) rendered[name] = true;
  }
  rendered[signalAttributes.attr] = JSON.stringify(nodes);
  return rendered;
}

/**
 * Holds, on the object `bindElement` returns, the text it wrote for each `json`
 * attribute. Spreading the object copies it, and Hono JSX does not render
 * symbol keys, so `CustomTag` can tell that text from a later prop.
 */
const encodedJson = Symbol("hypersig.encodedJson");

class EncodedJson {
  constructor(readonly texts: ReadonlyMap<string, string>) {}
}

/** Reads the `json` attribute text that `bindElement` wrote into `props`. */
export function readEncodedJson(
  props: object
): ReadonlyMap<string, string> | undefined {
  const encoded: unknown = Reflect.get(props, encodedJson);
  return encoded instanceof EncodedJson ? encoded.texts : undefined;
}

function bindElementAttributes(
  element: AnyCustomElement,
  values: Readonly<Record<string, ExprInput | undefined>>,
  valueOf: (expr: ExprHandle) => JsonValue
): Record<string, string> {
  const rendered: Record<string, string> = {};
  const nodes: Record<string, ExprNode> = {};
  const jsonNames: string[] = [];
  const encoded = new Map<string, string>();
  for (const [name, input] of Object.entries(values)) {
    if (input === undefined) continue;
    if (!isBindableCustomAttribute(name)) {
      throw new TypeError(`Cannot bind custom element attribute "${name}"`);
    }
    const node = nodeOf(input);
    nodes[name] = node;
    const value = valueOf(new ExprHandle(node));
    if (
      Object.hasOwn(element.attributes, name) &&
      element.attributes[name] === "json"
    ) {
      rendered[name] = formatJsonAttribute(value);
      encoded.set(name, rendered[name]);
      jsonNames.push(name);
    } else if (typeof value !== "boolean" || rendersBooleanAsText(name)) {
      rendered[name] = formatText(value);
    } else if (value) rendered[name] = "";
  }
  rendered[customElementAttributes.elementAttr] = JSON.stringify(nodes);
  if (jsonNames.length > 0) {
    rendered[customElementAttributes.elementJson] = JSON.stringify(jsonNames);
    Object.defineProperty(rendered, encodedJson, {
      value: new EncodedJson(encoded),
      enumerable: true,
    });
  }
  return rendered;
}

/**
 * Defines a group of browser signals. The ID `name-number` is assigned when
 * this is called, so define groups at module level to keep IDs stable across
 * renders.
 */
export function signals<
  Values extends SignalValues,
  const Name extends string = never,
>(
  initial: Values & ReservedFields,
  options?: NameOption<Name>
): SignalGroup<WidenedValues<Values>>;
export function signals(
  initial: SignalValues,
  options?: { name?: string }
): GroupObject {
  return createGroup([register("group", options?.name, initial)], initial);
}

/**
 * Defines a group of browser signals per key, such as one per list row. Keys
 * are application data and may hold any characters.
 */
export function signalFamily<
  Values extends SignalValues,
  const Name extends string = never,
>(
  initial: Values & ReservedFields,
  options?: NameOption<Name>
): { at(key: string): SignalGroup<WidenedValues<Values>> };
export function signalFamily(
  initial: SignalValues,
  options?: { name?: string }
): { at(key: string): GroupObject } {
  const id = register("family", options?.name, initial);
  return { at: (key) => createGroup([id, key], initial) };
}

export interface SignalRef {
  /**
   * Marks the element that `focus()` moves focus to. It writes the same
   * attribute as `refs().attr(key)`, so an element takes only one of them.
   */
  attr(): { [signalAttributes.ref]: string };
  focus(): StmtNode;
}

/** Names an element that a `focus()` statement moves focus to. */
export function ref<const Name extends string = never>(
  options?: NameOption<Name>
): SignalRef;
export function ref(options?: { name?: string }): SignalRef {
  const id = assignId("Ref", options?.name ?? "ref");
  return {
    attr: () => ({ [signalAttributes.ref]: id }),
    focus: () => ["focus", id],
  };
}

export interface SignalRefs {
  /**
   * Marks an element as the one `focus(key)` reaches for this key. It writes
   * the same attribute as `ref().attr()`, so an element takes only one of them.
   */
  attr(key: string): { [signalAttributes.ref]: string };
  /**
   * Moves focus to the element marked with the key the expression evaluates to.
   * Does nothing when no element has the key.
   */
  focus(key: string | Expr<string>): StmtNode;
}

/** Names a family of elements that `focus(key)` picks among by a computed key. */
export function refs<const Name extends string = never>(
  options?: NameOption<Name>
): SignalRefs;
export function refs(options?: { name?: string }): SignalRefs {
  const id = assignId("Ref", options?.name ?? "refs");
  return {
    attr: (key) => ({ [signalAttributes.ref]: JSON.stringify([id, key]) }),
    focus: (key) => ["focus-key", id, nodeOf(key)],
  };
}

export interface SignalTimer {
  /**
   * Cancels the timer's reservation and reserves the statements to run `ms`
   * milliseconds later, so running it again counts from the last run. The
   * statements see the Action output and event detail of the statements that
   * ran `after`. Throws a `RangeError` unless `ms` is an integer from 0 to
   * 2147483647 (2^31 - 1), the longest delay `setTimeout` keeps.
   */
  after(ms: number, stmts: Statements): StmtNode;
  /** Cancels the timer's reservation. Does nothing when there is none. */
  cancel(): StmtNode;
}

/**
 * Names a timer that holds at most one reservation per page. Define it at the
 * top level of a module so its ID stays the same across renders.
 *
 * A reservation survives the Live View morph that removes the element whose
 * statements made it. When it fires, its statements run even while that
 * element has a request in flight, so the same Action may be sent twice at
 * once. Its `call` statements are sent from that element while it is still
 * on the page, and are skipped once it has left.
 */
export function timer<const Name extends string = never>(
  options?: NameOption<Name>
): SignalTimer;
export function timer(options?: { name?: string }): SignalTimer {
  const id = assignId("Timer", options?.name ?? "timer");
  return {
    after: (ms, stmts) => {
      if (!isDelay(ms)) {
        // The guard narrows `ms` to `never` here, but a caller can still pass
        // any number.
        const delay: number = ms;
        throw new RangeError(
          `Timer delay ${delay} must be an integer of milliseconds from 0 to 2147483647`
        );
      }
      return ["after", id, ms, listStmts(stmts)];
    },
    cancel: () => ["cancel", id],
  };
}

/**
 * Runs `then` when the condition is truthy in the browser, and `otherwise`
 * when it is not. It lets one key or event do different things by state, such
 * as Enter opening a closed list and picking from an open one, including a
 * `call` that only one branch sends.
 */
export function when(
  condition: boolean | Expr<boolean>,
  then: Statements,
  otherwise: Statements = []
): StmtNode {
  return ["when", nodeOf(condition), listStmts(then), listStmts(otherwise)];
}

function isStmtNodeValue(
  stmts: StmtNode | readonly StmtNode[]
): stmts is StmtNode {
  return typeof stmts[0] === "string";
}

/** Lists statements in the order the browser runtime runs them. */
export function listStmts(stmts: StmtNode | readonly StmtNode[]): StmtNode[] {
  return isStmtNodeValue(stmts) ? [stmts] : [...stmts];
}

/** Writes statements as the JSON array the browser runtime runs in order. */
export function serializeStmts(stmts: StmtNode | readonly StmtNode[]): string {
  return JSON.stringify(listStmts(stmts));
}

type Statements = StmtNode | readonly StmtNode[];

const namedKeys = [
  "Enter",
  "Escape",
  "Tab",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
] as const;

/** The `KeyboardEvent.key` values with a name that `on.keydown` accepts. */
export type NamedKey = (typeof namedKeys)[number];

const namedKeySet: ReadonlySet<string> = new Set(namedKeys);

type IsOneCharacter<Text extends string> = Text extends `${string}${infer Rest}`
  ? Text extends ""
    ? false
    : Rest extends ""
      ? true
      : false
  : false;

/** Resolves to `Key` when it is a named key or one character, else `never`. */
export type KeyName<Key extends string> = Key extends NamedKey
  ? Key
  : IsOneCharacter<Key> extends true
    ? Key
    : never;

/** The modifiers in the one order a key combination writes them. */
type ModifierOrder = ["Control", "Alt", "Shift", "Meta"];

type WithoutModifiers<
  Text extends string,
  Order extends readonly string[] = ModifierOrder,
> = Order extends readonly [
  infer Modifier extends string,
  ...infer Rest extends readonly string[],
]
  ? Text extends `${Modifier}+${infer After}`
    ? After extends ""
      ? Text
      : WithoutModifiers<After, Rest>
    : WithoutModifiers<Text, Rest>
  : Text;

/** Whether `Control+`, `Alt+` or `Meta+` comes before the key name. */
type HoldsCommandModifier<Key extends string> = Key extends
  | `Control+${string}`
  | `Alt+${string}`
  | `${"" | "Shift+"}Meta+${string}`
  ? true
  : false;

/** Whether `Shift+` alone comes before a character key other than Space. */
type ShiftsCharacter<Key extends string> = Key extends `Shift+${infer Name}`
  ? Name extends " "
    ? false
    : IsOneCharacter<Name>
  : false;

/**
 * Resolves to `Key` when its character is lowercase, and to a message naming
 * the lowercase combination otherwise.
 */
type LowercaseCharacter<Key extends string, Name extends string> =
  Name extends Lowercase<Name>
    ? Key
    : Key extends `${infer Modifiers}${Name}`
      ? `Write the character in lowercase after Control, Alt or Meta: "${Modifiers}${Lowercase<Name>}"`
      : never;

/**
 * Accepts a key name after any of `Control+`, `Alt+`, `Shift+` and `Meta+`
 * in that order, such as `"Shift+Tab"`, and resolves to a message type
 * otherwise. With none of Control, Alt and Meta, a character key other than
 * Space takes no `Shift+`: the runtime ignores Shift for it, so `"?"` and
 * `"A"` match however they are typed. After Control, Alt or Meta, Shift
 * counts and the character is written in lowercase, such as
 * `"Control+Shift+z"`, since the runtime compares it in either case. A
 * `string` that is not a literal passes, and `on.keydown` checks it when
 * called.
 */
export type KeyCombination<Key extends string> = string extends Key
  ? Key
  : [KeyName<WithoutModifiers<Key>>] extends [never]
    ? "Use a named key or one character, after modifiers in the order Control, Alt, Shift, Meta"
    : HoldsCommandModifier<Key> extends true
      ? IsOneCharacter<WithoutModifiers<Key>> extends true
        ? LowercaseCharacter<Key, WithoutModifiers<Key>>
        : Key
      : ShiftsCharacter<Key> extends true
        ? 'Write a character key without Shift+ unless Control, Alt or Meta is held, such as "?" or "A"'
        : Key;

type KeyMap = { readonly [key: string | number]: Statements };

type ModifierPrefix =
  `${"" | "Control+"}${"" | "Alt+"}${"" | "Shift+"}${"" | "Meta+"}`;

/**
 * Every named key after each allowed set of modifiers. It adds no rule of its
 * own: listing them as optional properties lets an editor suggest them.
 */
type SuggestedKeys = {
  readonly [Key in `${ModifierPrefix}${NamedKey}`]?: Statements;
};

type CheckedKeyMap<Keys extends KeyMap> = {
  readonly [Key in keyof Keys]: Key extends string | number
    ? KeyCombination<`${Key}`> extends `${Key}`
      ? Statements
      : KeyCombination<`${Key}`>
    : never;
};

const keyCombinationPattern = /^(Control\+)?(Alt\+)?(Shift\+)?(Meta\+)?(.+)$/s;

/** Describes why `key` is not a key combination, or `undefined` when it is. */
function findKeyCombinationError(key: string): string | undefined {
  const [, control, alt, shift, meta, name] =
    keyCombinationPattern.exec(key) ?? [];
  if (name === undefined || !(namedKeySet.has(name) || name.length === 1)) {
    return `${JSON.stringify(key)} is not a key name after modifiers in the order Control, Alt, Shift, Meta`;
  }
  if (name.length !== 1 || name === " ") return undefined;
  if (control || alt || meta) {
    const lowercase = name.toLowerCase();
    return lowercase === name
      ? undefined
      : `${JSON.stringify(key)} has an uppercase character after Control, Alt or Meta, which is matched in either case: write ${JSON.stringify(key.slice(0, -1) + lowercase)}`;
  }
  return shift
    ? `${JSON.stringify(key)} has Shift+, which a character key ignores unless Control, Alt or Meta is held: write ${JSON.stringify(name)} itself`
    : undefined;
}

/** Runs statements in order when the element receives the event. */
export const on = {
  click: (stmts: Statements) => ({
    [eventAttributes.click]: serializeStmts(stmts),
  }),
  input: (stmts: Statements) => ({
    [eventAttributes.input]: serializeStmts(stmts),
  }),
  change: (stmts: Statements) => ({
    [eventAttributes.change]: serializeStmts(stmts),
  }),
  /**
   * Runs the statements of the pressed key, checked from the focused element
   * outward through each enclosing key map until one has the key. A key is
   * the `KeyboardEvent.key` value, and the pressed modifiers must be exactly
   * the ones the key names, except that Shift is ignored for a character key
   * other than Space while none of Control, Alt and Meta is held: `"?"` and
   * `"A"` match with or without Shift, since which characters need it depends
   * on the keyboard layout. With Control, Alt or Meta, Shift counts and the
   * character is compared in either case, so it is written in lowercase:
   * `"Control+z"` matches only without Shift and `"Control+Shift+z"` only
   * with it, whether the browser reports `"z"` or `"Z"`. A number key is one
   * digit, such as `1`. A handled key does not do its default action, except
   * `Tab` and `Shift+Tab`. Keys pressed while an IME is composing, or while the
   * element's Action is in flight, run nothing, and so does a key whose
   * default an element inside already prevented. A map inside a custom
   * element that renders its own children is ignored. Editors suggest the
   * named keys with their modifiers. Throws for a name `KeyCombination`
   * rejects, which a computed `string` key can carry past the types.
   */
  keydown: <const Keys extends KeyMap>(
    map: Keys & CheckedKeyMap<Keys> & SuggestedKeys
  ) => {
    const entries = Object.entries(map).map(([key, stmts]) => {
      const error = findKeyCombinationError(key);
      if (error) throw new Error(error);
      return [key, listStmts(stmts)];
    });
    return { [eventAttributes.keydown]: JSON.stringify(entries) };
  },
  /**
   * Runs when focus moves to the element or into it from outside, but not
   * when it moves within it, or comes back to the page after a window or tab
   * switch.
   */
  focusEnter: (stmts: Statements) => ({
    [eventAttributes.focusEnter]: serializeStmts(stmts),
  }),
  /**
   * Runs when focus moves from inside the element to outside it, including
   * to nothing while the page keeps focus, such as a click on text. It does
   * not run when focus moves within the element, or when the page loses
   * focus to another window or tab. A click on a child that cannot take
   * focus moves focus to nothing, so give children a user clicks
   * `tabindex="-1"`.
   */
  focusLeave: (stmts: Statements) => ({
    [eventAttributes.focusLeave]: serializeStmts(stmts),
  }),
};
