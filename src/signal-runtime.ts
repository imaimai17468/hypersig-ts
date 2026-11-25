import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText, isTruthy } from "./evaluate.js";
import type {
  ExprNode,
  JsonValue,
  SetStmtNode,
  SignalPath,
  SnapshotEntry,
  StmtNode,
} from "./protocol.js";
import {
  booleanAttributes,
  customElementAttributes,
  defaultMark,
  eventAttributes,
  formatJsonAttribute,
  isBindableAttribute,
  isBindableCustomAttribute,
  isCustomElementName,
  isCustomEventName,
  isExprNode,
  isJsonValue,
  isSignalPath,
  isStmtList,
  rendersBooleanAsText,
  signalAttributes,
} from "./protocol.js";

/** `data` is the `data` of the Action's JSON response, or `null`. */
export type SendResult = { ok: true; data: JsonValue } | { ok: false };

export interface SignalRuntimeOptions {
  root: Document;
  /**
   * Posts an Action for `control`. Every Action the runtime tracks goes
   * through it: `call` statements and `SignalRuntime.send`. Without it, each
   * Action fails.
   */
  send?(
    control: HTMLElement,
    url: string,
    body: string | FormData
  ): Promise<SendResult>;
  /** Action URLs of forms whose draft was restored before the runtime started. */
  restoredActions?: readonly string[];
  /** Creates the value of `uuid()`. Defaults to `crypto.randomUUID`. */
  uuid?(): string;
}

/**
 * The browser's signal store. The runtime owns the values; statements, bound
 * inputs (also when their form resets) and Live View snapshots update them. Bindings in the document show a
 * new value after a microtask.
 */
export interface SignalRuntime {
  /**
   * Stores the `data-hs-signals` values of elements inside a morphed Live View
   * (not the view element itself, which a morph leaves unchanged) as values
   * the server confirmed. Nested `[data-hs-view]` elements are skipped, and so
   * is the path of a focused bound text control (see `isTextControl`), so
   * typing is not overwritten. Every binding in the document is evaluated
   * again after a microtask.
   */
  applySnapshots(view: HTMLElement): void;
  /**
   * Sends a form or a button's Action. While it is in flight,
   * `["$pending", url]` is `true`, and the control has `data-hs-pending`
   * until the last request it sent ends, whether that request came from
   * `send`, `sendForm`, or a `call` statement in its handler. A success sets `["$restored", url]` to
   * `false`. The control's `data-hs-on-success` statements run with the
   * output, or its `data-hs-on-error` statements run on failure. A control
   * with a request in flight is not sent again and gets `{ ok: false }`, and
   * so does a control inside the children of a `data-hs-owns-children`
   * element, which sends nothing.
   */
  send(
    control: HTMLElement,
    url: string,
    body: string | FormData
  ): Promise<SendResult>;
  /**
   * Submits `form` to `url`. Runs the form's `data-hs-on-submit` statements
   * like a click handler, renders bindings synchronously so a bound hidden
   * input carries a value they wrote, then sends `new FormData(form,
   * submitter)` as `send` does. Writes the statements made stay when the
   * request fails. A form with a request in flight, or inside the children
   * of a `data-hs-owns-children` element, is not sent: its statements do not
   * run and it gets `{ ok: false }`.
   */
  sendForm(
    form: HTMLFormElement,
    url: string,
    submitter: HTMLElement | null
  ): Promise<SendResult>;
  /**
   * Reports whether `control` has a request in flight, so a Live View morph
   * can keep its `data-hs-pending` attribute.
   */
  isSending(control: Element): boolean;
  /**
   * Reports whether a Live View morph keeps the children of `previous`, which
   * the element's JavaScript rendered, and only copies the attributes of
   * `next`. Both elements need `data-hs-owns-children`, the same tag name and
   * the same `id`, where two elements without an `id` also match.
   */
  keepsChildren(previous: Element, next: Element): boolean;
  /**
   * Lists the attributes the runtime renders from the `bindElement` bindings
   * of `element`, so a morph that keeps an element leaves them to the next
   * render instead of writing the server's values first.
   */
  boundElementAttributes(element: Element): ReadonlySet<string>;
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

const textInputTypes: ReadonlySet<string> = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

/**
 * Reports a field whose typed value a Live View morph keeps while it has
 * focus. A morph still syncs other controls, such as `checked`.
 */
export function isTextControl(element: Element | null): element is Field {
  return (
    element !== null &&
    isField(element) &&
    (element.tagName === "TEXTAREA" || textInputTypes.has(element.type))
  );
}

/** Elements whose text the browser runs or applies as code. */
const codeElementNames: ReadonlySet<string> = new Set(["script", "style"]);

function isInputKind(value: unknown): value is InputKind {
  return value === "string" || value === "number" || value === "boolean";
}

/** Adds `delta` to the count for `key` and returns the new count. */
function addCount<K>(counts: Map<K, number>, key: K, delta: 1 | -1): number {
  const count = (counts.get(key) ?? 0) + delta;
  if (count) counts.set(key, count);
  else counts.delete(key);
  return count;
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

function isSnapshotEntry(entry: unknown): entry is SnapshotEntry {
  return (
    Array.isArray(entry) &&
    (entry.length === 2 || (entry.length === 3 && entry[2] === defaultMark)) &&
    isSignalPath(entry[0]) &&
    isJsonValue(entry[1])
  );
}

/** An entry of a custom event map or a key map. */
type NamedHandler = [name: string, stmts: StmtNode[]];

/** Reads a JSON array of names, ignoring entries that are not strings. */
function readNames(element: Element, name: string): ReadonlySet<string> {
  const names = parseAttribute(element, name);
  if (!Array.isArray(names)) return new Set();
  return new Set(names.filter((entry) => typeof entry === "string"));
}

/**
 * Sets an attribute only when its value changes, so a custom element's
 * `attributeChangedCallback` does not run for writes to other signals.
 * `toggleAttribute` already leaves an attribute in the requested state alone.
 */
function writeAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function isNamedHandler(entry: unknown): entry is NamedHandler {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    isStmtList(entry[1])
  );
}

/** Reads `[name, statements]` pairs, ignoring each malformed entry. */
function readNamedHandlers(element: Element, name: string): NamedHandler[] {
  const value = parseAttribute(element, name);
  return Array.isArray(value) ? value.filter(isNamedHandler) : [];
}

/** The key map last read from each element, with the text it was read from. */
const keyMaps = new WeakMap<
  Element,
  { readonly text: string; readonly handlers: readonly NamedHandler[] }
>();

/**
 * Reads an element's key map, reusing the entries read last time while the
 * attribute's text is the same, since every keydown reads each enclosing map.
 */
function readKeyMap(element: Element): readonly NamedHandler[] {
  const text = element.getAttribute(eventAttributes.keydown) ?? "";
  const cached = keyMaps.get(element);
  if (cached?.text === text) return cached.handlers;
  const handlers = readNamedHandlers(element, eventAttributes.keydown);
  keyMaps.set(element, { text, handlers });
  return handlers;
}

function readCustomEventHandlers(element: Element): NamedHandler[] {
  return readNamedHandlers(element, customElementAttributes.onCustom).filter(
    ([name]) => isCustomEventName(name)
  );
}

/**
 * Writes the pressed key the way a key map names it, with the modifiers in
 * the order Control, Alt, Shift, Meta. Without Control, Alt or Meta, Shift is
 * left out for a character key other than Space, since which characters need
 * it depends on the layout. With one of them, Shift is kept and the character
 * is lowercased, since browsers differ in which case they report.
 */
function formatKeyCombination(event: KeyboardEvent): string {
  const isCharacter = event.key.length === 1 && event.key !== " ";
  const holdsCommand = event.ctrlKey || event.altKey || event.metaKey;
  return (
    (event.ctrlKey ? "Control+" : "") +
    (event.altKey ? "Alt+" : "") +
    (event.shiftKey && (holdsCommand || !isCharacter) ? "Shift+" : "") +
    (event.metaKey ? "Meta+" : "") +
    (holdsCommand && isCharacter ? event.key.toLowerCase() : event.key)
  );
}

/** Keys whose default action moves focus, which a key map leaves to the browser. */
const focusMovingKeys: ReadonlySet<string> = new Set(["Tab", "Shift+Tab"]);

function isCustomElement(element: Element): boolean {
  return isCustomElementName(element.localName);
}

const ownerSelector = `[${customElementAttributes.ownsChildren}]`;

/**
 * Reports an element inside the children of a `data-hs-owns-children`
 * element. Its JavaScript renders them, and they may carry user content, so
 * the runtime, the Action outlets and drafts ignore their hypersig attributes.
 */
export function isOwnedChild(element: Element): boolean {
  return element.parentElement?.closest(ownerSelector) != null;
}

/** Lists the elements under `root` matching `selector` that the runtime handles. */
function findHandled<E extends Element = Element>(
  root: ParentNode,
  selector: string
): E[] {
  return [...root.querySelectorAll<E>(selector)].filter(
    (element) => !isOwnedChild(element)
  );
}

/**
 * Finds the nearest element from `target` up matching `selector` that the
 * runtime handles, so a handler inside owned children passes the event to
 * the owner or an ancestor.
 */
function findHandler(target: Element, selector: string): HTMLElement | null {
  let handler = target.closest<HTMLElement>(selector);
  while (handler && isOwnedChild(handler)) {
    handler = handler.parentElement?.closest<HTMLElement>(selector) ?? null;
  }
  return handler;
}

/** Finds the next handler outward from `handler`, as `findHandler` does. */
function findOuterHandler(
  handler: Element,
  selector: string
): HTMLElement | null {
  const parent = handler.parentElement;
  return parent && findHandler(parent, selector);
}

function readSnapshot(element: Element): SnapshotEntry[] {
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

/**
 * Converts the entered value, or returns `undefined` when it is blank or not
 * a finite number for a `number` signal.
 */
function readField(field: Field, kind: InputKind): JsonValue | undefined {
  if (kind === "boolean") {
    return "checked" in field ? field.checked : undefined;
  }
  if (kind === "string") return field.value;
  // `Number` reads a blank value as 0, which the user did not enter.
  if (field.value.trim() === "") return undefined;
  const number = Number(field.value);
  return Number.isFinite(number) ? number : undefined;
}

/** Reports a value restored from a draft or kept by the browser. */
function isEdited(field: Field, kind: InputKind): boolean {
  // Setting `value` on a hidden input also sets its `defaultValue`, so a
  // restored value cannot be told apart and is always read.
  if (field.type === "hidden") return true;
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
  const sendingControls = new Map<Element, number>();
  const sendingUrls = new Map<string, number>();
  const listenedEvents = new WeakMap<Element, Set<string>>();
  const reservations = new Map<string, ReturnType<typeof setTimeout>>();
  // The latest owned value of each app path from a `data-hs-signals` load.
  // It keeps one value per path a snapshot names, like the store, so it does
  // not grow with the number of updates.
  const committed = new Map<string, JsonValue>();
  // The request whose pending value each path still shows. A statement or an
  // input that writes the path ends it, so a failure does not undo that write.
  const pendingOwners = new Map<string, object>();
  let isRenderQueued = false;

  function read(path: SignalPath): JsonValue | undefined {
    return store.get(JSON.stringify(path));
  }

  function write(path: SignalPath, value: JsonValue) {
    store.set(JSON.stringify(path), value);
    scheduleRender();
  }

  function scheduleRender() {
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

  /** A write by a statement or an input, which replaces any pending value. */
  function writeByUser(path: SignalPath, value: JsonValue) {
    pendingOwners.delete(JSON.stringify(path));
    writeFromApp(path, value);
  }

  /** Skips the path in `editingKey`, which a focused input is editing. */
  function loadSnapshot(element: Element, editingKey?: string) {
    for (const [path, value, mark] of readSnapshot(element)) {
      const key = JSON.stringify(path);
      if (mark !== defaultMark && isAppPath(path)) committed.set(key, value);
      if (key === editingKey) continue;
      if (mark === defaultMark && store.has(key)) continue;
      writeFromApp(path, value);
    }
  }

  function findEditingKey(): string | undefined {
    const focused = root.activeElement;
    const binding = isTextControl(focused)
      ? readValueBinding(focused)
      : undefined;
    return binding && JSON.stringify(binding.path);
  }

  function writeField(field: Field) {
    const binding = readValueBinding(field);
    if (!binding) return;
    const value = readField(field, binding.kind);
    if (value !== undefined) writeByUser(binding.path, value);
  }

  /** Reads a JSON object of expressions, or `undefined` when malformed. */
  function readBindings(element: Element, name: string) {
    const bindings = parseAttribute(element, name);
    if (
      typeof bindings !== "object" ||
      bindings === null ||
      Array.isArray(bindings)
    )
      return undefined;
    const nodes: [string, ExprNode][] = [];
    for (const key of Object.keys(bindings)) {
      const node: unknown = Reflect.get(bindings, key);
      if (isExprNode(node)) nodes.push([key, node]);
    }
    return nodes;
  }

  function renderAttributes(element: Element) {
    for (const [name, node] of readBindings(element, signalAttributes.attr) ??
      []) {
      if (!isBindableAttribute(name)) continue;
      const value = evaluate(node, context);
      if (booleanAttributeNames.has(name)) {
        element.toggleAttribute(name, isTruthy(value));
        // After the user clicks, only the property affects the display.
        if (name === "checked" && isField(element) && "checked" in element) {
          element.checked = isTruthy(value);
        }
      } else if (value === null) {
        element.removeAttribute(name);
      } else {
        writeAttribute(element, name, formatText(value));
      }
    }
  }

  /**
   * Renders `bindElement` attributes as the server does: the names in
   * `data-hs-element-json` as JSON, the others by value type.
   */
  function renderElementAttributes(element: Element) {
    if (!isCustomElement(element)) return;
    const bindings = readBindings(element, customElementAttributes.elementAttr);
    const jsonNames = readNames(element, customElementAttributes.elementJson);
    for (const [name, node] of bindings ?? []) {
      if (!isBindableCustomAttribute(name)) continue;
      const value = evaluate(node, context);
      if (jsonNames.has(name)) {
        writeAttribute(element, name, formatJsonAttribute(value));
      } else if (typeof value === "boolean" && !rendersBooleanAsText(name)) {
        element.toggleAttribute(name, value);
      } else writeAttribute(element, name, formatText(value));
    }
  }

  function renderValue(element: Element) {
    if (!isField(element)) return;
    // A morph keeps the typed value of a focused text control, so render
    // leaves it too. Other controls show the store value.
    if (element === root.activeElement && isTextControl(element)) return;
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

  /**
   * Custom events may not bubble, so each custom element gets its own
   * listener per declared event. A listener reads the attribute when the
   * event fires, so a morph that changes it takes effect. Listeners attach
   * on the next render after the element is inserted, so an event it
   * dispatches synchronously in `connectedCallback` is not seen.
   */
  function listenToCustomEvents(element: HTMLElement) {
    const events = listenedEvents.get(element) ?? new Set<string>();
    listenedEvents.set(element, events);
    for (const [event] of readCustomEventHandlers(element)) {
      if (events.has(event)) continue;
      events.add(event);
      // Unlike a click, a custom event runs while the element's request is in
      // flight: editors and pickers fire often, and skipping would lose input.
      element.addEventListener(event, (fired) => {
        if (isOwnedChild(element)) return;
        const detail: unknown = "detail" in fired ? fired.detail : null;
        for (const [name, stmts] of readCustomEventHandlers(element)) {
          if (name === event) {
            run(stmts, element, null, isJsonValue(detail) ? detail : null);
          }
        }
      });
    }
  }

  function render() {
    for (const element of findHandled<HTMLElement>(
      root,
      `[${customElementAttributes.onCustom}]`
    )) {
      if (isCustomElement(element)) listenToCustomEvents(element);
    }
    for (const element of findHandled(root, `[${signalAttributes.text}]`)) {
      if (codeElementNames.has(element.localName)) continue;
      const node = readExpr(element, signalAttributes.text);
      if (!node) continue;
      const text = formatText(evaluate(node, context));
      if (element.textContent !== text) element.textContent = text;
    }
    for (const element of findHandled(root, `[${signalAttributes.show}]`)) {
      const node = readExpr(element, signalAttributes.show);
      if (node) {
        element.toggleAttribute("hidden", !isTruthy(evaluate(node, context)));
      }
    }
    for (const element of findHandled(root, `[${signalAttributes.attr}]`)) {
      renderAttributes(element);
    }
    for (const element of findHandled(
      root,
      `[${customElementAttributes.elementAttr}]`
    )) {
      renderElementAttributes(element);
    }
    for (const element of findHandled(root, `[${signalAttributes.bind}]`)) {
      renderValue(element);
    }
  }

  /**
   * Focuses the first element whose `data-hs-ref` is exactly `value`. A queued
   * render runs first, so an element that an earlier write reveals is no
   * longer `hidden` and can take focus.
   */
  function focusRef(value: string) {
    if (isRenderQueued) render();
    for (const element of findHandled<HTMLElement>(
      root,
      `[${signalAttributes.ref}]`
    )) {
      if (element.getAttribute(signalAttributes.ref) === value) {
        element.focus();
        return;
      }
    }
  }

  function isSending(control: Element): boolean {
    return sendingControls.has(control);
  }

  async function sendAction(
    control: HTMLElement,
    url: string,
    body: string | FormData,
    onSuccess: readonly StmtNode[],
    onError: readonly StmtNode[],
    detail: JsonValue = null,
    pendingPaths: readonly SignalPath[] = [],
    owner?: object
  ): Promise<SendResult> {
    const pendingPath = ["$pending", url];
    addCount(sendingControls, control, 1);
    control.setAttribute("data-hs-pending", "");
    addCount(sendingUrls, url, 1);
    write(pendingPath, true);
    let result: SendResult = { ok: false };
    try {
      if (options.send) result = await options.send(control, url, body);
    } catch {
      // A rejected send is a failed request.
    }
    if (addCount(sendingControls, control, -1) === 0) {
      control.removeAttribute("data-hs-pending");
    }
    write(pendingPath, addCount(sendingUrls, url, -1) > 0);
    for (const path of pendingPaths) {
      const key = JSON.stringify(path);
      if (pendingOwners.get(key) !== owner) continue;
      pendingOwners.delete(key);
      const value = committed.get(key);
      if (!result.ok && value !== undefined) writeFromApp(path, value);
    }
    try {
      if (result.ok) {
        write(["$restored", url], false);
        run(onSuccess, control, result.data, detail);
      } else {
        run(onError, control, null, detail);
      }
    } catch (error) {
      // Reported to the window's `error` event like an exception in a click
      // handler, not as an unhandled rejection.
      (root.defaultView ?? window).reportError(error);
    }
    return result;
  }

  /**
   * Writes the pending values of a call and takes their paths over for a new
   * request, which it returns. Throws before writing when a path has no
   * committed value to go back to, so the call and the statements after it
   * do not run.
   */
  function writePending(
    pending: readonly SetStmtNode[],
    runContext: EvaluationContext
  ): object {
    const uncommitted = pending.find(
      ([, path]) => !committed.has(JSON.stringify(path))
    );
    if (uncommitted) {
      throw new Error(
        `Pending path ${JSON.stringify(uncommitted[1])} has no committed value`
      );
    }
    const owner = {};
    for (const [, path, node] of pending) {
      writeFromApp(path, evaluate(node, runContext));
      pendingOwners.set(JSON.stringify(path), owner);
    }
    return owner;
  }

  /**
   * `control` is the element whose handler runs, and sends its `call`
   * statements. A timer whose element left the page runs with `null`, which
   * skips them.
   */
  function run(
    stmts: readonly StmtNode[],
    control: HTMLElement | null,
    output: JsonValue = null,
    detail: JsonValue = null
  ) {
    const runContext = { ...context, output, detail };
    for (const stmt of stmts) {
      switch (stmt[0]) {
        case "set":
          writeByUser(stmt[1], evaluate(stmt[2], runContext));
          break;
        case "toggle":
          writeByUser(stmt[1], !isTruthy(read(stmt[1]) ?? null));
          break;
        case "focus":
          focusRef(stmt[1]);
          break;
        case "focus-key": {
          const key = evaluate(stmt[2], runContext);
          if (typeof key === "string") {
            focusRef(JSON.stringify([stmt[1], key]));
          }
          break;
        }
        case "call": {
          if (!control) break;
          const [, url, input, onSuccess, onError, pending = []] = stmt;
          const owner = writePending(pending, runContext);
          // Defining each entry keeps a field named `__proto__` as a key.
          const body = Object.fromEntries(
            Object.entries(input).map(([field, node]) => [
              field,
              evaluate(node, runContext),
            ])
          );
          void sendAction(
            control,
            url,
            JSON.stringify(body),
            onSuccess,
            onError,
            detail,
            pending.map(([, path]) => path),
            owner
          );
          break;
        }
        case "after": {
          const [, id, ms, body] = stmt;
          clearTimeout(reservations.get(id));
          // Unlike a click, a timer runs while its control is sending, so a
          // debounced save does not drop the last input.
          reservations.set(
            id,
            setTimeout(() => {
              reservations.delete(id);
              run(body, control?.isConnected ? control : null, output, detail);
            }, ms)
          );
          break;
        }
        case "cancel":
          clearTimeout(reservations.get(stmt[1]));
          reservations.delete(stmt[1]);
          break;
        case "when": {
          const [, condition, then, otherwise] = stmt;
          const branch = isTruthy(evaluate(condition, runContext))
            ? then
            : otherwise;
          run(branch, control, output, detail);
          break;
        }
      }
    }
  }

  for (const element of findHandled(root, `[${signalAttributes.signals}]`)) {
    loadSnapshot(element);
  }
  for (const url of options.restoredActions ?? []) {
    write(["$restored", url], true);
  }
  for (const element of findHandled(root, `[${signalAttributes.bind}]`)) {
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
      if (type !== "click" && isField(target) && !isOwnedChild(target)) {
        writeField(target);
      }
      const handler = findHandler(target, `[${attribute}]`);
      // A click on a control whose Action is in flight runs none of its
      // statements, so its writes and calls are not repeated.
      if (handler && !(type === "click" && isSending(handler))) {
        run(readStmts(handler, attribute), handler);
      }
    });
  }

  const keySelector = `[${eventAttributes.keydown}]`;
  root.addEventListener("keydown", (event) => {
    const target = event.target;
    // Safari ends composition before the Enter that commits it, which still
    // has keyCode 229.
    if (event.isComposing || event.keyCode === 229 || !isElement(target)) {
      return;
    }
    // An element inside, such as an island, already handled the key.
    if (event.defaultPrevented) return;
    const key = formatKeyCombination(event);
    for (
      let handler = findHandler(target, keySelector);
      handler;
      handler = findOuterHandler(handler, keySelector)
    ) {
      const entry = readKeyMap(handler).find(([name]) => name === key);
      if (!entry) continue;
      if (!focusMovingKeys.has(key)) event.preventDefault();
      // Like a click, a key does not repeat the writes and calls of a handler
      // whose Action is in flight, such as a second Enter.
      if (!isSending(handler)) run(entry[1], handler);
      return;
    }
  });

  /**
   * Runs the `attribute` statements of each handler from `inside` outward
   * that does not contain `outside`, the element on the other side of the
   * focus move.
   */
  function runFocusHandlers(
    attribute: string,
    inside: Element,
    outside: Element | null
  ) {
    const selector = `[${attribute}]`;
    for (
      let handler = findHandler(inside, selector);
      handler && !(outside && handler.contains(outside));
      handler = findOuterHandler(handler, selector)
    ) {
      if (!isSending(handler)) run(readStmts(handler, attribute), handler);
    }
  }

  // The element that last had focus, kept while the page loses focus to
  // another window or tab, so focus coming back to it is not entering.
  let lastFocused: Element | null = root.activeElement;
  // Set while the leave skipped when the page lost focus runs. Focus that
  // those statements move elsewhere goes from `from`, and `target` is never
  // entered or left.
  let deferredLeave: { target: Element; from: Element } | null = null;
  root.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const related = event.relatedTarget;
    let from = lastFocused;
    if (deferredLeave && related === deferredLeave.target) {
      from = deferredLeave.from;
    } else if (isElement(related)) from = related;
    else if (from?.isConnected) {
      // The leave skipped when the page lost focus happens now, when focus
      // comes back somewhere else.
      lastFocused = target;
      deferredLeave = { target, from };
      try {
        runFocusHandlers(eventAttributes.focusLeave, from, target);
      } finally {
        deferredLeave = null;
      }
      if (lastFocused !== target) return;
    }
    lastFocused = target;
    runFocusHandlers(eventAttributes.focusEnter, target, from);
  });
  root.addEventListener("focusout", (event) => {
    const target = event.target;
    if (!isElement(target)) return;
    const to = isElement(event.relatedTarget) ? event.relatedTarget : null;
    if (!to && !root.hasFocus()) return;
    lastFocused = to;
    if (target === deferredLeave?.target) return;
    runFocusHandlers(eventAttributes.focusLeave, target, to);
  });

  // The event fires before the form resets its fields and the reset fires no
  // input events, so the fields are read after the event.
  root.addEventListener("reset", (event) => {
    const form = event.target;
    if (!isElement(form)) return;
    queueMicrotask(() => {
      for (const element of findHandled(form, `[${signalAttributes.bind}]`)) {
        if (isField(element)) writeField(element);
      }
    });
  });

  return {
    applySnapshots(view) {
      const editingKey = findEditingKey();
      for (const element of findHandled(
        view,
        `[${signalAttributes.signals}]`
      )) {
        if (element.closest(viewSelector) === view) {
          loadSnapshot(element, editingKey);
        }
      }
      // A morph resets bindings to the server HTML, so render them again even
      // when no snapshot changed the store.
      scheduleRender();
    },
    send(control, url, body) {
      if (isOwnedChild(control) || isSending(control)) {
        return Promise.resolve({ ok: false });
      }
      return sendAction(
        control,
        url,
        body,
        readStmts(control, signalAttributes.onSuccess),
        readStmts(control, signalAttributes.onError)
      );
    },
    sendForm(form, url, submitter) {
      if (isOwnedChild(form) || isSending(form)) {
        return Promise.resolve({ ok: false });
      }
      run(readStmts(form, signalAttributes.onSubmit), form);
      render();
      return sendAction(
        form,
        url,
        new FormData(form, submitter),
        readStmts(form, signalAttributes.onSuccess),
        readStmts(form, signalAttributes.onError)
      );
    },
    isSending,
    keepsChildren(previous, next) {
      const mark = customElementAttributes.ownsChildren;
      return (
        previous.hasAttribute(mark) &&
        next.hasAttribute(mark) &&
        previous.tagName === next.tagName &&
        previous.getAttribute("id") === next.getAttribute("id")
      );
    },
    boundElementAttributes(element) {
      if (!isCustomElement(element)) return new Set();
      const bindings = readBindings(
        element,
        customElementAttributes.elementAttr
      );
      return new Set(
        (bindings ?? [])
          .map(([name]) => name)
          .filter((name) => isBindableCustomAttribute(name))
      );
    },
    write,
    read,
  };
}
