import { report } from "./diagnostics.js";
import type { LiveDiagnostic, RenderReason } from "./diagnostics.js";
import type { Principal } from "./live.js";
import type { HtmlUpdate } from "./protocol.js";
import { maxViews } from "./render.js";
import type { LeafSnapshot, ViewInstance } from "./render.js";
import { topicKey } from "./topic.js";
import type { PubSub, Topic } from "./topic.js";

export type LiveMessage =
  | { type: "update"; update: HtmlUpdate }
  | { type: "view-error"; target: string }
  | { type: "ready" | "reset" | "access-denied" | "heartbeat" };

export interface LiveConnection {
  readonly signal: AbortSignal;
  /** Close the connection and synchronously abort its signal. */
  close(): void;
  /** Resolves when the transport has accepted the message. */
  send(message: LiveMessage): Promise<void>;
}

type StreamAccess<User> =
  | { status: "allowed"; user: User }
  | { status: "expired" }
  | { status: "denied" };

interface StreamPage<User, Event> {
  views: ReadonlyMap<string, ViewInstance<User, Event>>;
  initialSnapshots: ReadonlyMap<string, LeafSnapshot>;
  refresh(): Promise<StreamAccess<User>>;
  nextVersion(): number;
}

interface TrackedView<User, Event> {
  view: ViewInstance<User, Event>;
  parent: TrackedView<User, Event> | undefined;
  children: Set<string>;
  subscription: {
    revision: string | number | undefined;
    keys: ReadonlySet<string>;
    stops: (() => void)[];
    lost: boolean;
  } | null;
  retryAt: number;
  denied: boolean;
  lastUpdate?: {
    html: string;
    children: string[];
    snapshotRevision: string | number | undefined;
  };
}

export async function streamPage<User extends Principal, Event extends Topic>(
  connection: LiveConnection,
  page: StreamPage<User, Event>,
  options: StreamOptions<Event>
): Promise<void> {
  const { signal } = connection;
  let tail = Promise.resolve();
  let ending = false;
  let terminal: Promise<void> | undefined;
  const budget = { used: 0 };
  let initial = page.views.size;

  function send(message: LiveMessage, terminal = false) {
    const next = tail.then(async () => {
      if (signal.aborted || (ending && !terminal)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop = () => {};
      const interrupted = new Promise<void>((resolve) => {
        stop = resolve;
        signal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(() => {
          report(options.onDiagnostic, { type: "send-timeout" });
          connection.close();
          resolve();
        }, options.sendTimeoutMs);
      });
      try {
        await Promise.race([connection.send(message), interrupted]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    });
    tail = next.catch(() => connection.close());
    return next;
  }

  async function refresh() {
    if (signal.aborted || ending) return;
    const access = await page.refresh();
    if (signal.aborted || ending) return;
    if (access.status === "allowed") return access.user;
    ending = true;
    terminal = send(
      {
        type: access.status === "denied" ? "access-denied" : "reset",
      },
      true
    );
    await terminal;
    connection.close();
  }

  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending || ending || signal.aborted) return;
    heartbeatPending = true;
    void refresh()
      .then(async (user) => {
        if (user) await send({ type: "heartbeat" });
      })
      .catch((error: unknown) => {
        console.error(error);
        connection.close();
      })
      .finally(() => {
        heartbeatPending = false;
      });
  }, 15_000);

  let release = () => {};
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
  });
  signal.addEventListener("abort", release, { once: true });
  try {
    if (signal.aborted) return;
    const trees = [...page.views].map(([target, view]) =>
      streamTree(
        {
          signal,
          send,
          refresh,
          nextVersion: () => page.nextVersion(),
          budget,
          async ready() {
            if (--initial === 0) await send({ type: "ready" });
          },
        },
        target,
        view,
        page.initialSnapshots.get(target),
        options
      )
    );
    await Promise.race([Promise.all(trees), aborted]);
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", release);
    try {
      await terminal;
    } finally {
      connection.close();
    }
  }
}

interface StreamOptions<Event extends Topic> {
  pubsub: PubSub<Event>;
  onDiagnostic: ((event: LiveDiagnostic<Event>) => void) | undefined;
  reconcileIntervalMs: number | undefined;
  sendTimeoutMs: number;
}

async function streamTree<User extends Principal, Event extends Topic>(
  {
    signal,
    send,
    refresh,
    nextVersion,
    budget,
    ready: announceReady,
  }: {
    signal: AbortSignal;
    send(this: void, message: LiveMessage): Promise<void>;
    refresh(this: void): Promise<User | undefined>;
    nextVersion(this: void): number;
    budget: { used: number };
    ready(this: void): Promise<void>;
  },
  root: string,
  rootView: ViewInstance<User, Event>,
  initialSnapshot: LeafSnapshot | undefined,
  { pubsub, onDiagnostic, reconcileIntervalMs }: StreamOptions<Event>
): Promise<void> {
  const dirty = new Set<string>();
  const active = new Map<string, TrackedView<User, Event>>();
  let wake: (() => void) | undefined;

  function track(
    target: string,
    view: ViewInstance<User, Event>,
    parent?: TrackedView<User, Event>
  ) {
    budget.used++;
    active.set(target, {
      view,
      parent,
      children: new Set(),
      subscription: null,
      retryAt: 0,
      denied: false,
    });
  }

  async function canRead(tracked: TrackedView<User, Event>, user: User) {
    for (
      let scope: TrackedView<User, Event> | undefined = tracked;
      scope;
      scope = scope.parent
    ) {
      if (signal.aborted || !(await scope.view.authorize(user))) return false;
    }
    return true;
  }

  function stop(tracked: TrackedView<User, Event>) {
    const subscription = tracked.subscription;
    tracked.subscription = null;
    for (const unsubscribe of subscription?.stops ?? []) unsubscribe();
  }

  function remove(target: string) {
    const tracked = active.get(target);
    if (!tracked) return;
    removeChildren(tracked);
    stop(tracked);
    active.delete(target);
    budget.used--;
    dirty.delete(target);
  }

  function removeChildren(tracked: TrackedView<User, Event>) {
    for (const target of tracked.children) remove(target);
    tracked.children.clear();
  }

  function canRetain(
    tracked: TrackedView<User, Event>,
    next: ViewInstance<User, Event>,
    user: User
  ) {
    const subscription = tracked.subscription;
    if (
      tracked.view.definition !== next.definition ||
      !subscription ||
      subscription.revision === undefined ||
      !Object.is(subscription.revision, next.revision(user))
    )
      return false;
    const previous = subscription.keys;
    const keys = new Set(next.topics(user).map(topicKey));
    return (
      keys.size === previous.size && [...keys].every((key) => previous.has(key))
    );
  }

  function reconcileChildren(
    tracked: TrackedView<User, Event>,
    children: ReadonlyMap<string, ViewInstance<User, Event>>,
    user: User
  ) {
    const retained = new Map<string, TrackedView<User, Event>>();
    for (const [target, next] of children) {
      const current = active.get(target);
      if (current && canRetain(current, next, user))
        retained.set(target, current);
    }
    const removed = [...tracked.children].filter((key) => !retained.has(key));
    const removedCount =
      removed.length === 0
        ? 0
        : [...active.keys()].filter((key) =>
            removed.some((root) => key === root || key.startsWith(`${root}/`))
          ).length;
    if (budget.used - removedCount + children.size - retained.size > maxViews)
      return false;

    for (const target of removed) remove(target);
    tracked.children.clear();
    for (const [target, next] of children) {
      tracked.children.add(target);
      const current = retained.get(target);
      if (current) current.view = next;
      else track(target, next, tracked);
    }
    return true;
  }

  async function writeUpdate(
    target: string,
    html: string,
    children: readonly string[] = []
  ) {
    const update: HtmlUpdate = { target, version: nextVersion(), html };
    if (children.length) update.children = children;
    await send({ type: "update", update });
  }

  async function deny(target: string, tracked: TrackedView<User, Event>) {
    removeChildren(tracked);
    stop(tracked);
    if (!tracked.denied) await writeUpdate(target, "");
    tracked.denied = true;
    delete tracked.lastUpdate;
  }

  track(root, rootView);
  function stopAll() {
    for (const tracked of active.values()) stop(tracked);
    wake?.();
  }
  signal.addEventListener("abort", stopAll, { once: true });

  try {
    let ready = false;
    let reconcileAt = Infinity;
    const auditIntervalMs = 15_000;
    while (!signal.aborted) {
      const reconcile = performance.now() >= reconcileAt;
      const batch = new Set(dirty);
      dirty.clear();
      const user = await refresh();
      if (!user) return;
      let retryAt = Infinity;
      for (const [target, tracked] of active) {
        if (signal.aborted) return;
        const { view } = tracked;
        if (!(await canRead(tracked, user))) {
          if (!signal.aborted) await deny(target, tracked);
          continue;
        }
        if (tracked.subscription?.lost) stop(tracked);
        const newSubscription = tracked.subscription === null;
        if (newSubscription) {
          if (tracked.retryAt > performance.now()) {
            retryAt = Math.min(retryAt, tracked.retryAt);
            continue;
          }
          const topics = new Map(
            view.topics(user).map((event) => [topicKey(event), event])
          );
          const subscription = {
            revision: view.revision(user),
            keys: new Set(topics.keys()),
            stops: [] as (() => void)[],
            lost: false,
          };
          tracked.subscription = subscription;
          for (const event of topics.values()) {
            if (signal.aborted) return;
            try {
              const unsubscribe = await pubsub.subscribe(
                event,
                () => {
                  if (
                    tracked.subscription !== subscription ||
                    subscription.lost
                  )
                    return;
                  dirty.add(target);
                  wake?.();
                  report(onDiagnostic, {
                    type: "invalidate",
                    target,
                    topic: event,
                  });
                },
                () => {
                  if (
                    tracked.subscription !== subscription ||
                    subscription.lost
                  )
                    return;
                  subscription.lost = true;
                  dirty.add(target);
                  wake?.();
                  report(onDiagnostic, {
                    type: "subscription-disconnected",
                    target,
                    topic: event,
                  });
                }
              );
              if (signal.aborted) {
                unsubscribe();
                return;
              }
              subscription.stops.push(unsubscribe);
            } catch (error) {
              if (signal.aborted) return;
              console.error(error);
              subscription.lost = true;
              report(onDiagnostic, {
                type: "subscribe-error",
                target,
                topic: event,
              });
            }
            if (subscription.lost) break;
          }
          if (subscription.lost) {
            stop(tracked);
            tracked.retryAt = performance.now() + 1_000;
            retryAt = Math.min(retryAt, tracked.retryAt);
            delete tracked.lastUpdate;
            await send({ type: "view-error", target });
            continue;
          }
          tracked.retryAt = 0;
        }
        const reason: RenderReason | undefined = newSubscription
          ? "connect"
          : batch.has(target)
            ? "topic"
            : reconcile
              ? "reconcile"
              : undefined;
        if (reason) {
          const initial =
            !ready && reason === "connect" && target === root
              ? initialSnapshot
              : undefined;
          const displayedRevision =
            initial?.revision ?? tracked.lastUpdate?.snapshotRevision;
          if (
            (initial || reason === "reconcile") &&
            displayedRevision !== undefined &&
            view.readSnapshotRevision
          ) {
            let currentRevision: string | number | undefined;
            try {
              currentRevision = await view.readSnapshotRevision(user);
            } catch {
              report(onDiagnostic, { type: "revision-error", target });
            }
            if (signal.aborted) return;
            if (tracked.subscription?.lost) continue;
            if (Object.is(currentRevision, displayedRevision)) {
              if (initial) {
                const current = await refresh();
                if (!current) return;
                if (!(await canRead(tracked, current))) {
                  if (!signal.aborted) await deny(target, tracked);
                  continue;
                }
                tracked.lastUpdate = {
                  html: initial.html,
                  children: [],
                  snapshotRevision: initial.revision,
                };
              }
              report(onDiagnostic, {
                type: initial ? "initial-sync-skipped" : "reconcile-skipped",
                target,
              });
              continue;
            }
          }
          let childCount = 0;
          const fragment = await view
            .render(user, "update", () => {
              if (++childCount > maxViews)
                throw new Error("Too many Live View children");
            })
            .catch((error: unknown) => {
              console.error(error);
              return undefined;
            });
          // An asynchronous load can outlive the authorization that started it.
          const current = await refresh();
          if (!current) return;
          if (!(await canRead(tracked, current))) {
            if (!signal.aborted) await deny(target, tracked);
            continue;
          }
          if (signal.aborted) return;
          if (tracked.subscription?.lost) continue;
          if (
            !fragment ||
            !reconcileChildren(tracked, fragment.children, current)
          ) {
            if (fragment) console.error("Too many active Live Views");
            delete tracked.lastUpdate;
            await send({ type: "view-error", target });
            report(onDiagnostic, { type: "render-error", target, reason });
            continue;
          }
          tracked.denied = false;
          report(onDiagnostic, { type: "render", target, reason });
          const children = [...tracked.children];
          const last = tracked.lastUpdate;
          const canSkip =
            reason === "reconcile" ||
            (reason === "topic" && view.skipUnchanged && children.length === 0);
          if (
            !canSkip ||
            last?.html !== fragment.html ||
            last.children.length !== children.length ||
            children.some((key, index) => last.children[index] !== key)
          ) {
            await writeUpdate(target, fragment.html, children);
          }
          if (reconcileIntervalMs !== undefined || view.skipUnchanged)
            tracked.lastUpdate = {
              html: fragment.html,
              children,
              snapshotRevision: fragment.snapshotRevision,
            };
        }
      }
      if (reconcileIntervalMs !== undefined && (!ready || reconcile))
        reconcileAt = performance.now() + reconcileIntervalMs;
      if (!ready) {
        await announceReady();
        ready = true;
      }
      if (dirty.size > 0 || signal.aborted) continue;

      const waitMs = Math.min(
        auditIntervalMs,
        Math.min(reconcileAt, retryAt) - performance.now()
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, waitMs);
      });
      wake = undefined;
      clearTimeout(timer);
    }
  } finally {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  }
}
