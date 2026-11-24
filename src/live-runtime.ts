import { report } from "./diagnostics.js";
import type { LiveDiagnostic } from "./diagnostics.js";
import { identifierPattern } from "./identifier.js";
import type {
  LiveView,
  NamedView,
  PageRenderContext,
  Principal,
  SharedLiveView,
  SharedLoadOptions,
  SharedValue,
} from "./live.js";
import { createPageSealer, maxTokenLength } from "./page-token.js";
import type { PageClaims, PageSnapshot } from "./page-token.js";
import { isJsonValue } from "./protocol.js";
import type { JsonValue } from "./protocol.js";
import {
  createViewInstance,
  maxViews,
  renderContext,
  viewTarget,
} from "./render.js";
import type {
  LiveRenderer,
  RegisteredView,
  ViewInstance,
  ViewRegistry,
} from "./render.js";
import { streamPage } from "./stream.js";
import type { LiveConnection } from "./stream.js";
import type { PubSub, Topic } from "./topic.js";

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
  /**
   * Keys that seal page tokens, each 32 bytes in base64 or base64url. The first
   * key seals new tokens and every key opens them, so rotate by adding the new
   * key in front and removing the old one after a page lifetime. Without keys,
   * the runtime makes one at startup, and only this process can open its pages.
   * Each token takes a random 96-bit AES-GCM nonce, which stays safe for about
   * 2^32 tokens per key, so put a new key in front well before a key seals
   * that many pages: at least once a year for a busy service.
   */
  pageKeys?: readonly string[];
  /**
   * Names the application and environment that seal page tokens, such as the
   * public origin. A token opens only in a runtime given the same context, so
   * apps or environments that share `pageKeys` and sessions cannot replay each
   * other's tokens. A token from another context is `expired` with a
   * `page-token-invalid` diagnostic, as for a foreign key. Defaults to the
   * empty string; `createHypersig` defaults it to its normalized `origin`.
   */
  pageContext?: string;
  /** How long a rendered page can open a stream, counted from SSR (default 12 hours). */
  pageLifetimeMs?: number;
}

/**
 * The views a browser asks to stream, and those it still shows as SSR left
 * them. Either list longer than the Live View limit is `invalid-count`. A
 * `pristine` key outside `views` is ignored.
 */
export interface OpenPageRequest {
  views: readonly string[];
  pristine: readonly string[];
}

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
  pageKeys,
  pageContext = "",
  pageLifetimeMs = 12 * 60 * 60_000,
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
  if (!Number.isSafeInteger(pageLifetimeMs) || pageLifetimeMs < 1)
    throw new RangeError("Invalid Live View page lifetime");
  const sealer = createPageSealer(pageKeys, pageContext);
  // Closes the connection streaming each token, so a page has one stream per process.
  const connections = new Map<string, () => void>();
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
    /**
     * Renders a page and seals its top-level views into a token. `render`
     * receives a stand-in for the token, because the token holds every view
     * the page places and is sealed only after rendering ends. The stand-in is
     * replaced with the token wherever the document contains it. Throws when
     * the token would be longer than a URL can safely carry.
     */
    async renderPage(
      user: User,
      render: (
        context: PageRenderContext<User, Event, Markup>,
        token: string
      ) => Markup | Promise<Markup>
    ): Promise<string> {
      const placeholder = crypto.randomUUID();
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
      const document = await renderer.serialize(render(context, placeholder));
      const snapshots = Object.fromEntries(
        [...views].flatMap(([target, view]) =>
          view.initialSnapshot ? [[target, view.initialSnapshot]] : []
        )
      );
      const claims: PageClaims = {
        format: 1,
        sessionId: user.sessionId,
        expiresAt: Date.now() + pageLifetimeMs,
        views: [...views.values()].map((view) => ({
          name: view.definition.name,
          params: toJson(view.params, view.definition.name),
        })),
        ...(Object.keys(snapshots).length > 0 && { snapshots }),
      };
      const token = await sealer.seal(claims);
      if (token.length > maxTokenLength) {
        const names = [...new Set(claims.views.map(({ name }) => name))];
        throw new Error(
          `Live View page token is too long (${token.length} of ${maxTokenLength} characters). Pass smaller params to these views: ${names.join(", ")}`
        );
      }
      return document.split(placeholder).join(token);
    },
    /**
     * Opens the page a token sealed. A token that is altered, sealed with a key
     * this runtime does not hold, past its lifetime, or names a view the
     * runtime no longer registers is `expired`, so the browser renders the page
     * again. A view in `request.pristine` that the token holds a snapshot for
     * skips its first render when its snapshot revision has not moved since SSR.
     */
    async openPage(
      token: string,
      request: OpenPageRequest,
      user: User
    ): Promise<OpenPage<User>> {
      const opened = await sealer.open(token, Date.now());
      if (opened.status === "invalid")
        report(onDiagnostic, { type: "page-token-invalid" });
      if (opened.status !== "valid") return { status: "expired" };
      const { claims } = opened;
      if (claims.sessionId !== user.sessionId) return { status: "denied" };
      const keys = request.views;
      if (
        keys.length === 0 ||
        keys.length > maxViews ||
        request.pristine.length > maxViews
      )
        return { status: "invalid-count" };

      const rebuilt = rebuildViews(claims);
      if (rebuilt.status === "failed") {
        report(onDiagnostic, {
          type: "page-rebuild-failed",
          view: rebuilt.view,
        });
        return { status: "expired" };
      }
      const views = new Map<string, ViewInstance<User, Event>>();
      for (const key of keys) {
        const view = rebuilt.views.get(key);
        if (!view) return { status: "unknown-view" };
        views.set(key, view);
      }
      const snapshots = new Map(Object.entries(claims.snapshots ?? {}));
      const initialSnapshots = new Map<string, PageSnapshot>();
      for (const key of request.pristine) {
        const snapshot = snapshots.get(key);
        if (snapshot) initialSnapshots.set(key, snapshot);
      }
      return {
        status: "open",
        async connect(connection, refreshUser) {
          if (connection.signal.aborted) return;
          connections.get(token)?.();
          const close = () => connection.close();
          connections.set(token, close);
          let version = 0;
          try {
            await streamPage(
              connection,
              {
                views,
                initialSnapshots,
                async refresh() {
                  const current = await refreshUser();
                  if (current?.sessionId !== claims.sessionId)
                    return { status: "denied" };
                  return { status: "allowed", user: current };
                },
                nextVersion: () => ++version,
              },
              { pubsub, onDiagnostic, reconcileIntervalMs, sendTimeoutMs }
            );
          } finally {
            if (connections.get(token) === close) connections.delete(token);
          }
        },
      };
    },
  };

  /** Fails with the name of the first view that is no longer registered or no longer takes its key. */
  function rebuildViews(claims: PageClaims): RebuiltViews<User, Event> {
    const views = new Map<string, ViewInstance<User, Event>>();
    for (const { name, params } of claims.views) {
      const definition = registry.resolve(name);
      if (!definition) return { status: "failed", view: name };
      let target: string;
      try {
        target = viewTarget(name, definition, params);
      } catch {
        return { status: "failed", view: name };
      }
      if (views.has(target)) return { status: "failed", view: name };
      views.set(
        target,
        createViewInstance(definition, params, target, renderer, registry)
      );
    }
    return { status: "rebuilt", views };
  }
}

type RebuiltViews<User extends Principal, Event extends Topic> =
  | { status: "rebuilt"; views: Map<string, ViewInstance<User, Event>> }
  | { status: "failed"; view: string };

/**
 * Reads params back as the token will carry them, dropping what JSON cannot
 * hold. Throws, naming the view, for params `JSON.stringify` rejects, such as
 * a bigint, a circular value, or one nested too deeply.
 */
function toJson(params: unknown, view: string): JsonValue {
  let json: unknown;
  try {
    json = JSON.parse(JSON.stringify(params) ?? "null");
  } catch (error) {
    throw new Error(`Live View params of ${view} cannot be written as JSON`, {
      cause: error,
    });
  }
  if (!isJsonValue(json))
    throw new Error(`Expected Live View params of ${view} that JSON can hold`);
  return json;
}
