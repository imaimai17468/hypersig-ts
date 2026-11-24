import { preserveDrafts, restoreDrafts } from "./drafts.js";
import { morphView } from "./morph.js";
import {
  events,
  isJsonValue,
  outletAttributes,
  streamParams,
} from "./protocol.js";
import type { HtmlUpdate } from "./protocol.js";
import { sanitizeFragment } from "./sanitize.js";
import type { SendResult, SignalRuntime } from "./signal-runtime.js";
import { isOwnedChild, startSignals } from "./signal-runtime.js";

function isUpdate(value: unknown): value is HtmlUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    typeof value.target === "string" &&
    "version" in value &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    "html" in value &&
    typeof value.html === "string" &&
    (!("children" in value) ||
      (Array.isArray(value.children) &&
        value.children.every((key: unknown) => typeof key === "string")))
  );
}

/** Matches Chromium's native EventSource retry of 3 s, so reopening never retries a down server faster. */
const reopenDelayMs = 3_000;

function readData(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string")
    return;
  try {
    const value: unknown = JSON.parse(event.data);
    return value;
  } catch {
    return;
  }
}

function updateViews(
  endpoint: URL,
  draftScope: string | undefined,
  signalRuntime: SignalRuntime
) {
  let active = true;
  let connection: EventSource | undefined;
  let views = new Map<string, HTMLElement>();
  /** The highest version applied to each node on the current response. */
  let versions = new WeakMap<HTMLElement, number>();
  /**
   * Top-level keys whose nodes still hold the SSR HTML. Filled from the views
   * of the first connection, and only shrinks: an update, a view error, or a
   * node replaced under the same key removes its key.
   */
  const pristine = new Set<string>();
  let hasConnected = false;

  function setStatus(
    status: "connecting" | "ready" | "disconnected" | "reload-required"
  ) {
    document.documentElement.dataset.hsConnection = status;
    const outlet = findHandledOutlet(
      document,
      `[${outletAttributes.connectionStatus}]`
    );
    if (outlet)
      outlet.textContent =
        status === "reload-required"
          ? "Live updates require reloading this page. Copy your draft before reloading."
          : status === "disconnected" && views.size
            ? "Live updates disconnected."
            : "";
  }

  function synchronize() {
    if (!active) return;
    const next = new Map<string, HTMLElement>();
    for (const node of document.querySelectorAll<HTMLElement>(
      "[data-hs-view]"
    )) {
      const key = node.dataset.hsView;
      if (key && !key.includes("/") && !isOwnedChild(node)) next.set(key, node);
    }
    if (
      next.size === views.size &&
      [...next].every(([key, node]) => views.get(key) === node) &&
      (connection || next.size === 0)
    )
      return;

    connection?.close();
    // A node app code put in place of a view no longer holds the SSR HTML.
    for (const [key, node] of next)
      if (views.get(key) !== node) pristine.delete(key);
    views = next;
    if (views.size === 0) {
      connection = undefined;
      setStatus("disconnected");
      return;
    }
    setStatus("connecting");
    if (!hasConnected) for (const key of views.keys()) pristine.add(key);
    hasConnected = true;
    const url = new URL(endpoint);
    for (const key of views.keys()) {
      url.searchParams.append(streamParams.view, key);
      if (pristine.has(key))
        url.searchParams.append(streamParams.pristine, key);
    }
    const claimedPristine = url.searchParams.getAll(streamParams.pristine);
    const source = new EventSource(url);
    connection = source;
    // Every response counts versions from 1, including one in another process.
    source.addEventListener("open", () => {
      if (source === connection) versions = new WeakMap();
    });
    /**
     * Searches only the root view, so an element elsewhere with a nested
     * view's id does not hide it.
     */
    function findView(target: string) {
      const root = views.get(target.split("/", 1)[0] ?? "");
      if (!root?.isConnected) return;
      if (!target.includes("/"))
        return root.dataset.hsView === target ? root : undefined;
      for (const node of root.querySelectorAll<HTMLElement>("[data-hs-view]")) {
        if (
          node.dataset.hsView === target &&
          node.id === `hs-view-${target}` &&
          !isOwnedChild(node)
        )
          return node;
      }
    }
    source.addEventListener(events.update, (event) => {
      if (source !== connection) return;
      const update = readData(event);
      if (!isUpdate(update)) return;
      const node = findView(update.target);
      if (!node || update.version <= (versions.get(node) ?? 0)) return;
      const fragment = sanitizeFragment(update.html);
      const childTargets = new Set(update.children);
      for (const child of fragment.querySelectorAll<HTMLElement>(
        "[data-hs-view]"
      )) {
        const target = child.dataset.hsView;
        if (
          !target ||
          !target.startsWith(`${update.target}/`) ||
          target.slice(update.target.length + 1).includes("/") ||
          child.tagName !== "DIV" ||
          child.id !== `hs-view-${target}` ||
          isOwnedChild(child) ||
          !childTargets.delete(target)
        ) {
          child.removeAttribute("data-hs-view");
        }
      }
      morphView(node, fragment, signalRuntime);
      signalRuntime.applySnapshots(node);
      node.removeAttribute("data-hs-view-error");
      versions.set(node, update.version);
      pristine.delete(update.target.split("/", 1)[0] ?? "");
    });
    source.addEventListener(events.viewError, (event) => {
      if (source !== connection) return;
      const target = readData(event);
      if (typeof target !== "string") return;
      const node = findView(target);
      if (!node) return;
      // Only a fresh render clears the marker, so the SSR HTML is no longer trusted.
      pristine.delete(target.split("/", 1)[0] ?? "");
      node.setAttribute("data-hs-view-error", "");
      node.dispatchEvent(
        new CustomEvent("hypersig:view-error", {
          bubbles: true,
          detail: { target },
        })
      );
    });
    source.addEventListener(events.ready, () => {
      if (source === connection) setStatus("ready");
    });
    function clearViews() {
      pristine.clear();
      for (const node of views.values()) {
        node.removeAttribute("data-hs-view-error");
        node.replaceChildren();
      }
      setStatus("disconnected");
    }
    source.addEventListener("error", () => {
      if (source !== connection) return;
      if (source.readyState === EventSource.CLOSED) {
        clearViews();
        return;
      }
      setStatus("disconnected");
      if (claimedPristine.every((key) => pristine.has(key))) return;
      // A native retry would reuse the URL that still claims the rewritten
      // views are pristine, and the server would skip their render.
      source.close();
      connection = undefined;
      setTimeout(() => {
        if (!connection) synchronize();
      }, reopenDelayMs);
    });
    source.addEventListener(events.denied, () => {
      if (source !== connection) return;
      source.close();
      clearViews();
    });
    source.addEventListener(events.reset, () => {
      if (source !== connection) return;
      source.close();
      if (preserveDrafts(draftScope)) location.reload();
      else {
        clearViews();
        setStatus("reload-required");
      }
    });
  }

  const observer = new MutationObserver((records) => {
    const changed = records.some(
      (record) =>
        record.type === "attributes" ||
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("[data-hs-view]:not([data-hs-view*='/'])") ||
              node.querySelector("[data-hs-view]:not([data-hs-view*='/'])"))
        )
    );
    if (changed) synchronize();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-hs-view"],
  });
  window.addEventListener("pagehide", () => {
    active = false;
    connection?.close();
    connection = undefined;
  });
  window.addEventListener("pageshow", () => {
    active = true;
    synchronize();
  });
  synchronize();
}

/** Finds the first outlet under `root` outside the children of an owned element. */
function findHandledOutlet(root: ParentNode | null, selector: string) {
  for (const outlet of root?.querySelectorAll(selector) ?? []) {
    if (!isOwnedChild(outlet)) return outlet;
  }
  return null;
}

/**
 * Creates the `send` the signal runtime uses for every Action. It reports
 * failures in the error outlets; the runtime marks the control as pending.
 */
function createActionSender(stream: URL) {
  const actionPath = new URL("../actions/", stream).pathname;
  return async function send(
    control: HTMLElement,
    target: string,
    body: string | FormData
  ): Promise<SendResult> {
    const form = control.closest("form");
    const errorSelector = `[${outletAttributes.error}]`;
    const outlet =
      findHandledOutlet(form, errorSelector) ??
      findHandledOutlet(document, errorSelector);
    const fields = form
      ? [
          ...form.querySelectorAll<HTMLElement>(
            `[${outletAttributes.fieldError}]`
          ),
        ].filter((field) => !isOwnedChild(field))
      : undefined;
    if (outlet) outlet.textContent = "";
    for (const field of fields ?? []) field.textContent = "";
    let status = 0;
    let failure: unknown;
    try {
      const url = new URL(target, location.href);
      if (
        url.origin !== location.origin ||
        !url.pathname.startsWith(actionPath)
      ) {
        throw new Error("Unexpected Action URL");
      }
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: {
          Accept: "application/json",
          ...(typeof body === "string"
            ? { "Content-Type": "application/json" }
            : {}),
        },
        redirect: "error",
      });
      if (response.ok) {
        const result: unknown = await response.json().catch(() => null);
        const data =
          result &&
          typeof result === "object" &&
          "data" in result &&
          isJsonValue(result.data)
            ? result.data
            : null;
        if (control.hasAttribute("data-hs-action-result")) {
          control.dispatchEvent(
            new CustomEvent("hypersig:action-success", {
              bubbles: true,
              detail: { data },
            })
          );
        }
        return { ok: true, data };
      }
      status = response.status;
      failure = await response.json().catch(() => null);
    } catch {
      // A status of zero represents a network error.
    }
    let message = status
      ? `Action failed (${status}).`
      : "Action request failed.";
    if (failure && typeof failure === "object" && "error" in failure) {
      if (
        failure.error === "action" &&
        "message" in failure &&
        typeof failure.message === "string"
      ) {
        message = failure.message;
      }
      if (
        failure.error === "input" &&
        "fieldIssues" in failure &&
        Array.isArray(failure.fieldIssues) &&
        fields?.length
      ) {
        const unmatched: string[] = [];
        for (const issue of failure.fieldIssues as unknown[]) {
          if (
            !issue ||
            typeof issue !== "object" ||
            !("message" in issue) ||
            typeof issue.message !== "string"
          )
            continue;
          const field =
            "field" in issue
              ? [...fields].find(
                  (node) =>
                    node.getAttribute(outletAttributes.fieldError) ===
                    issue.field
                )
              : undefined;
          if (field)
            field.textContent = field.textContent
              ? `${field.textContent} ${issue.message}`
              : issue.message;
          else unmatched.push(issue.message);
        }
        message = unmatched.join(" ");
      }
    }
    if (outlet) outlet.textContent = message;
    control.dispatchEvent(
      new CustomEvent("hypersig:action-error", {
        bubbles: true,
        detail: { status },
      })
    );
    return { ok: false };
  };
}

/**
 * Sends native-looking forms and `bind` buttons through the signal runtime.
 * The runtime sends nothing for one inside the children of an owned element,
 * and the default action stays prevented, so such a form does not post either.
 */
function handleActions(runtime: SignalRuntime) {
  async function sendForm(
    form: HTMLFormElement,
    target: string,
    submitter: HTMLElement | null
  ) {
    if (!form.hasAttribute("data-hs-reset-on-success")) {
      await runtime.sendForm(form, target, submitter);
      return;
    }

    const listeners = new AbortController();
    let edited = false;
    const markEdited = () => {
      edited = true;
    };
    form.addEventListener("input", markEdited, { signal: listeners.signal });
    form.addEventListener("change", markEdited, { signal: listeners.signal });
    try {
      if ((await runtime.sendForm(form, target, submitter)).ok && !edited) {
        HTMLFormElement.prototype.reset.call(form);
      }
    } finally {
      listeners.abort();
    }
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      "button[data-hs-action]"
    );
    const target = button?.dataset.hsAction;
    const input = button?.dataset.hsInput;
    if (!button || !target || input === undefined) return;
    event.preventDefault();
    void runtime.send(button, target, input);
  });

  document.addEventListener("submit", (event) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof HTMLFormElement) ||
      !event.target.hasAttribute("data-hs-form")
    )
      return;
    const form = event.target;
    event.preventDefault();
    const target = form.getAttribute("action");
    if (target) void sendForm(form, target, event.submitter);
  });
}

const runtime = document.querySelector<HTMLScriptElement>(
  "script[data-hs-stream]"
);
const endpoint = runtime?.dataset.hsStream;
if (endpoint) {
  const url = new URL(endpoint, location.href);
  if (url.origin === location.origin) {
    const scope = runtime?.dataset.hsDraftScope;
    const restoredActions = restoreDrafts(scope);
    const signalRuntime = startSignals({
      root: document,
      send: createActionSender(url),
      restoredActions,
    });
    updateViews(url, scope, signalRuntime);
    handleActions(signalRuntime);
  }
}
