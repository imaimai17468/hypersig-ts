// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createClient } from "redis";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createLiveRuntime, topic } from "./core.js";
import type { LiveMessage, LiveRenderer, Principal } from "./core.js";
import { createRedisPubSub } from "./redis.js";

const redisServer = process.env.REDIS_SERVER ?? "redis-server";
const hasRedisServer = !spawnSync(redisServer, ["--version"]).error;
if (!hasRedisServer && process.env.REDIS_REQUIRED === "1")
  throw new Error(
    `REDIS_REQUIRED=1 but ${redisServer} was not found. Install Redis or set REDIS_SERVER.`
  );
if (!hasRedisServer)
  console.warn(
    `Skipping the Redis integration tests: ${redisServer} was not found. Install Redis or set REDIS_SERVER.`
  );

async function findFreePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP address");
  return address.port;
}

let url = "";
let stopServer = async () => {};

beforeAll(async () => {
  if (!hasRedisServer) return;
  const port = await findFreePort();
  const server = spawn(
    redisServer,
    ["--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" }
  );
  const exited = once(server, "exit");
  stopServer = async () => {
    server.kill();
    await exited;
  };
  url = `redis://127.0.0.1:${port}`;
  const probe = createClient({
    url,
    socket: { reconnectStrategy: (retries) => (retries > 100 ? false : 50) },
  });
  probe.on("error", () => {});
  await probe.connect();
  probe.destroy();
});

afterAll(() => stopServer());

const renderer: LiveRenderer<string> = {
  empty: () => "",
  boundary: (target, html) => `<div data-target="${target}">${html}</div>`,
  serialize: async (value) => value,
};
const counterChanged = topic("counter", () => "shared");
type CounterEvent = ReturnType<typeof counterChanged>;

/** One application process: its own Redis connections, runtime and view. */
async function startProcess(channelPrefix: string) {
  const client = createClient({ url });
  const subscriber = client.duplicate();
  const pubsub = createRedisPubSub<CounterEvent>({
    channelPrefix,
    publish: (channel, message) => client.publish(channel, message),
    async subscribe(channel, onMessage) {
      const listener = () => onMessage();
      await subscriber.subscribe(channel, listener);
      return () => subscriber.unsubscribe(channel, listener);
    },
  });
  client.on("error", () => {});
  subscriber.on("error", () => pubsub.disconnected());
  await Promise.all([client.connect(), subscriber.connect()]);
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub,
  });
  const view = runtime.live({
    name: "counter",
    subscribe: () => [counterChanged()],
    authorize: () => true,
    load: async () => Number((await client.get("count")) ?? 0),
    render: String,
  });
  return {
    client,
    runtime,
    async open() {
      const user = { sessionId: "viewer" };
      const document = await runtime.renderPage(
        user,
        async (page, token) =>
          `<script data-token="${token}"></script>` +
          (await page.view(view, {}))
      );
      const token = /data-token="([^"]+)"/.exec(document)?.[1];
      if (!token) throw new Error("Expected a page token in the document");
      const registered = await runtime.openPage(
        token,
        { views: ["counter"], pristine: [] },
        user
      );
      if (registered.status !== "open")
        throw new Error("Expected a registered page");
      const lifetime = new AbortController();
      const channel = new TransformStream<LiveMessage, LiveMessage>();
      const reader = channel.readable.getReader();
      const writer = channel.writable.getWriter();
      const close = () => {
        lifetime.abort();
        void writer.abort().catch(() => {});
      };
      const live = registered.connect(
        {
          signal: lifetime.signal,
          send: (message) => writer.write(message),
          close,
        },
        () => user
      );
      return {
        async read() {
          const { done, value } = await reader.read();
          if (done) throw new Error("Expected a live message");
          return value;
        },
        async close() {
          close();
          await live;
        },
      };
    },
    close() {
      client.destroy();
      subscriber.destroy();
    },
  };
}

it.skipIf(!hasRedisServer)(
  "delivers a publication from one process to a view on another through Redis",
  async () => {
    const prefix = "deliver:";
    const a = await startProcess(prefix);
    const b = await startProcess(prefix);
    const other = await startProcess("other-app:");
    try {
      await a.client.set("count", "0");
      const page = await b.open();
      const unrelated = await other.open();
      await page.read();
      await expect(page.read()).resolves.toEqual({ type: "ready" });
      await unrelated.read();
      await expect(unrelated.read()).resolves.toEqual({ type: "ready" });

      await a.client.set("count", "1");
      await a.runtime.publish(counterChanged());
      await expect(page.read()).resolves.toMatchObject({
        type: "update",
        update: { html: "1" },
      });

      // Another prefix names other channels, so this publication reaches only it.
      await a.client.set("count", "2");
      await other.runtime.publish(counterChanged());
      await expect(unrelated.read()).resolves.toMatchObject({
        type: "update",
        update: { html: "2" },
      });
      await a.client.set("count", "3");
      await a.runtime.publish(counterChanged());
      await expect(page.read()).resolves.toMatchObject({
        type: "update",
        update: { html: "3" },
      });
      await page.close();
      await unrelated.close();
    } finally {
      a.close();
      b.close();
      other.close();
    }
  }
);

it.skipIf(!hasRedisServer)(
  "subscribes again after Redis drops the subscriber and re-reads the change it missed",
  async () => {
    const prefix = "reconnect:";
    const a = await startProcess(prefix);
    const b = await startProcess(prefix);
    try {
      await a.client.set("count", "10");
      const page = await b.open();
      await page.read();
      await expect(page.read()).resolves.toEqual({ type: "ready" });

      // Commit without a publication, as if it was published during the outage.
      await a.client.set("count", "11");
      await a.client.clientKill({ filter: "TYPE", type: "pubsub" });
      await expect(page.read()).resolves.toMatchObject({
        type: "update",
        update: { html: "11" },
      });

      await a.client.set("count", "12");
      await a.runtime.publish(counterChanged());
      await expect(page.read()).resolves.toMatchObject({
        type: "update",
        update: { html: "12" },
      });
      await page.close();
    } finally {
      a.close();
      b.close();
    }
  }
);
