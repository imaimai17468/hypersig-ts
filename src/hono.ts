import { Hono } from "hono";
import { html, raw } from "hono/html";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { HtmlEscapedString } from "hono/utils/html";
import { registerAction } from "./action.js";
import type { ActionDefinition } from "./action.js";
import type { LiveRuntimeOptions } from "./live-runtime.js";
import { createLiveRuntime } from "./live-runtime.js";
import type { LiveRenderContext, Principal } from "./live.js";
import { events } from "./protocol.js";
import type { LiveRenderer } from "./render.js";
import type { LiveConnection } from "./stream.js";
import type { Topic } from "./topic.js";

type Markup = HtmlEscapedString;

export type HonoLiveRenderContext<
  User extends Principal,
  Event extends Topic,
  Html = Markup,
> = LiveRenderContext<User, Event, Html>;

export interface Page<
  User extends Principal,
  Event extends Topic,
> extends LiveRenderContext<User, Event, Markup> {
  readonly user: User;
  runtime(src: string): Markup | Promise<Markup>;
}

export interface HypersigOptions<
  User extends Principal,
  Event extends Topic,
> extends Omit<LiveRuntimeOptions<Event, Markup>, "renderer"> {
  /** Public origin to compare against the Origin header of every Action. */
  origin: string;
  authenticate: (request: Request) => User | null | Promise<User | null>;
  /** Non-secret and stable across server restarts, unique to the authenticated session. */
  draftScope?: (user: User) => string;
}

const renderer: LiveRenderer<Markup> = {
  empty: () => html``,
  boundary(target, content) {
    return target.includes("/")
      ? html`<div id="hs-view-${target}" data-hs-view="${target}">
          ${raw(content)}
        </div>`
      : html`<div data-hs-view="${target}">${raw(content)}</div>`;
  },
  async serialize(markup) {
    return String(await html`${markup}`);
  },
};

function connectSse(stream: SSEStreamingApi): LiveConnection {
  const lifetime = new AbortController();
  stream.onAbort(() => lifetime.abort());
  if (stream.aborted) lifetime.abort();
  return {
    signal: lifetime.signal,
    close: () => stream.abort(),
    async send(message) {
      switch (message.type) {
        case "update":
          await stream.writeSSE({
            event: events.update,
            data: JSON.stringify(message.update),
          });
          break;
        case "view-error":
          await stream.writeSSE({
            event: events.viewError,
            data: JSON.stringify(message.target),
          });
          break;
        case "heartbeat":
          await stream.write(": heartbeat\n\n");
          break;
        case "ready":
          await stream.writeSSE({ event: events.ready, data: "{}" });
          break;
        case "reset":
          await stream.writeSSE({ event: events.reset, data: "{}" });
          break;
        case "access-denied":
          await stream.writeSSE({ event: events.denied, data: "{}" });
          break;
      }
    },
  };
}

export function createHypersig<User extends Principal, Event extends Topic>(
  options: HypersigOptions<User, Event>
) {
  const { authenticate } = options;
  const origin = new URL(options.origin).origin;
  if (!/^https?:\/\//.test(origin))
    throw new Error("Expected an HTTP(S) origin");
  const basePath = "/_hypersig";
  const routes = new Hono().basePath(basePath);
  const runtime = createLiveRuntime<User, Event, Markup>({
    ...options,
    renderer,
  });
  const actions = new Set<string>();

  routes.get(
    "/stream/:token",
    async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    },
    async (c) => {
      const request = c.req.raw;
      const user = await authenticate(request);
      if (!user) return c.text("Authentication required", 401);
      const token = c.req.param("token");
      const keys = new URL(request.url).searchParams.getAll("view");
      const page = runtime.openPage(token, keys, user);
      switch (page.status) {
        case "expired":
          return streamSSE(c, (stream) =>
            connectSse(stream).send({ type: "reset" })
          );
        case "denied":
          return c.text("Forbidden", 403);
        case "invalid-count":
          return c.text("Invalid Live View count", 400);
        case "unknown-view":
          return c.text("Unknown Live View", 400);
        case "open":
          c.header("X-Accel-Buffering", "no");
          return streamSSE(c, (stream) =>
            page.connect(connectSse(stream), () => authenticate(request))
          );
      }
    }
  );

  return {
    routes,
    live: runtime.live,
    liveShared: runtime.liveShared,
    publish: runtime.publish,
    action<Wire, Input, Value, Output>(
      name: string,
      definition: ActionDefinition<Wire, Input, Value, Output, User>
    ) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || actions.has(name)) {
        throw new Error(`Invalid or duplicate Action name: ${name}`);
      }
      actions.add(name);
      return registerAction(
        routes,
        basePath,
        name,
        origin,
        authenticate,
        definition
      );
    },
    async page(
      request: Request,
      render: (page: Page<User, Event>) => Markup | Promise<Markup>
    ) {
      const user = await authenticate(request);
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
      };
      if (!user)
        return new Response("Authentication required", {
          status: 401,
          headers,
        });

      const document = await runtime.renderPage(
        user,
        (context, token) =>
          html`<!doctype html>${render({
              user,
              ...context,
              runtime(src) {
                return html`<script
                  type="module"
                  src="${src}"
                  data-hs-stream="${basePath}/stream/${token}"
                  ${
                    options.draftScope
                      ? html`data-hs-draft-scope="${options.draftScope(user)}"`
                      : ""
                  }
                ></script>`;
              },
            })}`
      );
      return new Response(document, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}
