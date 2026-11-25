import { expect, it, vi } from "vite-plus/test";
import { createLiveRuntime, topic } from "./core.js";
import type { LiveMessage, LiveRenderer, Principal } from "./core.js";
import { createRedisPubSub } from "./redis.js";

const counterChanged = topic("counter", (id: string) => id);
type CounterEvent = ReturnType<typeof counterChanged>;

/** Stands in for a Redis server and client, with each call recorded. */
function createFakeRedis() {
  const channels = new Map<string, Set<() => void>>();
  const calls: string[] = [];
  let pendingSubscribe: Promise<void> | undefined;
  let failSubscribe: Error | undefined;
  let failUnsubscribe: Error | undefined;

  return {
    calls,
    channels,
    /** Hold every subscription until the returned function is called. */
    holdSubscriptions() {
      let release = () => {};
      pendingSubscribe = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        pendingSubscribe = undefined;
        release();
      };
    },
    failNextSubscribe(error: Error) {
      failSubscribe = error;
    },
    failNextUnsubscribe(error: Error) {
      failUnsubscribe = error;
    },
    options: {
      async publish(channel: string, message: string) {
        calls.push(`publish ${channel} ${JSON.stringify(message)}`);
        for (const listener of channels.get(channel) ?? []) listener();
        return 1;
      },
      async subscribe(channel: string, onMessage: () => void) {
        calls.push(`subscribe ${channel}`);
        await pendingSubscribe;
        if (failSubscribe) {
          const error = failSubscribe;
          failSubscribe = undefined;
          throw error;
        }
        const listener = () => onMessage();
        const listeners = channels.get(channel) ?? new Set();
        listeners.add(listener);
        channels.set(channel, listeners);
        return async () => {
          calls.push(`unsubscribe ${channel}`);
          if (failUnsubscribe) {
            const error = failUnsubscribe;
            failUnsubscribe = undefined;
            throw error;
          }
          listeners.delete(listener);
          if (listeners.size === 0) channels.delete(channel);
        };
      },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("names each channel by the prefix and the Topic and sends an empty message", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const custom = createRedisPubSub<CounterEvent>({
    ...redis.options,
    channelPrefix: "app-a:",
  });
  const received: string[] = [];
  await pubsub.subscribe(counterChanged("main"), () => received.push("main"));
  await custom.subscribe(counterChanged("main"), () => received.push("app-a"));

  await pubsub.publish(counterChanged("main"));
  await pubsub.publish(counterChanged("other"));
  await custom.publish(counterChanged("main"));

  expect(redis.calls).toEqual([
    'subscribe hypersig:["counter","main"]',
    'subscribe app-a:["counter","main"]',
    'publish hypersig:["counter","main"] ""',
    'publish hypersig:["counter","other"] ""',
    'publish app-a:["counter","main"] ""',
  ]);
  expect(received).toEqual(["main", "app-a"]);
});

it("resolves publish once the client has sent the message", async () => {
  let accept = () => {};
  const pubsub = createRedisPubSub<CounterEvent>({
    publish: () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
    subscribe: async () => () => {},
  });
  let isPublished = false;
  const published = pubsub.publish(counterChanged("main")).then(() => {
    isPublished = true;
  });
  await flush();
  expect(isPublished).toBe(false);
  accept();
  await published;
  expect(isPublished).toBe(true);
});

it("shares one Redis subscription per Topic and ends it with the last listener", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const received: string[] = [];
  const stopFirst = await pubsub.subscribe(counterChanged("main"), () =>
    received.push("first")
  );
  const stopSecond = await pubsub.subscribe(counterChanged("main"), () =>
    received.push("second")
  );
  await pubsub.publish(counterChanged("main"));
  stopFirst();
  await flush();
  await pubsub.publish(counterChanged("main"));
  expect(received).toEqual(["first", "second", "second"]);
  expect(redis.calls.filter((call) => call.startsWith("subscribe"))).toEqual([
    'subscribe hypersig:["counter","main"]',
  ]);
  expect(redis.calls).not.toContain('unsubscribe hypersig:["counter","main"]');

  stopSecond();
  await flush();
  expect(redis.calls).toContain('unsubscribe hypersig:["counter","main"]');
  expect(redis.channels.size).toBe(0);
});

it("ends every subscription on disconnected(), including one waiting for Redis", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const lost: string[] = [];
  await pubsub.subscribe(
    counterChanged("main"),
    () => {},
    () => lost.push("main")
  );
  const release = redis.holdSubscriptions();
  const waiting = pubsub.subscribe(
    counterChanged("other"),
    () => {},
    () => lost.push("other")
  );
  await flush();

  pubsub.disconnected();
  expect(lost).toEqual(["main", "other"]);
  release();
  await waiting;
  await flush();
  // Both ended, so neither keeps a channel open on the client.
  expect(redis.channels.size).toBe(0);

  // A later call reaches only subscriptions made after the previous one.
  const renewed: string[] = [];
  await pubsub.subscribe(
    counterChanged("main"),
    () => renewed.push("notified"),
    () => renewed.push("lost")
  );
  await pubsub.publish(counterChanged("main"));
  pubsub.disconnected();
  expect(renewed).toEqual(["notified", "lost"]);
  expect(lost).toEqual(["main", "other"]);
});

it("rejects a failed subscription and leaves it out of disconnected()", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const lost: string[] = [];
  redis.failNextSubscribe(new Error("broker unavailable"));
  await expect(
    pubsub.subscribe(
      counterChanged("main"),
      () => {},
      () => lost.push("failed")
    )
  ).rejects.toThrow("broker unavailable");
  pubsub.disconnected();
  expect(lost).toEqual([]);
});

it("logs a failure to end a subscription instead of throwing it", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const stop = await pubsub.subscribe(counterChanged("main"), () => {});
    redis.failNextUnsubscribe(new Error("connection closed"));
    stop();
    await flush();
    expect(log).toHaveBeenCalledWith(new Error("connection closed"));
  } finally {
    log.mockRestore();
  }
});

const renderer: LiveRenderer<string> = {
  empty: () => "",
  boundary: (target, html) => `<div data-target="${target}">${html}</div>`,
  serialize: async (value) => value,
};

it("makes the live runtime subscribe again and re-read a view after disconnected()", async () => {
  const redis = createFakeRedis();
  const pubsub = createRedisPubSub<CounterEvent>(redis.options);
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub,
  });
  let count = 0;
  const view = runtime.live({
    name: "counter",
    subscribe: () => [counterChanged("main")],
    authorize: () => true,
    load: () => count,
    render: String,
  });
  const user = { sessionId: "viewer" };
  const document = await runtime.renderPage(
    user,
    async (page, pageToken) =>
      `<script data-token="${pageToken}"></script>` +
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
  const read = async () => {
    const { done, value } = await reader.read();
    if (done) throw new Error("Expected a live message");
    return value;
  };
  const live = registered.connect(
    {
      signal: lifetime.signal,
      send: (message) => writer.write(message),
      close: () => {
        lifetime.abort();
        void writer.abort().catch(() => {});
      },
    },
    () => user
  );
  try {
    await read();
    await expect(read()).resolves.toEqual({ type: "ready" });
    // A change committed while the connection is down sends no message.
    count = 1;
    pubsub.disconnected();
    await expect(read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1" },
    });
    expect(
      redis.calls.filter((call) => call.startsWith("subscribe"))
    ).toHaveLength(2);
    count = 2;
    await pubsub.publish(counterChanged("main"));
    await expect(read()).resolves.toMatchObject({
      type: "update",
      update: { html: "2" },
    });
  } finally {
    lifetime.abort();
    void writer.abort().catch(() => {});
    await live;
  }
});
