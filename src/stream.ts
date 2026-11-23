import type { Principal } from "./live.js";
import type { HtmlUpdate } from "./protocol.js";
import { maxViews } from "./render.js";
import type { ViewInstance } from "./render.js";
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
  } | null;
  denied: boolean;
}

export async function streamPage<User extends Principal, Event extends Topic>(
  connection: LiveConnection,
  page: StreamPage<User, Event>,
  pubsub: PubSub<Event>
): Promise<void> {
  const { signal } = connection;
  const dirty = new Set<string>();
  const active = new Map<string, TrackedView<User, Event>>();
  let wake: (() => void) | undefined;

  function track(
    target: string,
    view: ViewInstance<User, Event>,
    parent?: TrackedView<User, Event>
  ) {
    active.set(target, {
      view,
      parent,
      children: new Set(),
      subscription: null,
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
    for (const unsubscribe of tracked.subscription?.stops ?? []) unsubscribe();
    tracked.subscription = null;
  }

  function remove(target: string) {
    const tracked = active.get(target);
    if (!tracked) return;
    removeChildren(tracked);
    stop(tracked);
    active.delete(target);
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
    if (active.size - removedCount + children.size - retained.size > maxViews)
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
    const update: HtmlUpdate = { target, version: page.nextVersion(), html };
    if (children.length) update.children = children;
    await connection.send({ type: "update", update });
  }

  async function deny(target: string, tracked: TrackedView<User, Event>) {
    removeChildren(tracked);
    stop(tracked);
    if (!tracked.denied) await writeUpdate(target, "");
    tracked.denied = true;
  }

  async function refresh() {
    const access = await page.refresh();
    if (signal.aborted) return;
    if (access.status === "allowed") return access.user;
    await connection.send({
      type: access.status === "denied" ? "access-denied" : "reset",
    });
  }

  for (const [target, view] of page.views) track(target, view);
  function stopAll() {
    for (const tracked of active.values()) stop(tracked);
    wake?.();
  }
  signal.addEventListener("abort", stopAll, { once: true });

  try {
    let ready = false;
    while (!signal.aborted) {
      const batch = new Set(dirty);
      dirty.clear();
      const user = await refresh();
      if (!user) return;
      for (const [target, tracked] of active) {
        if (signal.aborted) return;
        const { view } = tracked;
        if (!(await canRead(tracked, user))) {
          if (!signal.aborted) await deny(target, tracked);
          continue;
        }
        const newSubscription = tracked.subscription === null;
        if (newSubscription) {
          const topics = new Map(
            view.topics(user).map((event) => [topicKey(event), event])
          );
          const stops: (() => void)[] = [];
          tracked.subscription = {
            revision: view.revision(user),
            keys: new Set(topics.keys()),
            stops,
          };
          for (const event of topics.values()) {
            if (signal.aborted) return;
            const unsubscribe = await pubsub.subscribe(event, () => {
              dirty.add(target);
              wake?.();
            });
            if (signal.aborted) {
              unsubscribe();
              return;
            }
            stops.push(unsubscribe);
          }
        }
        if (newSubscription || batch.has(target)) {
          let children = 0;
          const fragment = await view
            .render(user, "update", () => {
              if (++children > maxViews)
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
          if (
            !fragment ||
            !reconcileChildren(tracked, fragment.children, current)
          ) {
            if (fragment) console.error("Too many active Live Views");
            await connection.send({ type: "view-error", target });
            continue;
          }
          tracked.denied = false;
          await writeUpdate(target, fragment.html, [...tracked.children]);
        }
      }
      if (!ready) {
        await connection.send({ type: "ready" });
        ready = true;
      }
      if (dirty.size > 0 || signal.aborted) continue;

      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, 15_000);
      });
      wake = undefined;
      clearTimeout(timer);
      if (!signal.aborted && dirty.size === 0)
        await connection.send({ type: "heartbeat" });
    }
  } finally {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  }
}
