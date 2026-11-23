/// <reference types="bun" />
import { Database } from "bun:sqlite";
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
const delayMs = Number(Bun.env.BENCH_READ_DELAY_MS ?? 0);
if (!Number.isSafeInteger(delayMs) || delayMs < 0)
  throw new Error("Invalid read delay");
const shareLoad = Bun.env.BENCH_SHARE_LOAD === "1";

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
let counterLoads = 0;
let independentRenders = 0;
let independentChecks = 0;
const renderTimes: number[] = [];
const db = delayMs > 0 ? new Database(":memory:") : undefined;
db?.exec(
  "CREATE TABLE snapshots (revision INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO snapshots VALUES (0, 0)"
);
const readSnapshot = db?.query<{ value: number }, [number]>(
  "SELECT value FROM snapshots WHERE revision = ?"
);

function loadCount(revision: number) {
  counterLoads++;
  if (!readSnapshot) return revision;
  return Bun.sleep(delayMs).then(() => {
    const row = readSnapshot.get(revision);
    if (!row) throw new Error("Missing benchmark snapshot");
    return row.value;
  });
}

const increment = hypersig.action("increment", {
  input: v.object({}),
  output: v.number(),
  authorize: () => true,
  async execute() {
    const next = count + 1;
    db?.run("INSERT INTO snapshots VALUES (?, ?)", [next, next]);
    count = next;
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

const counterDefinition = {
  key: () => "counter",
  subscribe: () => [changed("counter")],
  authorize: () => true,
  load: () => loadCount(count),
};

function renderCounter(value: number) {
  const started = performance.now();
  const markup = html`${(
    <>
      <output id="value">{value}</output>
      {profile === "coarse" && <Catalog />}
    </>
  )}`;
  renderTimes.push(performance.now() - started);
  return markup;
}

const counter =
  shareLoad || Bun.env.BENCH_SHARE_RENDER === "1"
    ? hypersig.liveShared(
        { ...counterDefinition, renderShared: renderCounter },
        shareLoad
          ? {
              shareLoad() {
                const revision = count;
                return {
                  scope: "counter",
                  revision,
                  load: () => loadCount(revision),
                };
              },
            }
          : undefined
      )
    : hypersig.live({ ...counterDefinition, render: renderCounter });

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
          {"renderShared" in counter
            ? page.view(counter, {})
            : page.view(counter, {})}
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
    counterLoads,
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
