import type { ExprNode, JsonValue, SignalPath } from "./protocol.js";
import { maxNestingDepth } from "./protocol.js";

export interface EvaluationContext {
  read(path: SignalPath): JsonValue | undefined;
  output?: JsonValue;
  /** The `detail` of the custom event whose statements are running. */
  detail?: JsonValue;
  uuid(): string;
}

function isRecord(
  value: JsonValue
): value is { readonly [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares objects by their JSON text, so two objects with the same entries in
 * a different key order are not equal.
 */
function isEqual(left: JsonValue, right: JsonValue): boolean {
  if (typeof left !== "object" || left === null) return Object.is(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Decides truthiness the same way on the server and in the browser. */
export function isTruthy(value: JsonValue): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

function compare(
  operator: "gt" | "ge" | "lt" | "le",
  left: JsonValue,
  right: JsonValue
): JsonValue {
  const bothNumbers = typeof left === "number" && typeof right === "number";
  const bothStrings = typeof left === "string" && typeof right === "string";
  if (!bothNumbers && !bothStrings) return null;
  switch (operator) {
    case "gt":
      return left > right;
    case "ge":
      return left >= right;
    case "lt":
      return left < right;
    case "le":
      return left <= right;
  }
}

function calculate(
  operator: "add" | "sub" | "mul",
  left: JsonValue,
  right: JsonValue
): JsonValue {
  if (typeof left !== "number" || typeof right !== "number") return null;
  const result =
    operator === "add"
      ? left + right
      : operator === "sub"
        ? left - right
        : left * right;
  return Number.isFinite(result) ? result : null;
}

function concatenate(left: JsonValue, right: JsonValue): JsonValue {
  const isText = (value: JsonValue) =>
    typeof value === "string" || typeof value === "number";
  if (!isText(left) || !isText(right)) return null;
  return `${left}${right}`;
}

function measureLength(value: JsonValue): number {
  return typeof value === "string" || Array.isArray(value) ? value.length : 0;
}

function clamp(value: JsonValue, min: JsonValue, max: JsonValue): number {
  if (typeof min !== "number") return 0;
  if (typeof value !== "number" || typeof max !== "number") return min;
  return Math.max(min, Math.min(value, max));
}

/** The remainder in `[0, n)` for a positive `n`; `0` when `n` is `0`. */
function modulo(value: JsonValue, divisor: JsonValue): number {
  if (typeof value !== "number" || typeof divisor !== "number") return 0;
  if (divisor === 0) return 0;
  const result = ((value % divisor) + divisor) % divisor;
  return Number.isFinite(result) ? result : 0;
}

function elementAt(
  list: JsonValue,
  index: JsonValue,
  fallback: () => JsonValue
): JsonValue {
  if (
    Array.isArray(list) &&
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < list.length
  ) {
    const items: readonly JsonValue[] = list;
    return items[index] ?? null;
  }
  return fallback();
}

/** A node nested deeper than `maxNestingDepth` evaluates to `null`. */
export function evaluate(
  node: ExprNode,
  context: EvaluationContext
): JsonValue {
  return evaluateAt(node, context, 1);
}

function evaluateAt(
  node: ExprNode,
  context: EvaluationContext,
  depth: number
): JsonValue {
  if (depth > maxNestingDepth) return null;
  const evaluateChild = (child: ExprNode) =>
    evaluateAt(child, context, depth + 1);
  switch (node[0]) {
    case "lit":
      return node[1];
    case "sig":
      return context.read(node[1]) ?? null;
    case "not":
      return !isTruthy(evaluateChild(node[1]));
    case "and":
      return (
        isTruthy(evaluateChild(node[1])) && isTruthy(evaluateChild(node[2]))
      );
    case "or":
      return (
        isTruthy(evaluateChild(node[1])) || isTruthy(evaluateChild(node[2]))
      );
    case "eq":
      return isEqual(evaluateChild(node[1]), evaluateChild(node[2]));
    case "ne":
      return !isEqual(evaluateChild(node[1]), evaluateChild(node[2]));
    case "gt":
    case "ge":
    case "lt":
    case "le":
      return compare(node[0], evaluateChild(node[1]), evaluateChild(node[2]));
    case "add":
    case "sub":
    case "mul":
      return calculate(node[0], evaluateChild(node[1]), evaluateChild(node[2]));
    case "concat":
      return concatenate(evaluateChild(node[1]), evaluateChild(node[2]));
    case "length":
      return measureLength(evaluateChild(node[1]));
    case "trim": {
      const text = evaluateChild(node[1]);
      return typeof text === "string" ? text.trim() : "";
    }
    case "lower": {
      const text = evaluateChild(node[1]);
      return typeof text === "string" ? text.toLowerCase() : "";
    }
    case "includes": {
      const text = evaluateChild(node[1]);
      const part = evaluateChild(node[2]);
      return typeof text === "string" && typeof part === "string"
        ? text.includes(part)
        : false;
    }
    case "clamp":
      return clamp(
        evaluateChild(node[1]),
        evaluateChild(node[2]),
        evaluateChild(node[3])
      );
    case "mod":
      return modulo(evaluateChild(node[1]), evaluateChild(node[2]));
    case "at":
      return elementAt(evaluateChild(node[1]), evaluateChild(node[2]), () =>
        evaluateChild(node[3])
      );
    case "if":
      return isTruthy(evaluateChild(node[1]))
        ? evaluateChild(node[2])
        : evaluateChild(node[3]);
    case "get": {
      const target = evaluateChild(node[1]);
      return (
        (isRecord(target) && Object.hasOwn(target, node[2])
          ? target[node[2]]
          : undefined) ?? null
      );
    }
    case "uuid":
      return context.uuid();
    case "output":
      return context.output ?? null;
    case "detail":
      return context.detail ?? null;
  }
}

export function formatText(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}
