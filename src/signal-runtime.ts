import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText, isTruthy } from "./evaluate.js";
import type {
  ExprNode,
  JsonValue,
  SignalPath,
  SnapshotEntry,
  StmtNode,
} from "./protocol.js";
import {
  booleanAttributes,
  defaultMark,
  eventAttributes,
  isBindableAttribute,
  isExprNode,
  isJsonValue,
  isSignalPath,
  isStmtList,
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
   *
   * Then removes each preview row in `view` (not in a nested view) whose
   * template ID and key match a `data-hs-confirms` element in `view`, also
   * while its Action is in flight.
   */
  applySnapshots(view: HTMLElement): void;
  /**
   * Sends a form or a button's Action. While it is in flight,
   * `["$pending", url]` is `true`. A success sets `["$restored", url]` to
   * `false`. The control's `data-hs-on-success` statements run with the
   * output, or its `data-hs-on-error` statements run on failure. A control
   * with a request in flight is not sent again and gets `{ ok: false }`.
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
   * submitter)` as `send` does. The send owns the writes and preview rows of
   * those statements made after their last `call`. A form with a request in
   * flight runs no statements and gets `{ ok: false }`.
   */
  sendForm(
    form: HTMLFormElement,
    url: string,
    submitter: HTMLElement | null
  ): Promise<SendResult>;
  /**
   * Reports a preview row that an `insert` statement added and that has not
   * been removed yet. A Live View morph must neither remove nor rewrite it.
   */
  isPreview(node: Node): boolean;
  write(path: SignalPath, value: JsonValue): void;
  read(path: SignalPath): JsonValue | undefined;
}

type InputKind = "string" | "number" | "boolean";

interface ValueBinding {
  path: SignalPath;
  kind: InputKind;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/** A path a handler wrote before a `call`, with the value it replaced. */
interface OptimisticWrite {
  path: SignalPath;
  original: JsonValue | undefined;
}

/** A row an `insert` statement cloned from its template, until removed. */
interface Preview {
  templateId: string;
  key: string;
}

/**
 * What a `call` or a form send takes from the statements before it: the
 * optimistic writes to revert and the preview rows to remove on failure.
 */
interface OwnedEffects {
  writes: readonly OptimisticWrite[];
  previews: readonly Element[];
}

const noEffects: OwnedEffects = { writes: [], previews: [] };

/**
 * Counts the calls holding a path. `latest` is the newest snapshot value that
 * arrived while held, or `undefined` when none did.
 */
interface Hold {
  count: number;
  latest: JsonValue | undefined;
}

const viewSelector = "[data-hs-view]";
const itemRoot = "$item";
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
const codeElementNames: ReadonlySet<string> = new Set(["SCRIPT", "STYLE"]);

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

/** Reads `data-hs-confirms` as the `[templateId, key]` pair it names. */
function readConfirmation(element: Element): string | undefined {
  const value = parseAttribute(element, signalAttributes.confirms);
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "string")
    ? JSON.stringify(value)
    : undefined;
}

/** Reads `field` of the values of the closest `data-hs-item` element. */
function readItemField(element: Element, field: string): JsonValue | undefined {
  const item = element.closest(`[${signalAttributes.item}]`);
  const values = item && parseAttribute(item, signalAttributes.item);
  if (typeof values !== "object" || values === null || Array.isArray(values))
    return undefined;
  const value: unknown = Object.hasOwn(values, field)
    ? Reflect.get(values, field)
    : undefined;
  return isJsonValue(value) ? value : undefined;
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
  const holds = new Map<string, Hold>();
  const previews = new Map<Element, Preview>();
  const sendingControls = new Map<HTMLElement, number>();
  const sendingUrls = new Map<string, number>();
  let isRenderQueued = false;

  function read(path: SignalPath): JsonValue | undefined {
    return store.get(JSON.stringify(path));
  }

  function write(path: SignalPath, value: JsonValue | undefined) {
    const key = JSON.stringify(path);
    if (value === undefined) store.delete(key);
    else store.set(key, value);
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

  /**
   * Resolves `["$item", field]` from the closest `data-hs-item` of `element`,
   * so bindings in a preview row read the values it was inserted with.
   */
  function contextFor(element: Element): EvaluationContext {
    if (!element.closest(`[${signalAttributes.item}]`)) return context;
    return {
      ...context,
      read: (path) =>
        path[0] === itemRoot && path.length === 2 && path[1] !== undefined
          ? readItemField(element, path[1])
          : read(path),
    };
  }

  function writeFromApp(path: SignalPath, value: JsonValue) {
    if (isAppPath(path)) write(path, value);
  }

  /**
   * Skips the path in `editingKey`, which a focused input is editing, and
   * keeps the value of a held path until its call ends.
   */
  function loadSnapshot(element: Element, editingKey?: string) {
    for (const [path, value, mark] of readSnapshot(element)) {
      const key = JSON.stringify(path);
      if (key === editingKey) continue;
      if (mark === defaultMark && store.has(key)) continue;
      const hold = holds.get(key);
      if (hold) hold.latest = value;
      else writeFromApp(path, value);
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
      const value = evaluate(node, contextFor(element));
      if (booleanAttributeNames.has(name)) {
        element.toggleAttribute(name, isTruthy(value));
        // After the user clicks, only the property affects the display.
        if (name === "checked" && isField(element) && "checked" in element) {
          element.checked = isTruthy(value);
        }
      } else {
        element.setAttribute(name, formatText(value));
      }
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

  function render() {
    for (const element of root.querySelectorAll(`[${signalAttributes.text}]`)) {
      if (codeElementNames.has(element.tagName)) continue;
      const node = readExpr(element, signalAttributes.text);
      if (!node) continue;
      const text = formatText(evaluate(node, contextFor(element)));
      if (element.textContent !== text) element.textContent = text;
    }
    for (const element of root.querySelectorAll(`[${signalAttributes.show}]`)) {
      const node = readExpr(element, signalAttributes.show);
      if (node) {
        element.toggleAttribute(
          "hidden",
          !isTruthy(evaluate(node, contextFor(element)))
        );
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

  function isSending(control: HTMLElement): boolean {
    return sendingControls.has(control);
  }

  /**
   * Holds the optimistic writes while the Action is in flight. On failure,
   * each path goes back to the newest held snapshot or else to its original
   * value. On success, only a held snapshot is applied.
   */
  async function sendAction(
    control: HTMLElement,
    url: string,
    body: string | FormData,
    onSuccess: readonly StmtNode[],
    onError: readonly StmtNode[],
    { writes, previews: ownedPreviews }: OwnedEffects = noEffects
  ): Promise<SendResult> {
    const pendingPath = ["$pending", url];
    addCount(sendingControls, control, 1);
    addCount(sendingUrls, url, 1);
    write(pendingPath, true);
    for (const { path } of writes) {
      const key = JSON.stringify(path);
      const hold = holds.get(key);
      if (hold) hold.count += 1;
      else holds.set(key, { count: 1, latest: undefined });
    }
    let result: SendResult = { ok: false };
    try {
      if (options.send) result = await options.send(control, url, body);
    } catch {
      // A rejected send is a failed request.
    }
    addCount(sendingControls, control, -1);
    write(pendingPath, addCount(sendingUrls, url, -1) > 0);
    for (const { path, original } of writes) {
      const key = JSON.stringify(path);
      const hold = holds.get(key);
      const latest = hold?.latest;
      if (hold && --hold.count === 0) holds.delete(key);
      if (!result.ok) write(path, latest !== undefined ? latest : original);
      else if (latest !== undefined) write(path, latest);
    }
    for (const element of ownedPreviews) {
      if (!previews.has(element)) continue;
      if (!result.ok) {
        removePreview(element);
        continue;
      }
      element.removeAttribute(signalAttributes.pendingItem);
      const view = element.closest<HTMLElement>(viewSelector);
      if (view) removeConfirmedPreviews(view, [element]);
    }
    if (result.ok) {
      write(["$restored", url], false);
      run(onSuccess, control, result.data);
    } else {
      run(onError, control);
    }
    return result;
  }

  function removePreview(element: Element) {
    previews.delete(element);
    element.remove();
  }

  /**
   * Removes the given previews in `view` (not in a nested view) that a
   * `data-hs-confirms` element in `view` confirms.
   */
  function removeConfirmedPreviews(
    view: HTMLElement,
    candidates: Iterable<Element>
  ) {
    let confirmations: Set<string> | undefined;
    for (const element of candidates) {
      const preview = previews.get(element);
      if (!preview || element.closest(viewSelector) !== view) continue;
      confirmations ??= new Set(
        [...view.querySelectorAll(`[${signalAttributes.confirms}]`)]
          .filter((confirmed) => confirmed.closest(viewSelector) === view)
          .map(readConfirmation)
          .filter((pair) => pair !== undefined)
      );
      if (confirmations.has(JSON.stringify([preview.templateId, preview.key])))
        removePreview(element);
    }
  }

  /**
   * Clones the template's root element into every slot for `templateId`, and
   * returns the clones. Only a template outside Live Views counts.
   */
  function insertPreviews(
    templateId: string,
    values: Record<string, JsonValue>,
    key: string
  ): Element[] {
    const template = [
      ...root.querySelectorAll<HTMLTemplateElement>(
        `template[${signalAttributes.template}]`
      ),
    ].find(
      (element) =>
        element.getAttribute(signalAttributes.template) === templateId &&
        !element.closest(viewSelector)
    );
    const row = template?.content.firstElementChild;
    if (!row) return [];
    const inserted: Element[] = [];
    for (const slot of root.querySelectorAll(`[${signalAttributes.insert}]`)) {
      if (slot.getAttribute(signalAttributes.insert) !== templateId) continue;
      const clone = root.importNode(row, true);
      clone.setAttribute(signalAttributes.item, JSON.stringify(values));
      clone.setAttribute(signalAttributes.itemKey, key);
      clone.setAttribute(signalAttributes.pendingItem, "");
      slot.append(clone);
      previews.set(clone, { templateId, key });
      inserted.push(clone);
    }
    if (inserted.length) scheduleRender();
    return inserted;
  }

  /**
   * `control` is the element whose handler runs, and sends its `call`
   * statements. A `call` takes the paths written and the previews inserted
   * since the previous one. Returns those made after the last `call`, for a
   * form send to take.
   */
  function run(
    stmts: readonly StmtNode[],
    control: HTMLElement,
    output: JsonValue = null
  ): OwnedEffects {
    const runContext = { ...contextFor(control), output };
    let writes = new Map<string, OptimisticWrite>();
    let inserted: Element[] = [];
    const writeOptimistic = (path: SignalPath, value: JsonValue) => {
      if (!isAppPath(path)) return;
      const key = JSON.stringify(path);
      if (!writes.has(key)) writes.set(key, { path, original: read(path) });
      write(path, value);
    };
    for (const stmt of stmts) {
      switch (stmt[0]) {
        case "set":
          writeOptimistic(stmt[1], evaluate(stmt[2], runContext));
          break;
        case "toggle":
          writeOptimistic(stmt[1], !isTruthy(read(stmt[1]) ?? null));
          break;
        case "focus":
          focusRef(stmt[1]);
          break;
        case "insert": {
          const [, templateId, input, keyNode] = stmt;
          const key = evaluate(keyNode, runContext);
          // A key that is not a string cannot match a confirmed row.
          if (typeof key !== "string") break;
          const values: Record<string, JsonValue> = {};
          for (const [field, node] of Object.entries(input)) {
            values[field] = evaluate(node, runContext);
          }
          inserted.push(...insertPreviews(templateId, values, key));
          break;
        }
        case "call": {
          const [, url, input, onSuccess, onError] = stmt;
          const body: Record<string, JsonValue> = {};
          for (const [field, node] of Object.entries(input)) {
            body[field] = evaluate(node, runContext);
          }
          void sendAction(
            control,
            url,
            JSON.stringify(body),
            onSuccess,
            onError,
            { writes: [...writes.values()], previews: inserted }
          );
          writes = new Map();
          inserted = [];
          break;
        }
      }
    }
    return { writes: [...writes.values()], previews: inserted };
  }

  for (const element of root.querySelectorAll(
    `[${signalAttributes.signals}]`
  )) {
    loadSnapshot(element);
  }
  for (const url of options.restoredActions ?? []) {
    write(["$restored", url], true);
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
      const handler = target.closest<HTMLElement>(`[${attribute}]`);
      // A click on a control whose Action is in flight runs none of its
      // statements, so the optimistic writes are not applied twice.
      if (handler && !(type === "click" && isSending(handler))) {
        run(readStmts(handler, attribute), handler);
      }
    });
  }

  // The event fires before the form resets its fields and the reset fires no
  // input events, so the fields are read after the event.
  root.addEventListener("reset", (event) => {
    const form = event.target;
    if (!isElement(form)) return;
    queueMicrotask(() => {
      for (const element of form.querySelectorAll(
        `[${signalAttributes.bind}]`
      )) {
        if (isField(element)) writeField(element);
      }
    });
  });

  return {
    applySnapshots(view) {
      const editingKey = findEditingKey();
      for (const element of view.querySelectorAll(
        `[${signalAttributes.signals}]`
      )) {
        if (element.closest(viewSelector) === view) {
          loadSnapshot(element, editingKey);
        }
      }
      // A morph resets bindings to the server HTML, so render them again even
      // when no snapshot changed the store.
      scheduleRender();
      for (const element of previews.keys()) {
        if (!element.isConnected) previews.delete(element);
      }
      removeConfirmedPreviews(view, [...previews.keys()]);
    },
    send(control, url, body) {
      if (isSending(control)) return Promise.resolve({ ok: false });
      return sendAction(
        control,
        url,
        body,
        readStmts(control, signalAttributes.onSuccess),
        readStmts(control, signalAttributes.onError)
      );
    },
    sendForm(form, url, submitter) {
      if (isSending(form)) return Promise.resolve({ ok: false });
      const owned = run(readStmts(form, signalAttributes.onSubmit), form);
      render();
      return sendAction(
        form,
        url,
        new FormData(form, submitter),
        readStmts(form, signalAttributes.onSuccess),
        readStmts(form, signalAttributes.onError),
        owned
      );
    },
    isPreview(node) {
      return isElement(node) && previews.has(node);
    },
    write,
    read,
  };
}
