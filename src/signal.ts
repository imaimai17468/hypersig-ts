import type { CustomElement, CustomElementSpec } from "./element.js";
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
  defaultMark,
  eventAttributes,
  isBindableAttribute,
  isBindableCustomAttribute,
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
  ([T] extends [JsonObject] ? ObjectMethods<T> : unknown);

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

type ElementBindings<Attributes extends CustomElementSpec["attributes"]> = {
  readonly [K in keyof Attributes]?: Attributes[K] | Expr<Attributes[K]>;
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
   * Binds `disabled`, `checked`, some `aria-*` attributes, and `data-*`
   * attributes other than `data-hs-*`. Throws for any other name.
   */
  bindAttr<Attrs extends Partial<Record<BindableAttribute, Expr<JsonValue>>>>(
    attrs: Attrs & AttributeBindings<Attrs>
  ): Record<string, string | true> & { [signalAttributes.attr]: string };
  /**
   * Binds the attributes a custom element declares, each to a value or an
   * expression of the declared type. A `true` value renders the attribute
   * empty and `false` leaves it out; other values render as text. Throws for
   * a name that is not lowercase, starts with `on` (including names such as
   * `open`), is `style`, or starts with `data-hs-`. Only the type checks that a
   * key is declared: an object from a variable with extra keys still writes
   * them.
   */
  bindElement<Spec extends CustomElementSpec>(
    element: CustomElement<Spec>,
    values: ElementBindings<Spec["attributes"]>
  ): Record<string, string | true> & { [signalAttributes.attr]: string };
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

function assignId(kind: "Signal" | "Ref", name: string): string {
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
      _element: unknown,
      values: Readonly<Record<string, ExprInput | undefined>>
    ) => bindElementAttributes(values, valueOf),
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

function bindElementAttributes(
  values: Readonly<Record<string, ExprInput | undefined>>,
  valueOf: (expr: ExprHandle) => JsonValue
): Record<string, string | true> {
  const rendered: Record<string, string | true> = {};
  const nodes: Record<string, ExprNode> = {};
  for (const [name, input] of Object.entries(values)) {
    if (input === undefined) continue;
    if (!isBindableCustomAttribute(name)) {
      throw new TypeError(`Cannot bind custom element attribute "${name}"`);
    }
    const node = nodeOf(input);
    nodes[name] = node;
    const value = valueOf(new ExprHandle(node));
    if (typeof value !== "boolean") rendered[name] = formatText(value);
    else if (value) rendered[name] = true;
  }
  rendered[signalAttributes.attr] = JSON.stringify(nodes);
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
};
