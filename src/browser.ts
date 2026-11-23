import DOMPurify from "dompurify";
import { Idiomorph } from "idiomorph";
import { preserveDrafts, restoreDrafts } from "./drafts.js";
import { events, isJsonValue } from "./protocol.js";
import type { HtmlUpdate } from "./protocol.js";
import type { SendResult, SignalRuntime } from "./signal-runtime.js";
import { startSignals } from "./signal-runtime.js";

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

function isTextControl(element: Element | null) {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ["email", "number", "password", "search", "tel", "text", "url"].includes(
        element.type
      ))
  );
}

function updateViews(
  endpoint: URL,
  draftScope: string | undefined,
  signalRuntime: SignalRuntime
) {
  let active = true;
  let connection: EventSource | undefined;
  let views = new Map<string, HTMLElement>();
  const versions = new WeakMap<HTMLElement, number>();

  function setStatus(
    status: "connecting" | "ready" | "disconnected" | "reload-required"
  ) {
    document.documentElement.dataset.hsConnection = status;
    const outlet = document.querySelector("[data-hs-connection-status]");
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
      if (key && !key.includes("/")) next.set(key, node);
    }
    if (
      next.size === views.size &&
      [...next].every(([key, node]) => views.get(key) === node) &&
      (connection || next.size === 0)
    )
      return;

    connection?.close();
    views = next;
    if (views.size === 0) {
      connection = undefined;
      setStatus("disconnected");
      return;
    }
    setStatus("connecting");
    const url = new URL(endpoint);
    for (const key of views.keys()) url.searchParams.append("view", key);
    const source = new EventSource(url);
    connection = source;
    function findView(target: string) {
      const root = views.get(target.split("/", 1)[0] ?? "");
      const node = target.includes("/")
        ? document.getElementById(`hs-view-${target}`)
        : root;
      if (
        node?.isConnected &&
        root?.contains(node) &&
        node.dataset.hsView === target
      )
        return node;
    }
    source.addEventListener(events.update, (event) => {
      if (source !== connection) return;
      const update = readData(event);
      if (!isUpdate(update)) return;
      const node = findView(update.target);
      if (!node || update.version <= (versions.get(node) ?? 0)) return;
      const fragment = DOMPurify.sanitize(update.html, {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["style", "template"],
        FORBID_ATTR: ["data-hs-stream", "style"],
      });
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
          !childTargets.delete(target)
        ) {
          child.removeAttribute("data-hs-view");
        }
      }
      // Idiomorph is synchronous when head processing is non-blocking.
      void Idiomorph.morph(node, fragment, {
        head: { style: "none" },
        morphStyle: "innerHTML",
        ignoreActiveValue: isTextControl(document.activeElement),
        restoreFocus: true,
        callbacks: {
          beforeNodeMorphed(previous, next) {
            return !(
              previous instanceof HTMLElement &&
              next instanceof HTMLElement &&
              next.dataset.hsView &&
              previous.dataset.hsView === next.dataset.hsView
            );
          },
        },
      });
      signalRuntime.applySnapshots(node);
      node.removeAttribute("data-hs-view-error");
      versions.set(node, update.version);
    });
    source.addEventListener(events.viewError, (event) => {
      if (source !== connection) return;
      const target = readData(event);
      if (typeof target !== "string") return;
      const node = findView(target);
      if (!node) return;
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
      for (const node of views.values()) {
        node.removeAttribute("data-hs-view-error");
        node.replaceChildren();
      }
      setStatus("disconnected");
    }
    source.addEventListener("error", () => {
      if (source !== connection) return;
      if (source.readyState === EventSource.CLOSED) clearViews();
      else setStatus("disconnected");
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

/**
 * Creates the `send` the signal runtime uses for every Action. It shows the
 * control as pending and reports failures in the error outlets.
 */
function createActionSender(stream: URL) {
  const actionPath = new URL("../actions/", stream).pathname;
  return async function send(
    control: HTMLElement,
    target: string,
    body: string | FormData
  ): Promise<SendResult> {
    const outlet =
      control.closest("form")?.querySelector("[data-hs-error]") ??
      document.querySelector("[data-hs-error]");
    const fields = control
      .closest("form")
      ?.querySelectorAll<HTMLElement>("[data-hs-field-error]");
    if (outlet) outlet.textContent = "";
    for (const field of fields ?? []) field.textContent = "";
    control.setAttribute("data-hs-pending", "");
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
    } finally {
      control.removeAttribute("data-hs-pending");
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
                  (node) => node.dataset.hsFieldError === issue.field
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

/** Sends native-looking forms and `bind` buttons through the signal runtime. */
function handleActions(runtime: SignalRuntime) {
  async function sendForm(
    form: HTMLFormElement,
    target: string,
    submitter: HTMLElement | null
  ) {
    const body = new FormData(form, submitter);
    if (!form.hasAttribute("data-hs-reset-on-success")) {
      await runtime.send(form, target, body);
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
      if ((await runtime.send(form, target, body)).ok && !edited) {
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
