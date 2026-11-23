/// <reference types="bun" />
import { Hono } from "hono";
import { html } from "hono/html";
import * as v from "valibot";
import { createHypersig, createMemoryPubSub, topic } from "../src/index.js";

const profile = Bun.env.BENCH_PROFILE;
if (profile !== "coarse" && profile !== "fine")
  throw new Error("Invalid bench profile");
const rows = Number(Bun.env.BENCH_ROWS ?? 500);
if (!Number.isSafeInteger(rows) || rows < 1)
  throw new Error("Invalid row count");

const app = new Hono();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: (request) => app.fetch(request),
});
const origin = `http://127.0.0.1:${server.port}`;
const runtime = Bun.file(new URL("../dist/runtime.js", import.meta.url));

const changed = topic("bench", (key: "counter" | "independent") => key);
const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<ReturnType<typeof changed>>(),
  authenticate: () => ({ sessionId: "benchmark" }),
});

let count = 0;
let independentRenders = 0;
let independentChecks = 0;
const renderTimes: number[] = [];

const increment = hypersig.action("increment", {
  input: v.object({}),
  output: v.number(),
  authorize: () => true,
  async execute() {
    const next = ++count;
    await hypersig.publish(changed("counter"));
    return next;
  },
});

function Catalog() {
  return (
    <ul aria-label="Reference items">
      {Array.from({ length: rows }, (_, index) => (
        <li id={`reference-${index}`}>Reference item {index + 1}</li>
      ))}
    </ul>
  );
}

const counter = hypersig.live({
  key: () => "counter",
  subscribe: () => [changed("counter")],
  authorize: () => true,
  load: () => count,
  render(value) {
    const started = performance.now();
    const markup = html`${(
      <>
        <output id="value">{value}</output>
        {profile === "coarse" && <Catalog />}
      </>
    )}`;
    renderTimes.push(performance.now() - started);
    return markup;
  },
});

const independent = hypersig.live({
  key: () => "independent",
  subscribe: () => [changed("independent")],
  authorize() {
    independentChecks++;
    return true;
  },
  load() {
    independentRenders++;
    return "Independent";
  },
  render: (value) => <p id="independent">{value}</p>,
});

app.route("/", hypersig.routes);
app.get("/", async (c) => {
  const started = performance.now();
  const response = await hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>hypersig benchmark</title>
        {page.runtime("/runtime.js")}
      </head>
      <body>
        <main>
          <button id="increment" type="button" {...increment.bind({})}>
            Increment
          </button>
          {page.view(counter, {})}
          {profile === "fine" && <Catalog />}
          {page.view(independent, {})}
        </main>
      </body>
    </html>
  ));
  response.headers.set(
    "Server-Timing",
    `ssr;dur=${performance.now() - started}`
  );
  return response;
});

app.get("/metrics", (c) => {
  if (c.req.query("gc") === "1") Bun.gc(true);
  const { rss, heapUsed } = process.memoryUsage();
  return c.json({
    renderTimes,
    independentRenders,
    independentChecks,
    rss,
    heapUsed,
  });
});
app.get("/runtime.js", (c) =>
  c.body(runtime.stream(), {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  })
);

console.log(JSON.stringify({ origin, bun: Bun.version }));
