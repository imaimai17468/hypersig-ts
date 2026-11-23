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

export const signalAttributes = {
  signals: "data-hs-signals",
  text: "data-hs-text",
  show: "data-hs-show",
  attr: "data-hs-attr",
  bind: "data-hs-bind",
  ref: "data-hs-ref",
  onSuccess: "data-hs-on-success",
  onError: "data-hs-on-error",
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Object.values(value).every(
    (entry) => entry === undefined || isJsonValue(entry)
  );
}

function isSignalPath(value: unknown): value is SignalPath {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((segment) => typeof segment === "string")
  );
}

export function isExprNode(value: unknown): value is ExprNode {
  if (!Array.isArray(value)) return false;
  const [tag, first, second, third] = value as unknown[];
  if (typeof tag !== "string") return false;
  if (binaryOperators.has(tag)) {
    return value.length === 3 && isExprNode(first) && isExprNode(second);
  }
  switch (tag) {
    case "lit":
      return value.length === 2 && isJsonValue(first);
    case "sig":
      return value.length === 2 && isSignalPath(first);
    case "not":
      return value.length === 2 && isExprNode(first);
    case "if":
      return (
        value.length === 4 &&
        isExprNode(first) &&
        isExprNode(second) &&
        isExprNode(third)
      );
    case "get":
      return (
        value.length === 3 && isExprNode(first) && typeof second === "string"
      );
    case "uuid":
    case "output":
      return value.length === 1;
    default:
      return false;
  }
}

export function isStmtNode(value: unknown): value is StmtNode {
  if (!Array.isArray(value)) return false;
  const [tag, first, second, third, fourth] = value as unknown[];
  switch (tag) {
    case "set":
      return value.length === 3 && isSignalPath(first) && isExprNode(second);
    case "toggle":
      return value.length === 2 && isSignalPath(first);
    case "focus":
      return value.length === 2 && typeof first === "string";
    case "call":
      return (
        value.length === 5 &&
        typeof first === "string" &&
        isExprRecord(second) &&
        isStmtList(third) &&
        isStmtList(fourth)
      );
    default:
      return false;
  }
}

function isExprRecord(value: unknown): value is Record<string, ExprNode> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isExprNode)
  );
}

function isStmtList(value: unknown): value is StmtNode[] {
  return Array.isArray(value) && value.every(isStmtNode);
}
