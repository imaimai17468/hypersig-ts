import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText, isTruthy } from "./evaluate.js";
import type { ExprNode, JsonValue, SignalPath, StmtNode } from "./protocol.js";
import {
  booleanAttributes,
  eventAttributes,
  isBindableAttribute,
  isExprNode,
  isJsonValue,
  isSignalPath,
  isStmtList,
  signalAttributes,
} from "./protocol.js";

export interface SignalRuntimeOptions {
  root: Document;
  /** Sends an Action from a `call` statement. Not used yet. */
  send?(
    control: HTMLElement,
    url: string,
    body: string
  ): Promise<{ ok: true; data: JsonValue } | { ok: false }>;
  /** Creates the value of `uuid()`. Defaults to `crypto.randomUUID`. */
  uuid?(): string;
}

/**
 * The browser's signal store. The runtime owns the values; statements, bound
 * inputs and Live View snapshots update them. Bindings in the document show a
 * new value after a microtask.
 */
export interface SignalRuntime {
  /**
   * Stores the `data-hs-signals` values inside a morphed Live View as values
   * the server confirmed. Nested `[data-hs-view]` elements are skipped.
   */
  applySnapshots(view: HTMLElement): void;
  write(path: SignalPath, value: JsonValue): void;
  read(path: SignalPath): JsonValue | undefined;
}

type InputKind = "string" | "number" | "boolean";

interface ValueBinding {
  path: SignalPath;
  kind: InputKind;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

const viewSelector = "[data-hs-view]";
const booleanAttributeNames: ReadonlySet<string> = new Set(booleanAttributes);

/** Checks by node type, so elements from another frame also pass. */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && "nodeType" in target && target.nodeType === 1;
}

function isField(element: Element): element is Field {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

function isInputKind(value: unknown): value is InputKind {
  return value === "string" || value === "number" || value === "boolean";
}

/** Builtin paths start with `$` and only the runtime writes them. */
function isAppPath(path: SignalPath): boolean {
  return !path[0]?.startsWith("$");
}

function parseAttribute(element: Element, name: string): unknown {
  const text = element.getAttribute(name);
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function readExpr(element: Element, name: string): ExprNode | undefined {
  const value = parseAttribute(element, name);
  return isExprNode(value) ? value : undefined;
}

/** Ignores the whole handler when any statement is malformed. */
function readStmts(element: Element, name: string): StmtNode[] {
  const value = parseAttribute(element, name);
  return isStmtList(value) ? value : [];
}

function isSnapshotEntry(entry: unknown): entry is [SignalPath, JsonValue] {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    isSignalPath(entry[0]) &&
    isJsonValue(entry[1])
  );
}

function readSnapshot(element: Element): [SignalPath, JsonValue][] {
  const value = parseAttribute(element, signalAttributes.signals);
  return Array.isArray(value) ? value.filter(isSnapshotEntry) : [];
}

function readValueBinding(element: Element): ValueBinding | undefined {
  const value = parseAttribute(element, signalAttributes.bind);
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const path: unknown = value[0];
  const kind: unknown = value[1];
  return isSignalPath(path) && isInputKind(kind) ? { path, kind } : undefined;
}

/** Converts the entered value, or returns `undefined` when it does not fit. */
function readField(field: Field, kind: InputKind): JsonValue | undefined {
  if (kind === "boolean") {
    return "checked" in field ? field.checked : undefined;
  }
  if (kind === "string") return field.value;
  const number = Number(field.value);
  return Number.isFinite(number) ? number : undefined;
}

/** Reports a value restored from a draft or kept by the browser. */
function isEdited(field: Field, kind: InputKind): boolean {
  if (kind === "boolean" && "checked" in field) {
    return field.checked !== field.defaultChecked;
  }
  return field.value !== field.defaultValue;
}

export function startSignals(options: SignalRuntimeOptions): SignalRuntime {
  const { root } = options;
  const store = new Map<string, JsonValue>();
  const context: EvaluationContext = {
    read,
    uuid: () => options.uuid?.() ?? crypto.randomUUID(),
  };
  let isRenderQueued = false;

  function read(path: SignalPath): JsonValue | undefined {
    return store.get(JSON.stringify(path));
  }

  function write(path: SignalPath, value: JsonValue) {
    store.set(JSON.stringify(path), value);
    if (isRenderQueued) return;
    isRenderQueued = true;
    queueMicrotask(() => {
      isRenderQueued = false;
      render();
    });
  }

  function writeFromApp(path: SignalPath, value: JsonValue) {
    if (isAppPath(path)) write(path, value);
  }

  function loadSnapshot(element: Element) {
    for (const [path, value] of readSnapshot(element))
      writeFromApp(path, value);
  }

  function writeField(field: Field) {
    const binding = readValueBinding(field);
    if (!binding) return;
    const value = readField(field, binding.kind);
    if (value !== undefined) writeFromApp(binding.path, value);
  }

  function renderAttributes(element: Element) {
    const bindings = parseAttribute(element, signalAttributes.attr);
    if (
      typeof bindings !== "object" ||
      bindings === null ||
      Array.isArray(bindings)
    )
      return;
    for (const name of Object.keys(bindings)) {
      const node: unknown = Reflect.get(bindings, name);
      if (!isBindableAttribute(name) || !isExprNode(node)) continue;
      const value = evaluate(node, context);
      if (booleanAttributeNames.has(name)) {
        element.toggleAttribute(name, isTruthy(value));
      } else {
        element.setAttribute(name, formatText(value));
      }
    }
  }

  function renderValue(element: Element) {
    if (!isField(element) || element === root.activeElement) return;
    const binding = readValueBinding(element);
    const value = binding && read(binding.path);
    if (!binding || value === undefined) return;
    if (binding.kind === "boolean") {
      if ("checked" in element) element.checked = isTruthy(value);
      return;
    }
    const text = formatText(value);
    if (element.value !== text) element.value = text;
  }

  function render() {
    for (const element of root.querySelectorAll(`[${signalAttributes.text}]`)) {
      const node = readExpr(element, signalAttributes.text);
      if (!node) continue;
      const text = formatText(evaluate(node, context));
      if (element.textContent !== text) element.textContent = text;
    }
    for (const element of root.querySelectorAll(`[${signalAttributes.show}]`)) {
      const node = readExpr(element, signalAttributes.show);
      if (node) {
        element.toggleAttribute("hidden", !isTruthy(evaluate(node, context)));
      }
    }
    for (const element of root.querySelectorAll(`[${signalAttributes.attr}]`)) {
      renderAttributes(element);
    }
    for (const element of root.querySelectorAll(`[${signalAttributes.bind}]`)) {
      renderValue(element);
    }
  }

  function focusRef(id: string) {
    for (const element of root.querySelectorAll<HTMLElement>(
      `[${signalAttributes.ref}]`
    )) {
      if (element.getAttribute(signalAttributes.ref) === id) {
        element.focus();
        return;
      }
    }
  }

  function run(stmts: readonly StmtNode[]) {
    for (const stmt of stmts) {
      switch (stmt[0]) {
        case "set":
          writeFromApp(stmt[1], evaluate(stmt[2], context));
          break;
        case "toggle":
          writeFromApp(stmt[1], !isTruthy(read(stmt[1]) ?? null));
          break;
        case "focus":
          focusRef(stmt[1]);
          break;
        case "call":
          // Action calls do nothing until the runtime can send them.
          break;
      }
    }
  }

  for (const element of root.querySelectorAll(
    `[${signalAttributes.signals}]`
  )) {
    loadSnapshot(element);
  }
  for (const element of root.querySelectorAll(`[${signalAttributes.bind}]`)) {
    const binding = readValueBinding(element);
    if (binding && isField(element) && isEdited(element, binding.kind)) {
      writeField(element);
    }
  }
  render();

  for (const type of ["click", "input", "change"] as const) {
    const attribute = eventAttributes[type];
    root.addEventListener(type, (event) => {
      const target = event.target;
      if (!isElement(target)) return;
      if (type !== "click" && isField(target)) writeField(target);
      const handler = target.closest(`[${attribute}]`);
      if (handler) run(readStmts(handler, attribute));
    });
  }

  return {
    applySnapshots(view) {
      for (const element of [
        view,
        ...view.querySelectorAll(`[${signalAttributes.signals}]`),
      ]) {
        if (element.closest(viewSelector) === view) loadSnapshot(element);
      }
    },
    write,
    read,
  };
}
