import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
/// <reference types="node" />
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import * as v from "valibot";

const rounds = Number(process.env.BENCH_ROUNDS ?? 25);
const shareLoad = process.env.BENCH_SHARE_LOAD === "1";
const shareRender = shareLoad || process.env.BENCH_SHARE_RENDER === "1";
const readDelayMs = Number(process.env.BENCH_READ_DELAY_MS ?? 0);
const rows = Number(process.env.BENCH_ROWS ?? 500);
const connectionCounts = (process.env.BENCH_CONNECTIONS ?? "1,25,100,200")
  .split(",")
  .map(Number);
if (
  !Number.isSafeInteger(rounds) ||
  rounds < 1 ||
  connectionCounts.some(
    (count) => !Number.isSafeInteger(count) || count < 1 || count > 999
  )
) {
  throw new Error(
    "Use a positive round count and between 1 and 999 connections"
  );
}

const startupSchema = v.object({ origin: v.string(), bun: v.string() });

const metricsSchema = v.object({
  renderTimes: v.array(v.number()),
  counterLoads: v.number(),
  independentRenders: v.number(),
  independentChecks: v.number(),
  rss: v.number(),
  heapUsed: v.number(),
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

async function readMetrics(origin: URL, collect = false) {
  const response = await fetch(
    new URL(collect ? "/metrics?gc=1" : "/metrics", origin)
  );
  return v.parse(metricsSchema, await response.json());
}

function readSsrTime(headers: Headers) {
  const duration = Number(
    headers.get("Server-Timing")?.match(/ssr;dur=([\d.]+)/)?.[1]
  );
  if (!Number.isFinite(duration)) throw new Error("Missing SSR duration");
  return duration;
}

async function attachPeer(origin: URL) {
  const signal = AbortSignal.timeout(90_000);
  const page = await fetch(origin, { signal });
  if (!page.ok) throw new Error(`SSR failed: ${page.status}`);
  const document = await page.text();
  const endpoint = /data-hs-stream="([^"]+)"/.exec(document)?.[1];
  if (!endpoint) throw new Error("Missing SSE endpoint");
  const url = new URL(endpoint, origin);
  for (const key of ["counter", "independent"])
    url.searchParams.append("view", key);
  const response = await fetch(url, { signal });
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
    for (let ready = false; !ready;) {
      const frame = await readFrame();
      ready = frame.startsWith("event: ready\n");
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }

  return {
    close: () => reader.cancel(),
    async readUpdate(value: number) {
      let frame: string;
      do {
        frame = await readFrame();
      } while (frame.startsWith(":"));
      if (
        !frame.startsWith('event: html-update\ndata: {"target":"counter",') ||
        !frame.includes(`<output id=\\"value\\">${value}</output>`)
      ) {
        throw new Error(
          `Unexpected frame while waiting for value ${value}: ${frame.slice(0, 140)}`
        );
      }
      return Buffer.byteLength(frame, "utf8");
    },
  };
}

async function timeBrowser(page: Page) {
  // Time the runtime's real listener, including sanitization and DOM morphing.
  await page.addInitScript(() => {
    const NativeEventSource = EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        const add = super.addEventListener.bind(this);
        Object.defineProperty(this, "addEventListener", {
          value: (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions
          ) => {
            if (type !== "html-update" || typeof listener !== "function") {
              add(type, listener, options);
              return;
            }
            add(
              type,
              (event) => {
                const started = performance.now();
                listener.call(this, event);
                const finished = performance.now();
                if (
                  performance.getEntriesByName("benchmark:click", "mark").length
                ) {
                  performance.measure("benchmark:fragment", {
                    start: started,
                    end: finished,
                  });
                  performance.measure("benchmark:click-to-dom", {
                    start: "benchmark:click",
                    end: finished,
                  });
                  performance.clearMarks("benchmark:click");
                }
              },
              options
            );
          },
        });
      }
    };
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.id === "increment"
        ) {
          performance.mark("benchmark:click");
        }
      },
      { capture: true }
    );
  });
}

async function runProfile(
  browser: Browser,
  profile: "coarse" | "fine",
  connections: number
) {
  const server = spawn("bun", ["bench/server.tsx"], {
    env: { ...process.env, BENCH_PROFILE: profile, BENCH_ROWS: String(rows) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  const peers: Awaited<ReturnType<typeof attachPeer>>[] = [];
  let page: Page | undefined;
  try {
    const startup: unknown[] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
      exited.then(() => {
        throw new Error("Benchmark server exited before startup");
      }),
    ]);
    const [address] = startup;
    if (typeof address !== "string")
      throw new Error("Missing benchmark address");
    const boot = v.parse(startupSchema, JSON.parse(address));
    const origin = new URL(boot.origin);
    const idle = await readMetrics(origin, true);
    page = await browser.newPage();
    await timeBrowser(page);
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("Network.enable");
    const browserFrames: number[] = [];
    devtools.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
      if (eventName === "html-update") {
        browserFrames.push(
          Buffer.byteLength(`event: ${eventName}\ndata: ${data}\n\n`, "utf8")
        );
      }
    });
    const document = await page.goto(origin.href);
    if (!document) throw new Error("Missing browser navigation response");
    const coldSsrMs = readSsrTime(new Headers(await document.allHeaders()));
    await page.waitForSelector("html[data-hs-connection=ready]", {
      state: "attached",
    });

    // Keep one actual browser and create the other connections in small bursts.
    for (let left = connections - 1; left > 0; left -= 16) {
      const batch = await Promise.allSettled(
        Array.from({ length: Math.min(left, 16) }, async () => {
          const peer = await attachPeer(origin);
          peers.push(peer);
        })
      );
      for (const result of batch) {
        if (result.status === "rejected") throw result.reason;
      }
    }
    const ssrMs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const response = await fetch(origin);
      ssrMs.push(readSsrTime(response.headers));
      await response.arrayBuffer();
    }

    const allDeliveryMs: number[] = [];
    const frames: number[] = [];
    async function sample(value: number) {
      if (!page) throw new Error("Missing browser");
      const started = performance.now();
      const delivery = Promise.all(peers.map((peer) => peer.readUpdate(value)));
      const action = page.waitForResponse("**/_hypersig/actions/increment");
      const [, bytes, response] = await Promise.all([
        page.locator("#increment").click(),
        delivery,
        action,
      ]);
      if (!response.ok())
        throw new Error(`Action failed: ${response.status()}`);
      await page
        .locator("#value")
        .filter({ hasText: new RegExp(`^${value}$`) })
        .waitFor();
      return { bytes, elapsed: performance.now() - started };
    }

    // Warm the browser, server and streams before sampling updates.
    for (let value = 1; value <= 5; value++) await sample(value);
    await page.evaluate(() => performance.clearMeasures());
    browserFrames.length = 0;
    const before = await readMetrics(origin, true);
    const measured = performance.now();
    for (let value = 6; value < 6 + rounds; value++) {
      const { bytes, elapsed } = await sample(value);
      allDeliveryMs.push(elapsed);
      frames.push(...bytes);
    }
    const wallMs = performance.now() - measured;
    const browserTimes = await page.evaluate(() => ({
      apply: performance
        .getEntriesByName("benchmark:fragment")
        .map((entry) => entry.duration),
      action: performance
        .getEntriesByName("benchmark:click-to-dom")
        .map((entry) => entry.duration),
    }));
    frames.push(...browserFrames);
    if (
      frames.length !== connections * rounds ||
      browserFrames.length !== rounds ||
      browserTimes.apply.length !== rounds ||
      browserTimes.action.length !== rounds
    ) {
      throw new Error("Missing browser measurements");
    }
    const after = await readMetrics(origin, true);
    const renderTimes = after.renderTimes.slice(before.renderTimes.length);
    const counterLoads = after.counterLoads - before.counterLoads;
    if (
      renderTimes.length !== (shareRender ? rounds : connections * rounds) ||
      after.independentRenders !== before.independentRenders
    ) {
      throw new Error("Unexpected numbers of affected or independent renders");
    }
    if (
      counterLoads < rounds ||
      counterLoads > connections * rounds ||
      (!shareLoad && counterLoads !== connections * rounds)
    )
      throw new Error("Unexpected number of snapshot loads");
    return {
      profile,
      shareRender,
      shareLoad,
      readDelayMs,
      counterLoads,
      connections,
      bun: boot.bun,
      coldSsrMs: Math.round(coldSsrMs * 1000) / 1000,
      initialSsrMs: quantiles(ssrMs),
      ssrSamples: ssrMs.length,
      hotViewRenderMs: quantiles(renderTimes),
      browserClickToDomMs: quantiles(browserTimes.action),
      browserParseSanitizeAndMorphMs: quantiles(browserTimes.apply),
      driverClickThroughAllDeliveryMs: quantiles(allDeliveryMs),
      sseFrameBytes: quantiles(frames),
      totalSseBytes: frames.reduce((total, size) => total + size, 0),
      affectedRenders: renderTimes.length,
      independentRenders: after.independentRenders - before.independentRenders,
      independentAccessChecks:
        after.independentChecks - before.independentChecks,
      driverActionsPerSecond: Math.round(((rounds * 1000) / wallMs) * 10) / 10,
      memoryBytes: {
        idle: { rss: idle.rss, heap: idle.heapUsed },
        connected: { rss: before.rss, heap: before.heapUsed },
        after: { rss: after.rss, heap: after.heapUsed },
      },
    };
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.close()));
    await page?.close();
    lines.close();
    server.kill();
    await exited;
  }
}

const runtime = await readFile(new URL("../dist/runtime.js", import.meta.url));
const browser = await chromium.launch();
try {
  console.log(
    JSON.stringify({
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      chromium: browser.version(),
      rows,
      rounds,
      warmup: 5,
      runtime: {
        bytes: runtime.length,
        gzip9Bytes: gzipSync(runtime, { level: 9 }).length,
      },
    })
  );
  for (const profile of ["coarse", "fine"] as const) {
    for (const count of connectionCounts) {
      console.log(JSON.stringify(await runProfile(browser, profile, count)));
    }
  }
} finally {
  await browser.close();
}
