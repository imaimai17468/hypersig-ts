import { Hono } from "hono";
import type { Context } from "hono";
import { hc } from "hono/client";
import { validator } from "hono/validator";
import * as v from "valibot";
import { createHypersig, createMemoryPubSub, topic } from "../../src/index.js";
import { createCounterSessions } from "./session.js";
import { counterKeys } from "./store.js";
import type { CounterKey, CounterStore } from "./store.js";

const keySchema = v.picklist(counterKeys);
const querySchema = v.object({
  view: v.optional(v.picklist(["edit", "display"])),
});
type CounterView = NonNullable<v.InferOutput<typeof querySchema>["view"]>;
const changed = topic("counter", (key: CounterKey) => key);

interface CounterAppOptions {
  origin: string;
  title: string;
  sessionSecret: string;
  store: CounterStore;
  development?: boolean;
}

export function createCounterApp({
  origin,
  title,
  sessionSecret,
  store,
  development = false,
}: CounterAppOptions) {
  const sessions = createCounterSessions(sessionSecret, origin);
  const hypersig = createHypersig({
    origin,
    pubsub: createMemoryPubSub<ReturnType<typeof changed>>(),
    authenticate: (request) => sessions.authenticate(request),
  });

  const increment = hypersig.action("increment", {
    input: v.object({ counterKey: keySchema }),
    output: v.number(),
    authorize: () => true,
    async execute({ counterKey }) {
      const value = await store.increment(counterKey);
      await hypersig.publish(changed(counterKey));
      return value;
    },
  });

  const counter = hypersig.live({
    name: "counter",
    key: ({ key }: { key: CounterKey }) => key,
    subscribe: ({ key }) => [changed(key)],
    authorize: () => true,
    load: ({ key }) => store.read(key),
    render: (value) => <output id="counter-value">{value}</output>,
  });

  const app = new Hono()
    .route("/", hypersig.routes)
    .get("/", (c) => renderPage(c, "main", "edit"))
    .get(
      "/counters/:counterKey",
      validator("query", (query, c) => {
        const parsed = v.safeParse(querySchema, query);
        return parsed.success ? parsed.output : c.text("Invalid view", 400);
      }),
      async (c) => {
        const parsed = v.safeParse(keySchema, c.req.param("counterKey"));
        if (!parsed.success) return c.notFound();
        return renderPage(
          c,
          parsed.output,
          c.req.valid("query").view ?? "edit"
        );
      }
    );
  const links = hc<typeof app>("/");
  const counterLink = (counterKey: CounterKey, view?: CounterView) =>
    links.counters[":counterKey"].$path({
      param: { counterKey },
      query: { view },
    });

  async function renderPage(
    c: Context,
    key: CounterKey,
    view: CounterView
  ): Promise<Response> {
    if (!(await sessions.authenticate(c.req.raw))) {
      await sessions.issue(c);
      const { pathname, search } = new URL(c.req.url);
      return c.redirect(pathname + search);
    }

    const connections = development
      ? `'self' ${origin.replace(/^http/, "ws")}`
      : "'self'";

    const response = await hypersig.page(c.req.raw, (page) => (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
          {development && <script type="module" src="/@vite/client"></script>}
          {page.runtime(
            development ? "/runtime.ts" : "/assets/hypersig-runtime.js"
          )}
        </head>
        <body>
          <main>
            <h1>{title}</h1>
            <nav aria-label="Counters">
              <a href={counterLink("main")}>Main</a>{" "}
              <a href={counterLink("other")}>Other</a>
            </nav>
            {page.view(counter, { key })}
            {view === "edit" && (
              <button type="button" {...increment.bind({ counterKey: key })}>
                Increment
              </button>
            )}
            {view === "edit" ? (
              <a href={counterLink(key, "display")}>Display only</a>
            ) : (
              <a href={counterLink(key, "edit")}>Edit view</a>
            )}
            <p role="status" data-hs-connection-status=""></p>
            <p role="alert" data-hs-error=""></p>
          </main>
        </body>
      </html>
    ));
    response.headers.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; connect-src ${connections}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    return response;
  }

  return app;
}
