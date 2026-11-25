/// <reference types="bun" />
import { Context, Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import * as v from "valibot";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  errorOutlet,
  topic,
} from "../../src/index.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const app = new Hono();
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
// A fixed secret keeps sessions valid after a restart; without one, they end with the process.
const sessionSecret = Bun.env.COUNTER_SESSION_SECRET ?? crypto.randomUUID();
const sessionCookie = "counter-session";
/** Sessions that hid the shared counter, which then fails its authorization. */
const hiddenSessions = new Set<string>();
const counts = { main: 0, other: 0 };
const renders = { main: 0, other: 0 };
type CounterId = keyof typeof counts;

const counterChanged = topic("counter", (id: CounterId) => id);
const layoutChanged = topic("counter-layout", () => "nested");
const orderChanged = topic("order", () => "demo");
type CounterEvent =
  | ReturnType<typeof counterChanged>
  | ReturnType<typeof layoutChanged>
  | ReturnType<typeof orderChanged>;
const pageKey = Bun.env.HYPERSIG_PAGE_KEY;

function readSession(c: Context) {
  return getSignedCookie(c, sessionSecret, sessionCookie);
}

const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<CounterEvent>(),
  // Processes that share this key can stream each other's pages.
  ...(pageKey && { pageKeys: [pageKey] }),
  async authenticate(request) {
    const sessionId = await readSession(new Context(request));
    return sessionId ? { sessionId } : null;
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

const setMainVisible = hypersig.action("set-main-visible", {
  input: v.object({ visible: v.boolean() }),
  output: v.boolean(),
  authorize: () => true,
  async execute({ visible }, { sessionId }) {
    if (visible) hiddenSessions.delete(sessionId);
    else hiddenSessions.add(sessionId);
    await hypersig.publish(counterChanged("main"));
    return visible;
  },
});

const counter = hypersig.live({
  name: "counter",
  key: ({ id }: { id: CounterId }) => id,
  revision: ({ id }) => id,
  subscribe: ({ id }) => [counterChanged(id)],
  authorize: ({ id }, { sessionId }) =>
    id !== "main" || !hiddenSessions.has(sessionId),
  load({ id }) {
    renders[id]++;
    return counts[id];
  },
  snapshotRevision: { read: ({ id }) => counts[id], from: (count) => count },
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
            <input
              type="hidden"
              name={increment.field("counterId")}
              value={id}
            />
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
  name: "nested",
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

let order = { revision: 1, notebooks: 1 };
const priceDelayMs = Number(Bun.env.ORDER_PRICE_DELAY_MS ?? 0);
const addNotebook = hypersig.action("add-notebook", {
  input: v.object({}),
  output: v.number(),
  authorize: () => true,
  async execute() {
    const next = {
      revision: order.revision + 1,
      notebooks: order.notebooks + 1,
    };
    order = next;
    await hypersig.publish(orderChanged());
    return next.revision;
  },
});
const orderSummary = hypersig.live({
  name: "order-summary",
  subscribe: () => [orderChanged()],
  authorize: () => true,
  async load() {
    const snapshot = order;
    // Simulate asynchronous pricing while retaining the same order snapshot.
    if (priceDelayMs > 0) await Bun.sleep(priceDelayMs);
    return { ...snapshot, total: snapshot.notebooks * 500 + 200 };
  },
  render({ revision, notebooks, total }) {
    return (
      <section aria-label="注文明細">
        <h2>注文明細</h2>
        <ul data-order-lines={revision}>
          <li>
            ノート 500円 × <span id="order-quantity">{notebooks}</span>
          </li>
          <li>送料 200円</li>
        </ul>
        <p>
          合計{" "}
          <output id="order-total" data-order-total={revision}>
            {total}円
          </output>
        </p>
        <button type="button" {...addNotebook.bind({})}>
          ノートを追加
        </button>
      </section>
    );
  },
});

app.route("/", hypersig.routes);
app.on("GET", ["/", "/nested", "/order"], async (c) => {
  if (!(await readSession(c))) {
    await setSignedCookie(
      c,
      sessionCookie,
      crypto.randomUUID(),
      sessionSecret,
      {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
      }
    );
    return c.redirect(new URL(c.req.url).pathname);
  }
  const isOrder = c.req.path === "/order";
  const title = isOrder ? "注文サマリー" : "hypersig Counter";
  const response = await hypersig.page(c.req.raw, (page) => (
    <html lang={isOrder ? "ja" : "en"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {page.runtime("/runtime.js")}
      </head>
      <body>
        <main>
          <h1 id="heading">{title}</h1>
          {isOrder ? (
            page.view(orderSummary, {})
          ) : c.req.path === "/nested" ? (
            page.view(nestedCounter, {})
          ) : (
            <>
              {page.view(counter, { id: "main" })}
              {page.view(counter, { id: "other" })}
              <button
                type="button"
                {...setMainVisible.bind({ visible: false })}
              >
                Hide shared counter
              </button>
              <button type="button" {...setMainVisible.bind({ visible: true })}>
                Show shared counter
              </button>
            </>
          )}
          <p role="status" {...connectionStatusOutlet()}></p>
          <p role="alert" {...errorOutlet()}></p>
        </main>
      </body>
    </html>
  ));
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return response;
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
