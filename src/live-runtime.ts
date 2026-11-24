import { report } from "./diagnostics.js";
import type { LiveDiagnostic } from "./diagnostics.js";
import { identifierPattern } from "./identifier.js";
import type {
  LiveRenderContext,
  LiveView,
  NamedView,
  Principal,
  SharedLiveView,
  SharedLoadOptions,
  SharedValue,
} from "./live.js";
import { maxViews, renderContext } from "./render.js";
import type {
  LeafSnapshot,
  LiveRenderer,
  ViewInstance,
  RegisteredView,
  ViewRegistry,
} from "./render.js";
import { streamPage } from "./stream.js";
import type { LiveConnection } from "./stream.js";
import type { PubSub, Topic } from "./topic.js";

interface PageSession<User, Event> {
  sessionId: string;
  views: Map<string, ViewInstance<User, Event>>;
  touched: number;
  version: number;
  close?: () => void;
}

type RefreshUser<User> = () => User | null | Promise<User | null>;

export type OpenPage<User> =
  | { status: "expired" | "denied" | "invalid-count" | "unknown-view" }
  | {
      status: "open";
      /** The adapter finishes its response after this operation returns. */
      connect(
        connection: LiveConnection,
        refreshUser: RefreshUser<User>
      ): Promise<void>;
    };

export interface LiveRuntimeOptions<Event extends Topic, Markup> {
  renderer: LiveRenderer<Markup>;
  pubsub: PubSub<Event>;
  onDiagnostic?: (event: LiveDiagnostic<Event>) => void;
  /** Re-read subscribed views periodically to recover missed notifications. */
  reconcileIntervalMs?: number;
  /** Close a connection when accepting one frame takes longer (default 30 seconds). */
  sendTimeoutMs?: number;
}

const pageLifetime = 30 * 60_000;
const maxPages = 1024;

export function createLiveRuntime<
  User extends Principal,
  Event extends Topic,
  Markup,
>({
  renderer,
  pubsub,
  onDiagnostic,
  reconcileIntervalMs,
  sendTimeoutMs = 30_000,
}: LiveRuntimeOptions<Event, Markup>) {
  if (
    reconcileIntervalMs !== undefined &&
    (!Number.isSafeInteger(reconcileIntervalMs) ||
      reconcileIntervalMs < 1 ||
      reconcileIntervalMs > 2_147_483_647)
  ) {
    throw new RangeError("Invalid Live View reconciliation interval");
  }
  if (
    !Number.isSafeInteger(sendTimeoutMs) ||
    sendTimeoutMs < 1 ||
    sendTimeoutMs > 2_147_483_647
  )
    throw new RangeError("Invalid Live View send timeout");
  const pages = new Map<string, PageSession<User, Event>>();
  const definitions = new Map<string, RegisteredView<User, Event, Markup>>();
  const registered = new WeakSet<object>();
  const registry: ViewRegistry<User, Event, Markup> = {
    shared: new WeakMap(),
    register(definition) {
      const { name } = definition;
      if (!identifierPattern.test(name))
        throw new Error(`Invalid Live View name: ${name}`);
      if (definitions.has(name))
        throw new Error(`Duplicate Live View name: ${name}`);
      definitions.set(name, definition);
      registered.add(definition);
    },
    identify(definition) {
      if (!registered.has(definition))
        throw new Error(`Unregistered Live View: ${definition.name}`);
      return definition.name;
    },
    resolve: (name) => definitions.get(name),
  };

  function evict(token: string, page: PageSession<User, Event>) {
    pages.delete(token);
    page.close?.();
  }

  return {
    live<Params, Data, const Name extends string = never>(
      this: void,
      definition: LiveView<Params, Data, User, Event, Markup> & NamedView<Name>
    ): LiveView<Params, Data, User, Event, Markup> {
      registry.register(definition);
      return definition;
    },
    liveShared<
      Params,
      Data extends SharedValue,
      const Name extends string = never,
    >(
      this: void,
      definition: SharedLiveView<Params, Data, User, Event, Markup> &
        NamedView<Name>,
      options?: SharedLoadOptions<Params, Data, User>
    ): SharedLiveView<Params, Data, User, Event, Markup> {
      if (!options) {
        registry.register(definition);
        return definition;
      }
      const inFlight = new Map<string, Promise<Data>>();
      const revision = definition.revision?.bind(definition);
      const key = definition.key?.bind(definition);
      const shared: SharedLiveView<Params, Data, User, Event, Markup> = {
        name: definition.name,
        ...(key && { key }),
        authorize: (params, user) => definition.authorize(params, user),
        subscribe: (params, user) => definition.subscribe(params, user),
        renderShared: (data) => definition.renderShared(data),
        ...(revision && { revision }),
        async load(params: Params, user: User) {
          const snapshot = await options.shareLoad(params, user);
          if (!snapshot) return definition.load(params, user);

          const { scope, revision } = snapshot;
          const key = JSON.stringify([
            scope,
            typeof revision,
            String(revision),
          ]);
          const current = inFlight.get(key);
          if (current) return current;

          const pending = Promise.resolve()
            .then(() => snapshot.load())
            .finally(() => {
              inFlight.delete(key);
            });
          inFlight.set(key, pending);
          return pending;
        },
      };
      registry.register(shared);
      return shared;
    },
    async publish(this: void, event: Event) {
      try {
        await pubsub.publish(event);
      } catch (error) {
        report(onDiagnostic, { type: "publish-error", topic: event });
        throw error;
      }
      report(onDiagnostic, { type: "publish", topic: event });
    },
    async renderPage(
      user: User,
      render: (
        context: LiveRenderContext<User, Event, Markup>,
        token: string
      ) => Markup | Promise<Markup>
    ): Promise<string> {
      const token = crypto.randomUUID();
      const views = new Map<string, ViewInstance<User, Event>>();
      let count = 0;
      const context = renderContext(
        renderer,
        user,
        views,
        "initial",
        () => {
          if (++count > maxViews) throw new Error("Too many Live Views");
        },
        registry
      );
      const document = await renderer.serialize(render(context, token));

      const now = Date.now();
      for (const [key, page] of pages) {
        if (now - page.touched >= pageLifetime) evict(key, page);
      }
      if (pages.size >= maxPages) {
        const oldest = Array.from(pages).reduce((a, b) =>
          a[1].touched <= b[1].touched ? a : b
        );
        evict(...oldest);
      }
      pages.set(token, {
        sessionId: user.sessionId,
        views,
        touched: now,
        version: 0,
      });
      return document;
    },
    openPage(
      token: string,
      keys: readonly string[],
      user: User
    ): OpenPage<User> {
      const page = pages.get(token);
      if (!page || Date.now() - page.touched >= pageLifetime)
        return { status: "expired" };
      if (page.sessionId !== user.sessionId) return { status: "denied" };
      if (keys.length === 0 || keys.length > maxViews)
        return { status: "invalid-count" };

      const views = new Map<string, ViewInstance<User, Event>>();
      for (const key of keys) {
        const view = page.views.get(key);
        if (!view) return { status: "unknown-view" };
        views.set(key, view);
      }
      return {
        status: "open",
        async connect(connection, refreshUser) {
          if (connection.signal.aborted) return;
          if (
            pages.get(token) !== page ||
            Date.now() - page.touched >= pageLifetime
          ) {
            await connection.send({ type: "reset" });
            return;
          }
          page.close?.();
          const close = () => connection.close();
          page.close = close;
          const initialSnapshots = new Map<string, LeafSnapshot>();
          for (const [key, view] of page.views) {
            if (view.initialSnapshot && views.has(key))
              initialSnapshots.set(key, view.initialSnapshot);
            delete view.initialSnapshot;
          }
          try {
            await streamPage(
              connection,
              {
                views,
                initialSnapshots,
                async refresh() {
                  const current = await refreshUser();
                  if (pages.get(token) !== page) return { status: "expired" };
                  if (current?.sessionId !== page.sessionId)
                    return { status: "denied" };
                  page.touched = Date.now();
                  return { status: "allowed", user: current };
                },
                nextVersion: () => ++page.version,
              },
              { pubsub, onDiagnostic, reconcileIntervalMs, sendTimeoutMs }
            );
          } finally {
            if (page.close === close) delete page.close;
          }
        },
      };
    },
  };
}
