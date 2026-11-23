import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { V4WorkerOptions } from "miniflare";

type Dispatch = Miniflare["dispatchFetch"];
type Frontend = (
  url: string | URL,
  init?: Parameters<Dispatch>[1]
) => ReturnType<Dispatch>;

const origin = "http://counter.example";
const secret = "local-integration-test-secret-for-counter";
const script = await readFile(
  new URL("../dist/worker/index.js", import.meta.url),
  "utf8"
);
const assetsDirectory = fileURLToPath(
  new URL("../dist/worker/public/", import.meta.url)
);
const actionPath = "/_hypersig/actions/increment";

function startWorkers(storage: string) {
  const modules = {
    modules: true,
    script,
    compatibilityDate: "2026-11-16",
  } satisfies {
    modules: true;
    script: string;
    compatibilityDate: string;
  };
  const front = (name: string): V4WorkerOptions => ({
    compatibilityDate: modules.compatibilityDate,
    modules: [
      {
        type: "ESModule",
        path: "entry.mjs",
        contents: `
          import worker from "./worker.mjs";
          export default {
            fetch(request, env, ctx) {
              if (new URL(request.url).pathname === "/__test_entry") {
                return new Response(${JSON.stringify(name)});
              }
              return worker.fetch(request, env, ctx);
            }
          };
        `,
      },
      { type: "ESModule", path: "worker.mjs", contents: script },
    ],
    name,
    durableObjects: {
      COUNTERS: {
        scriptName: "counter-backend",
        className: "CounterRoom",
        useSQLite: true,
      },
    },
    assets: { binding: "ASSETS", directory: assetsDirectory },
    routes: [`${name}.counter.example/*`],
  });
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        front("entry-a"),
        front("entry-b"),
        {
          ...modules,
          name: "counter-backend",
          bindings: { PUBLIC_ORIGIN: origin, SESSION_SECRET: secret },
          durableObjects: {
            COUNTERS: { className: "CounterRoom", useSQLite: true },
          },
        },
      ],
      resourcePersistencePath: storage,
    })
  );
}

function getFrontend(runtime: Miniflare, name: string): Frontend {
  const address = `http://${name}.counter.example`;
  return (url, init) => {
    const { pathname, search } = new URL(url);
    return runtime.dispatchFetch(address + pathname + search, init);
  };
}

async function signIn(front: Frontend) {
  const response = await front(origin, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function readPage(front: Frontend, cookie: string, id = "main") {
  const response = await front(`${origin}/counters/${id}`, {
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  const endpoint = /data-hs-stream="([^"]+)"/.exec(html)?.[1];
  assert.ok(endpoint);
  const streamUrl = new URL(endpoint, origin);
  streamUrl.searchParams.set("view", `counter-1.${id}`);
  return { html, streamUrl };
}

function post(
  front: Frontend,
  cookie: string,
  requestOrigin = origin,
  counterKey = "main"
) {
  return front(origin + actionPath, {
    method: "POST",
    headers: {
      cookie,
      Origin: requestOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ counterKey }),
  });
}

async function openStream(front: Frontend, url: URL, cookie: string) {
  const response = await front(url, {
    headers: { cookie },
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async read() {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before the expected frame");
        const bytes: unknown = chunk.value;
        assert.ok(bytes instanceof Uint8Array);
        buffered += decoder.decode(bytes, { stream: true });
      }
      const end = buffered.indexOf("\n\n") + 2;
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end);
      return frame;
    },
    close: () => reader.cancel(),
  };
}

await test(
  "different Worker entries share one Durable Object for SSR, Actions and SSE",
  { timeout: 15_000 },
  async () => {
    const location = await mkdtemp(join(tmpdir(), "hypersig-workers-"));
    let runtime = startWorkers(location);
    try {
      const a = getFrontend(runtime, "entry-a");
      const b = getFrontend(runtime, "entry-b");
      assert.equal(await (await a(origin + "/__test_entry")).text(), "entry-a");
      assert.equal(await (await b(origin + "/__test_entry")).text(), "entry-b");
      const runtimeAsset = await b(origin + "/assets/hypersig-runtime.js");
      assert.equal(runtimeAsset.status, 200);
      assert.match(
        runtimeAsset.headers.get("content-type") ?? "",
        /javascript/
      );
      assert.ok((await runtimeAsset.arrayBuffer()).byteLength > 0);

      const cookie = await signIn(a);
      const peerCookie = await signIn(b);
      const page = await readPage(a, cookie);
      assert.match(page.html, /<output id="counter-value">0<\/output>/);
      const otherPage = await readPage(b, peerCookie, "other");
      assert.match(otherPage.html, /<output id="counter-value">0<\/output>/);
      assert.equal(
        (await b(page.streamUrl, { headers: { cookie: peerCookie } })).status,
        403
      );
      const issuedCookieName = cookie.split("=")[0];
      assert.ok(issuedCookieName);
      const expired = await serializeSigned(
        issuedCookieName,
        "expired/1",
        secret
      );
      assert.equal((await post(b, expired)).status, 401);
      const tampered = await post(b, cookie + "tampered");
      assert.equal(tampered.status, 401, await tampered.text());
      assert.equal(
        (await post(b, cookie, "https://other.example")).status,
        403
      );
      assert.equal((await post(b, cookie, origin, "unknown")).status, 422);

      const stream = await openStream(b, page.streamUrl, cookie);
      try {
        assert.match(
          await stream.read(),
          /<output id=\\"counter-value\\">0<\/output>/
        );
        assert.match(await stream.read(), /event: ready/);
        const response = await post(a, peerCookie);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { data: 1 });
        assert.match(
          await stream.read(),
          /<output id=\\"counter-value\\">1<\/output>/
        );

        const results = await Promise.all([
          post(a, cookie),
          post(b, peerCookie),
        ]);
        const values = await Promise.all(
          results.map(async (result) => {
            assert.equal(result.status, 200);
            return result.text();
          })
        );
        assert.deepEqual(values.sort(), ['{"data":2}', '{"data":3}']);
        const latest = /<output id=\\"counter-value\\">3<\/output>/;
        const next = await stream.read();
        if (!latest.test(next)) {
          assert.match(next, /<output id=\\"counter-value\\">2<\/output>/);
          assert.match(await stream.read(), latest);
        }
      } finally {
        await stream.close();
      }

      await runtime.dispose();
      runtime = startWorkers(location);
      const restartedEntry = getFrontend(runtime, "entry-a");
      const restarted = getFrontend(runtime, "entry-b");
      const oldStream = await openStream(restarted, page.streamUrl, cookie);
      try {
        assert.match(await oldStream.read(), /event: reset/);
      } finally {
        await oldStream.close();
      }
      const recovered = await readPage(restartedEntry, cookie);
      assert.match(recovered.html, /<output id="counter-value">3<\/output>/);
      assert.match(
        (await readPage(restarted, peerCookie, "other")).html,
        /<output id="counter-value">0<\/output>/
      );
      const recoveredStream = await openStream(
        restarted,
        recovered.streamUrl,
        cookie
      );
      try {
        assert.match(
          await recoveredStream.read(),
          /<output id=\\"counter-value\\">3<\/output>/
        );
        assert.match(await recoveredStream.read(), /event: ready/);
        const update = await post(restartedEntry, peerCookie);
        assert.equal(update.status, 200);
        assert.match(
          await recoveredStream.read(),
          /<output id=\\"counter-value\\">4<\/output>/
        );
      } finally {
        await recoveredStream.close();
      }
    } finally {
      await runtime.dispose();
      await rm(location, { recursive: true, force: true });
    }
  }
);
