/// <reference types="bun" />
import { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import * as v from "valibot";
import {
  createHypersig,
  createMemoryPubSub,
  live,
  topic,
} from "../../src/index.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const app = new Hono();
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
const sessions = new Set<string>();
const counts = { main: 0, other: 0 };
const renders = { main: 0, other: 0 };
type CounterId = keyof typeof counts;

const counterChanged = topic("counter", (id: CounterId) => id);
const layoutChanged = topic("counter-layout", () => "nested");
type CounterEvent =
  | ReturnType<typeof counterChanged>
  | ReturnType<typeof layoutChanged>;
const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<CounterEvent>(),
  authenticate(request) {
    const sessionId = getCookie(new Context(request), "counter-session");
    return sessionId && sessions.has(sessionId) ? { sessionId } : null;
  },
});

const counterSchema = v.object({ counterId: v.picklist(["main", "other"]) });

const increment = hypersig.action("increment", {
  input: counterSchema,
  output: v.number(),
  authorize: (_input, _user) => true,
  async execute({ counterId }) {
    const count = ++counts[counterId];
    await hypersig.publish(counterChanged(counterId));
    return count;
  },
});

const counter = live({
  key: ({ id }: { id: CounterId }) => `counter:${id}`,
  revision: ({ id }) => id,
  subscribe: ({ id }) => [counterChanged(id)],
  authorize: (_params, _user) => true,
  load({ id }) {
    renders[id]++;
    return counts[id];
  },
  render(count, { id }) {
    return (
      <section
        aria-label={id === "main" ? "Shared counter" : "Independent counter"}
      >
        <h2>{id === "main" ? "Shared counter" : "Independent counter"}</h2>
        <output data-count={id}>{count}</output>
        {id === "main" ? (
          <button type="button" {...increment.bind({ counterId: id })}>
            Increment main
          </button>
        ) : (
          <form {...increment.form()}>
            <input type="hidden" name="counterId" value={id} />
            <button type="submit">Increment other</button>
          </form>
        )}
        {id === "main" && (
          <p>
            <label>
              Local draft <input id="draft" value="" />
            </label>
          </p>
        )}
      </section>
    );
  },
});

let isNestedVisible = false;
let isMoved = false;
const setVisibility = hypersig.action("set-counter-visible", {
  input: v.object({ visible: v.boolean() }),
  output: v.boolean(),
  authorize: () => true,
  async execute({ visible }) {
    isNestedVisible = visible;
    await hypersig.publish(layoutChanged());
    return visible;
  },
});

const moveCounter = hypersig.action("move-counter", {
  input: v.object({}),
  output: v.boolean(),
  authorize: () => true,
  async execute() {
    isMoved = !isMoved;
    await hypersig.publish(layoutChanged());
    return isMoved;
  },
});

const nestedCounter = hypersig.live({
  key: () => "nested",
  subscribe: () => [layoutChanged()],
  authorize: () => true,
  load: () => ({ visible: isNestedVisible, moved: isMoved }),
  render({ visible, moved }, _params, context) {
    const child = visible && context.view(counter, { id: "main" });
    return (
      <section>
        <button type="button" {...setVisibility.bind({ visible: !visible })}>
          {visible ? "Hide counter" : "Show counter"}
        </button>
        <button type="button" {...moveCounter.bind({})}>
          Move counter
        </button>
        <div id="original-position">{!moved && child}</div>
        <div id="moved-position">{moved && child}</div>
      </section>
    );
  },
});

app.route("/", hypersig.routes);
app.on("GET", ["/", "/nested"], async (c) => {
  const current = getCookie(c, "counter-session");
  if (!current || !sessions.has(current)) {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
    setCookie(c, "counter-session", sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect(new URL(c.req.url).pathname);
  }
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>hypersig Counter</title>
        {page.runtime("/runtime.js")}
      </head>
      <body>
        <main>
          <h1 id="heading">hypersig Counter</h1>
          {c.req.path === "/nested" ? (
            page.view(nestedCounter, {})
          ) : (
            <>
              {page.view(counter, { id: "main" })}
              {page.view(counter, { id: "other" })}
            </>
          )}
          <p role="status" data-hs-connection-status=""></p>
          <p role="alert" data-hs-error=""></p>
        </main>
      </body>
    </html>
  ));
});

app.get("/runtime.js", (c) =>
  c.body(runtime.stream(), {
    headers: { "Content-Type": "text/javascript; charSet=utf-8" },
  })
);

if (Bun.env.COUNTER_METRICS === "1") {
  app.get("/metrics", (c) => c.json({ counts, renders }));
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`Counter listening on ${origin}`);
