import type { LiveRenderContext, LiveView, Principal } from "./live.js";
import { maxViews, renderContext } from "./render.js";
import type { LiveRenderer, ViewInstance } from "./render.js";
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
}

const pageLifetime = 30 * 60_000;
const maxPages = 1024;

export function createLiveRuntime<
  User extends Principal,
  Event extends Topic,
  Markup,
>({ renderer, pubsub }: LiveRuntimeOptions<Event, Markup>) {
  const pages = new Map<string, PageSession<User, Event>>();

  function evict(token: string, page: PageSession<User, Event>) {
    pages.delete(token);
    page.close?.();
  }

  return {
    live<Params, Data>(
      this: void,
      definition: LiveView<Params, Data, User, Event, Markup>
    ) {
      return definition;
    },
    publish: (event: Event) => pubsub.publish(event),
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
      const context = renderContext(renderer, user, views, "initial", () => {
        if (++count > maxViews) throw new Error("Too many Live Views");
      });
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
          try {
            await streamPage(
              connection,
              {
                views,
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
              pubsub
            );
          } finally {
            if (page.close === close) delete page.close;
          }
        },
      };
    },
  };
}
