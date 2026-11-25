/// <reference types="node" />
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { arch, cpus, platform, totalmem } from "node:os";
import { createClient } from "redis";
import * as v from "valibot";

const rounds = Number(process.env.BENCH_ROUNDS ?? 25);
const warmup = 5;
const connectionCounts = (process.env.BENCH_CONNECTIONS ?? "100,300,1000")
  .split(",")
  .map(Number);
const redisServer = process.env.REDIS_SERVER ?? "redis-server";
/** Each setup is a Pub/Sub and a number of counter processes. */
const setups = (process.env.BENCH_SETUPS ?? "memory:1,redis:1,redis:2,redis:3")
  .split(",")
  .map((entry) => {
    const [pubsub, count] = entry.split(":");
    const processes = Number(count);
    if (
      (pubsub !== "memory" && pubsub !== "redis") ||
      !Number.isSafeInteger(processes) ||
      processes < 1 ||
      (pubsub === "memory" && processes !== 1)
    )
      throw new Error(`Invalid setup ${entry}`);
    return { pubsub, processes } as const;
  });
if (
  !Number.isSafeInteger(rounds) ||
  rounds < 1 ||
  connectionCounts.some((count) => !Number.isSafeInteger(count) || count < 1)
) {
  throw new Error("Use a positive round count and connection counts");
}

const metricsSchema = v.object({
  counts: v.object({ main: v.number(), other: v.number() }),
  renders: v.object({ main: v.number(), other: v.number() }),
  rss: v.number(),
  heapUsed: v.number(),
  cpuMicros: v.number(),
});

function quantiles(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  function at(fraction: number) {
    const value = sorted[Math.ceil(sorted.length * fraction) - 1];
    if (value === undefined) throw new Error("No benchmark samples");
    return Math.round(value * 1000) / 1000;
  }
  return { p50: at(0.5), p95: at(0.95) };
}

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

/** Waits until a child process prints `text`, or fails if it exits first. */
async function waitForOutput(child: ChildProcess, text: string) {
  const output = child.stdout;
  if (!output) throw new Error("Expected piped output");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${text}"`)),
      15_000
    );
    output.on("data", (chunk: Buffer) => {
      if (!chunk.toString().includes(text)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Exited before printing "${text}"`));
    });
  });
}

/** Every child still running, stopped as well if the benchmark crashes. */
const children = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of children) child.kill();
});

async function startProcess(command: string, args: string[], env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  const exited = once(child, "exit").finally(() => children.delete(child));
  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

/** Starts a session, as a new browser does on its first visit. */
async function logIn(origin: URL) {
  const response = await fetch(origin, { redirect: "manual" });
  await response.arrayBuffer();
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  return cookie;
}

async function startCounter(env: Record<string, string>) {
  const port = await findFreePort();
  const server = await startProcess("bun", ["examples/counter/server.tsx"], {
    ...env,
    PORT: String(port),
    COUNTER_METRICS: "1",
  });
  try {
    await waitForOutput(server.child, "Counter listening");
  } catch (error) {
    await server.stop();
    throw error;
  }
  const origin = new URL(`http://127.0.0.1:${port}`);
  // An Action needs a session, and the publisher uses one of its own.
  const cookie = await logIn(origin);
  return {
    origin,
    cookie,
    stop: () => server.stop(),
    async metrics(collect = false) {
      const response = await fetch(
        new URL(collect ? "/metrics?gc=1" : "/metrics", origin)
      );
      return v.parse(metricsSchema, await response.json());
    },
  };
}
type Counter = Awaited<ReturnType<typeof startCounter>>;

async function attachConnection(counter: Counter) {
  const signal = AbortSignal.timeout(600_000);
  // A session keeps a limited number of streams, so each connection is a
  // visitor of its own.
  const headers = { Cookie: await logIn(counter.origin) };
  const page = await fetch(counter.origin, { headers, signal });
  if (!page.ok) throw new Error(`SSR failed: ${page.status}`);
  const document = await page.text();
  const endpoint = /data-hs-stream="([^"]+)"/.exec(document)?.[1];
  if (!endpoint) throw new Error("Missing SSE endpoint");
  const url = new URL(endpoint, counter.origin);
  for (const key of ["counter.main", "counter.other"])
    url.searchParams.append("view", key);
  const response = await fetch(url, { headers, signal });
  if (!response.ok || !response.body)
    throw new Error(`SSE failed: ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function readFrame() {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const frame = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 2);
        return frame;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("Stream closed");
      buffer += value;
    }
  }
  try {
    for (let ready = false; !ready;)
      ready = (await readFrame()).startsWith("event: ready\n");
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  return {
    close: () => reader.cancel(),
    /** Resolves with the time the update carrying `value` arrived. */
    async readUpdate(value: number) {
      let frame: string;
      do {
        frame = await readFrame();
      } while (frame.startsWith(":"));
      if (
        !frame.startsWith(
          'event: html-update\ndata: {"target":"counter.main",'
        ) ||
        !frame.includes(`data-count=\\"main\\">${value}</output>`)
      ) {
        throw new Error(
          `Unexpected frame while waiting for value ${value}: ${frame.slice(0, 160)}`
        );
      }
      return performance.now();
    },
  };
}
type Connection = Awaited<ReturnType<typeof attachConnection>>;

async function increment(counter: Counter) {
  const response = await fetch(
    new URL("/_hypersig/actions/increment", counter.origin),
    {
      method: "POST",
      headers: {
        Cookie: counter.cookie,
        Origin: counter.origin.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ counterId: "main" }),
    }
  );
  const body: unknown = await response.json();
  const { data } = v.parse(v.object({ data: v.number() }), body);
  return data;
}

async function readRedisCpuMs(url: string) {
  const client = createClient({ url });
  await client.connect();
  try {
    const info = await client.info("cpu");
    const read = (name: string) =>
      Number(new RegExp(`${name}:([\\d.]+)`).exec(info)?.[1]);
    return (read("used_cpu_user") + read("used_cpu_sys")) * 1000;
  } finally {
    client.destroy();
  }
}

async function runSetup(
  setup: (typeof setups)[number],
  connections: number,
  redisUrl: string | undefined
) {
  const env: Record<string, string> = {
    // Processes that share the key can stream each other's pages.
    HYPERSIG_PAGE_KEY: Buffer.alloc(32, 7).toString("base64"),
    COUNTER_SESSION_SECRET: "multi-instance-bench",
    ...(setup.pubsub === "redis" && redisUrl && { REDIS_URL: redisUrl }),
  };
  const counters: Counter[] = [];
  const peers: Connection[][] = [];
  try {
    for (let i = 0; i < setup.processes; i++)
      counters.push(await startCounter(env));
    for (const _ of counters) peers.push([]);
    // Spread the connections over the processes, a few at a time.
    for (let attached = 0; attached < connections;) {
      const batch = Math.min(50, connections - attached);
      const results = await Promise.allSettled(
        Array.from({ length: batch }, async (_, offset) => {
          const index = (attached + offset) % counters.length;
          const counter = counters[index];
          if (!counter) throw new Error("Missing counter");
          const connection = await attachConnection(counter);
          peers[index]?.push(connection);
        })
      );
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
      attached += batch;
    }
    const publisher = counters[0];
    if (!publisher) throw new Error("Missing publisher");
    const publish = () => increment(publisher);
    const startValue = (await publisher.metrics()).counts.main;

    async function sample(value: number) {
      const started = performance.now();
      const deliveries = peers.map((group) =>
        Promise.all(group.map((peer) => peer.readUpdate(value)))
      );
      const action = publish().then((result) => {
        if (result !== value)
          throw new Error(`Expected ${value} from the Action, got ${result}`);
        return performance.now();
      });
      const [actionAt, ...arrivals] = await Promise.all([
        action,
        ...deliveries,
      ]);
      const ends = arrivals.map((times) => Math.max(...times));
      return {
        actionMs: actionAt - started,
        allDeliveryMs: Math.max(...ends) - started,
        /** Per process, the time until its last connection received the update. */
        processDeliveryMs: ends.map((end) => end - started),
      };
    }

    let value = startValue;
    for (let i = 0; i < warmup; i++) await sample(++value);
    const before = await Promise.all(counters.map((c) => c.metrics(true)));
    const redisCpuBefore =
      redisUrl && setup.pubsub === "redis"
        ? await readRedisCpuMs(redisUrl)
        : undefined;
    const samples: Awaited<ReturnType<typeof sample>>[] = [];
    const driverCpuBefore = process.cpuUsage();
    const measured = performance.now();
    for (let i = 0; i < rounds; i++) samples.push(await sample(++value));
    const wallMs = performance.now() - measured;
    const driverCpu = process.cpuUsage(driverCpuBefore);
    const redisCpuAfter =
      redisUrl && setup.pubsub === "redis"
        ? await readRedisCpuMs(redisUrl)
        : undefined;
    const after = await Promise.all(counters.map((c) => c.metrics(true)));
    const renders = after.reduce(
      (total, metrics, index) =>
        total + metrics.renders.main - (before[index]?.renders.main ?? 0),
      0
    );
    if (renders !== connections * rounds)
      throw new Error(
        `Expected ${connections * rounds} renders, got ${renders}`
      );
    const cpuMs = after.map(
      (metrics, index) =>
        (metrics.cpuMicros - (before[index]?.cpuMicros ?? 0)) / 1000
    );
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
      pubsub: setup.pubsub,
      processes: setup.processes,
      connections,
      connectionsPerProcess: peers.map((group) => group.length),
      rounds,
      warmup,
      actionMs: quantiles(samples.map((s) => s.actionMs)),
      allDeliveryMs: quantiles(samples.map((s) => s.allDeliveryMs)),
      /** The publishing process, then each other process. */
      processDeliveryMs: counters.map((_, index) =>
        quantiles(samples.map((s) => s.processDeliveryMs[index] ?? NaN))
      ),
      updatesPerSecond: round((rounds * 1000) / wallMs),
      counterCpuMsPerUpdate: cpuMs.map((ms) => round(ms / rounds)),
      /** This script, which reads every stream, is part of what is measured. */
      driverCpuMsPerUpdate: round(
        (driverCpu.user + driverCpu.system) / 1000 / rounds
      ),
      redisCpuMsPerUpdate:
        redisCpuBefore !== undefined && redisCpuAfter !== undefined
          ? round((redisCpuAfter - redisCpuBefore) / rounds)
          : null,
      rssMiB: after.map((metrics) => round(metrics.rss / 2 ** 20)),
      heapMiB: after.map((metrics) => round(metrics.heapUsed / 2 ** 20)),
    };
  } finally {
    // Stopping the servers first leaves the closed sockets waiting on their
    // side, so the ports of this script are free for the next setup.
    await Promise.allSettled(counters.map((counter) => counter.stop()));
    await Promise.allSettled(peers.flat().map((peer) => peer.close()));
  }
}

const needsRedis = setups.some((setup) => setup.pubsub === "redis");
const redisPort = await findFreePort();
const redis = needsRedis
  ? await startProcess(redisServer, [
      "--port",
      String(redisPort),
      "--save",
      "",
      "--appendonly",
      "no",
    ])
  : undefined;
const stopRedis = () => redis?.stop();
try {
  if (redis) await waitForOutput(redis.child, "Ready to accept connections");
  const redisUrl = redis ? `redis://127.0.0.1:${redisPort}` : undefined;
  const versions = await Promise.all(
    [
      ["bun", "--version"],
      [redisServer, "--version"],
    ].map(async ([command, ...args]) => {
      if (!command) return "";
      const child = spawn(command, args);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      await once(child, "exit");
      return output.trim();
    })
  );
  console.log(
    JSON.stringify({
      node: process.version,
      bun: versions[0],
      redis: versions[1]?.match(/v=([\d.]+)/)?.[1],
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      rounds,
      warmup,
    })
  );
  for (const connections of connectionCounts) {
    for (const setup of setups) {
      if (redisUrl && setup.pubsub === "redis") {
        const client = createClient({ url: redisUrl });
        await client.connect();
        await client.flushAll();
        client.destroy();
      }
      console.log(JSON.stringify(await runSetup(setup, connections, redisUrl)));
    }
  }
} finally {
  await stopRedis();
}
