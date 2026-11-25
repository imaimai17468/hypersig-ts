/// <reference types="bun" />
import { afterAll, beforeAll, expect, test } from "bun:test";
import { topic } from "../../src/index.js";
import { connectRedis } from "./redis.js";

const redisServer = Bun.env.REDIS_SERVER ?? "redis-server";
const hasRedisServer = Bun.which(redisServer) !== null;
if (!hasRedisServer && Bun.env.REDIS_REQUIRED === "1")
  throw new Error(
    `REDIS_REQUIRED=1 but ${redisServer} was not found. Install Redis or set REDIS_SERVER.`
  );
if (!hasRedisServer)
  console.warn(
    `Skipping the Bun.RedisClient check: ${redisServer} was not found. Install Redis or set REDIS_SERVER.`
  );

const changed = topic("counter", () => "shared");
type CounterEvent = ReturnType<typeof changed>;
let server: Bun.Subprocess | undefined;
let url = "";

beforeAll(async () => {
  if (!hasRedisServer) return;
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = probe.port;
  probe.stop(true);
  server = Bun.spawn(
    [redisServer, "--port", String(port), "--save", "", "--appendonly", "no"],
    { stdout: "ignore", stderr: "ignore" }
  );
  url = `redis://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const connection = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      connection.end();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(50);
    }
  }
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
});

/** Resolves with the next call of the returned callback. */
function nextCall() {
  let call = () => {};
  const called = new Promise<void>((resolve) => {
    call = resolve;
  });
  return { called, call: () => call() };
}

test.skipIf(!hasRedisServer)(
  "delivers between two Bun.RedisClient processes and reports a dropped subscriber",
  async () => {
    const a = await connectRedis<CounterEvent>(url);
    const b = await connectRedis<CounterEvent>(url);
    try {
      let notified = nextCall();
      let lost = nextCall();
      const stop = await b.pubsub.subscribe(
        changed(),
        () => notified.call(),
        () => lost.call()
      );
      await a.pubsub.publish(changed());
      await notified.called;

      await a.client.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
      await lost.called;
      stop();

      notified = nextCall();
      lost = nextCall();
      await b.pubsub.subscribe(
        changed(),
        () => notified.call(),
        () => lost.call()
      );
      await a.pubsub.publish(changed());
      await notified.called;
      expect(
        await a.client.send("PUBSUB", [
          "NUMSUB",
          'hypersig:["counter","shared"]',
        ])
      ).toEqual(['hypersig:["counter","shared"]', 1]);
    } finally {
      a.close();
      b.close();
    }
  },
  10_000
);
