/**
 * A value that `JSON.stringify` writes and `JSON.parse` reads back as the same
 * shape. An optional property may be `undefined`, which the JSON leaves out.
 * `NaN` and `Infinity` are numbers here but arrive as `null`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export interface HtmlUpdate {
  target: string;
  version: number;
  html: string;
  children?: readonly string[];
}

export const events = {
  update: "html-update",
  ready: "ready",
  viewError: "view-error",
  reset: "reset",
  denied: "access-denied",
} as const;

export type SignalPath = readonly string[];

export type ExprNode =
  | ["lit", JsonValue]
  | ["sig", SignalPath]
  | ["not", ExprNode]
  | [
      (
        | "and"
        | "or"
        | "eq"
        | "ne"
        | "gt"
        | "ge"
        | "lt"
        | "le"
        | "add"
        | "sub"
        | "mul"
        | "concat"
      ),
      ExprNode,
      ExprNode,
    ]
  | ["if", ExprNode, ExprNode, ExprNode]
  | ["get", ExprNode, string]
  | ["uuid"]
  | ["output"];

export type StmtNode =
  | ["set", SignalPath, ExprNode]
  | ["toggle", SignalPath]
  | ["focus", string]
  | ["call", string, Record<string, ExprNode>, StmtNode[], StmtNode[]];

/** Marks a `data-hs-signals` entry as a default rather than an owned value. */
export const defaultMark = 0;

/**
 * A `data-hs-signals` entry. An owned value replaces the store's value. A
 * default fills the path only when the store has no value for it.
 */
export type SnapshotEntry =
  | [path: SignalPath, value: JsonValue]
  | [path: SignalPath, value: JsonValue, mark: typeof defaultMark];

/** Elements the browser runtime fills with text. Applications mark them through the outlet functions. */
export const outletAttributes = {
  error: "data-hs-error",
  connectionStatus: "data-hs-connection-status",
  fieldError: "data-hs-field-error",
} as const;

export const signalAttributes = {
  signals: "data-hs-signals",
  text: "data-hs-text",
  show: "data-hs-show",
  attr: "data-hs-attr",
  bind: "data-hs-bind",
  ref: "data-hs-ref",
  onSuccess: "data-hs-on-success",
  onError: "data-hs-on-error",
  onSubmit: "data-hs-on-submit",
} as const;

export const eventAttributes = {
  click: "data-hs-on-click",
  input: "data-hs-on-input",
  change: "data-hs-on-change",
} as const;

export const bindableAttributes = [
  "disabled",
  "checked",
  "aria-pressed",
  "aria-expanded",
  "aria-current",
  "aria-hidden",
  "aria-invalid",
  "aria-busy",
] as const;

export const booleanAttributes = ["disabled", "checked"] as const;

const bindableAttributeNames: ReadonlySet<string> = new Set(bindableAttributes);

export function isBindableAttribute(name: string): boolean {
  if (name !== name.toLowerCase()) return false;
  if (bindableAttributeNames.has(name)) return true;
  return (
    name.startsWith("data-") && name.length > 5 && !name.startsWith("data-hs-")
  );
}

const binaryOperators: ReadonlySet<string> = new Set([
  "and",
  "or",
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "add",
  "sub",
  "mul",
  "concat",
]);

/**
 * The deepest nesting accepted from an attribute, counted separately for a
 * JSON value and for a tree of nodes. Deeper input is malformed, so checking
 * and evaluating it cannot overflow the stack.
 */
export const maxNestingDepth = 64;

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, 1);
}

function isJsonValueAt(value: unknown, depth: number): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > maxNestingDepth) return false;
  const isEntry = (entry: unknown) => isJsonValueAt(entry, depth + 1);
  if (Array.isArray(value)) return value.every(isEntry);
  return Object.values(value).every(
    (entry) => entry === undefined || isEntry(entry)
  );
}

export function isSignalPath(value: unknown): value is SignalPath {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((segment) => typeof segment === "string")
  );
}

export function isExprNode(value: unknown): value is ExprNode {
  return isExprNodeAt(value, 1);
}

function isExprNodeAt(value: unknown, depth: number): value is ExprNode {
  if (!Array.isArray(value) || depth > maxNestingDepth) return false;
  const [tag, first, second, third] = value as unknown[];
  if (typeof tag !== "string") return false;
  const isChild = (child: unknown) => isExprNodeAt(child, depth + 1);
  if (binaryOperators.has(tag)) {
    return value.length === 3 && isChild(first) && isChild(second);
  }
  switch (tag) {
    case "lit":
      return value.length === 2 && isJsonValue(first);
    case "sig":
      return value.length === 2 && isSignalPath(first);
    case "not":
      return value.length === 2 && isChild(first);
    case "if":
      return (
        value.length === 4 &&
        isChild(first) &&
        isChild(second) &&
        isChild(third)
      );
    case "get":
      return value.length === 3 && isChild(first) && typeof second === "string";
    case "uuid":
    case "output":
      return value.length === 1;
    default:
      return false;
  }
}

export function isStmtNode(value: unknown): value is StmtNode {
  return isStmtNodeAt(value, 1);
}

/** A statement's expressions and nested statements count toward its depth. */
function isStmtNodeAt(value: unknown, depth: number): value is StmtNode {
  if (!Array.isArray(value) || depth > maxNestingDepth) return false;
  const [tag, first, second, third, fourth] = value as unknown[];
  switch (tag) {
    case "set":
      return (
        value.length === 3 &&
        isSignalPath(first) &&
        isExprNodeAt(second, depth + 1)
      );
    case "toggle":
      return value.length === 2 && isSignalPath(first);
    case "focus":
      return value.length === 2 && typeof first === "string";
    case "call":
      return (
        value.length === 5 &&
        typeof first === "string" &&
        isExprRecord(second, depth + 1) &&
        isStmtListAt(third, depth + 1) &&
        isStmtListAt(fourth, depth + 1)
      );
    default:
      return false;
  }
}

function isExprRecord(
  value: unknown,
  depth: number
): value is Record<string, ExprNode> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((node) => isExprNodeAt(node, depth))
  );
}

export function isStmtList(value: unknown): value is StmtNode[] {
  return isStmtListAt(value, 1);
}

function isStmtListAt(value: unknown, depth: number): value is StmtNode[] {
  return (
    Array.isArray(value) && value.every((stmt) => isStmtNodeAt(stmt, depth))
  );
}
