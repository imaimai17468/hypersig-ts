import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import * as v from "valibot";
import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  errorOutlet,
  signals,
  topic,
} from "./index.js";
import type {
  ExprNode,
  PubSub,
  ResultHandlers,
  SignalGroup,
  SignalPath,
  SignalScope,
  StmtNode,
} from "./index.js";

const origin = "http://localhost";
const changed = topic("counter", (id: string) => id);
const otherTopic = topic("invoice", (id: string) => id);
type CounterEvent = ReturnType<typeof changed>;

function deferred() {
  let complete = () => {};
  const wait = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { wait, complete };
}

function setup(
  pubsub: PubSub<CounterEvent> = createMemoryPubSub<CounterEvent>(),
  limits: {
    maxStreamMs?: number;
    maxStreamsPerSession?: number;
    pageLifetimeMs?: number;
  } = {}
) {
  let count = 0;
  let allowed = true;
  let userActive = true;
  const app = new Hono();
  const hypersig = createHypersig({
    origin,
    pubsub,
    ...limits,
    authenticate(request) {
      const sessionId = request.headers.get("X-Session");
      return sessionId && userActive ? { sessionId } : null;
    },
  });
  const increment = hypersig.action("increment", {
    input: v.object({
      amount: v.pipe(v.string(), v.regex(/^[0-9]+$/), v.transform(Number)),
    }),
    output: v.number(),
    authorize: (input, user) => input.amount <= 5 && user.sessionId === "owner",
    async execute(input) {
      count += input.amount;
      await hypersig.publish(changed("main"));
      return count;
    },
  });
  const load = vi.fn<() => number | Promise<number>>(() => count);
  const counter = hypersig.live({
    name: "counter",
    key: ({ id }: { id: string }) => id,
    subscribe: ({ id }) => [changed(id)],
    authorize: () => allowed,
    load,
    render: (value) => html`<output>${value}</output>`,
  });
  const sibling = hypersig.live({
    name: "other",
    subscribe: () => [changed("other")],
    authorize: () => true,
    load: () => "Other",
    render: (label) => html`<p>${label}</p>`,
  });
  app.route("/", hypersig.routes);
  app.get("/", (c) =>
    hypersig.page(
      c.req.raw,
      (page) =>
        html`<html>
          ${page.runtime("/runtime.js")}${page.view(counter, { id: "main" })}${page.view(sibling, {})}
        </html>`
    )
  );

  async function pageUrl() {
    const response = await app.request("/", {
      headers: { "X-Session": "owner" },
    });
    expect(response.status).toBe(200);
    const source = await response.text();
    const path = /data-hs-stream="([^"]+)"/.exec(source)?.[1];
    if (!path) throw new Error("Missing SSE URL");
    return { source, path };
  }

  function action(
    body: BodyInit,
    headers: HeadersInit = {
      "X-Session": "owner",
      Origin: origin,
      "Content-Type": "application/json",
    }
  ) {
    return app.request(increment.url, { method: "POST", headers, body });
  }
  return {
    app,
    hypersig,
    pageUrl,
    action,
    increment,
    load,
    denyView: () => {
      allowed = false;
    },
    allowView: () => {
      allowed = true;
    },
    signOut: () => {
      userActive = false;
    },
    publish: hypersig.publish,
    commitOutsideAction: async (value: number) => {
      count = value;
      await hypersig.publish(changed("main"));
    },
  };
}

async function openStream(
  app: Hono,
  path: string,
  keys = ["counter.main"],
  pristine: readonly string[] = []
) {
  const query = new URLSearchParams([
    ...keys.map((key) => ["view", key]),
    ...pristine.map((key) => ["pristine", key]),
  ]);
  const response = await app.request(`${path}?${query}`, {
    headers: { "X-Session": "owner" },
  });
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  return {
    async read() {
      const { value } = await reader.read();
      return new TextDecoder().decode(value);
    },
    close: () => reader.cancel(),
  };
}

it("validates wire input, enforces origin and authorization, and accepts native form data", async () => {
  const { action, increment } = setup();
  const body = JSON.stringify({ amount: "2" });
  expect((await action(body, { "X-Session": "owner" })).status).toBe(403);
  expect((await action(body, { Origin: origin })).status).toBe(401);
  expect(
    (await action(body, { Origin: origin, "X-Session": "owner" })).status
  ).toBe(415);
  expect((await action("{")).status).toBe(400);
  expect((await action(JSON.stringify({ amount: 2 }))).status).toBe(422);
  expect((await action(JSON.stringify({ amount: "6" }))).status).toBe(403);
  expect((await action(" ".repeat(65_537))).status).toBe(413);
  const form = new FormData();
  form.set(increment.field("amount"), "2");
  const response = await action(form, { Origin: origin, "X-Session": "owner" });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ data: 2 });
  form.set(increment.field("amount"), "invalid");
  expect(
    (await action(form, { Origin: origin, "X-Session": "owner" })).status
  ).toBe(422);
});

it("scopes a page's authorized views to its session and catches changes made before connection", async () => {
  const { app, pageUrl, action, load } = setup();
  expect((await app.request("/")).status).toBe(401);
  const { source, path } = await pageUrl();
  expect(source).toContain("<output>0</output>");
  expect((await app.request(path + "?view=counter.main")).status).toBe(401);
  expect(
    (
      await app.request(path + "?view=counter.main", {
        headers: { "X-Session": "other" },
      })
    ).status
  ).toBe(403);
  expect(
    (
      await app.request(path + "?view=private", {
        headers: { "X-Session": "owner" },
      })
    ).status
  ).toBe(400);

  await action(JSON.stringify({ amount: "1" }));
  const stream = await openStream(app, path);
  try {
    expect(await stream.read()).toBe(
      'event: html-update\ndata: {"target":"counter.main","version":1,"html":"<output>1</output>"}\n\n'
    );
    expect(await stream.read()).toContain("event: ready");
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    await stream.close();
  }
  await action(JSON.stringify({ amount: "2" }));
  const restored = await openStream(app, path);
  try {
    expect(await restored.read()).toContain(
      '"version":1,"html":"<output>3</output>"'
    );
    expect(await restored.read()).toContain("event: ready");
  } finally {
    await restored.close();
  }
});

it("streams a committed change published outside the HTTP Action", async () => {
  const { app, pageUrl, commitOutsideAction } = setup();
  const { path } = await pageUrl();
  const stream = await openStream(app, path);
  try {
    expect(await stream.read()).toContain("<output>0</output>");
    expect(await stream.read()).toContain("event: ready");
    await commitOutsideAction(12);
    expect(await stream.read()).toContain(
      '"version":2,"html":"<output>12</output>"'
    );
  } finally {
    await stream.close();
  }
});

it("catches changes during a snapshot and removes subscriptions on stream cancellation", async () => {
  const bus = createMemoryPubSub<CounterEvent>();
  const stopped = deferred();
  const subscribed = deferred();
  const publishDuringAdmission = deferred();
  const tracked: PubSub<CounterEvent> = {
    publish: (event) => bus.publish(event),
    async subscribe(event, listener) {
      const stop = await bus.subscribe(event, listener);
      subscribed.complete();
      await publishDuringAdmission.wait;
      return () => {
        stop();
        stopped.complete();
      };
    },
  };
  const { app, pageUrl, action, load } = setup(tracked);
  const { path } = await pageUrl();
  const stream = await openStream(app, path);
  try {
    await subscribed.wait;
    await action(JSON.stringify({ amount: "1" }));
    publishDuringAdmission.complete();
    expect(await stream.read()).toContain(
      '"version":1,"html":"<output>1</output>"'
    );
    expect(await stream.read()).toContain("event: ready");
    expect(await stream.read()).toContain(
      '"version":2,"html":"<output>1</output>"'
    );
  } finally {
    publishDuringAdmission.complete();
    await stream.close();
  }
  await stopped.wait;
  await action(JSON.stringify({ amount: "1" }));
  expect(load).toHaveBeenCalledTimes(3);
});

it("clears content and removes access on view revocation, and closes access on session revocation", async () => {
  const { app, pageUrl, publish, denyView, allowView, signOut, load } = setup();
  const { path } = await pageUrl();
  const stream = await openStream(app, path);
  try {
    expect(await stream.read()).toContain("event: html-update");
    expect(await stream.read()).toContain("event: ready");
    denyView();
    await publish(changed("main"));
    expect(await stream.read()).toContain('"version":2,"html":""');
    expect(load).toHaveBeenCalledTimes(2);
    // The denied view has no listener. A fresh connection rechecks its access.
    await stream.close();
    allowView();
    const restored = await openStream(app, path);
    try {
      expect(await restored.read()).toContain("<output>0</output>");
      expect(await restored.read()).toContain("event: ready");
      signOut();
      await publish(changed("main"));
      expect(await restored.read()).toContain("event: access-denied");
    } finally {
      await restored.close();
    }
  } finally {
    await stream.close();
  }
});

it("suppresses HTML when view permission changes during an asynchronous load", async () => {
  const { app, pageUrl, load, denyView, commitOutsideAction } = setup();
  const { path } = await pageUrl();
  const stream = await openStream(app, path);
  const started = deferred();
  const resume = deferred();
  try {
    expect(await stream.read()).toContain("<output>0</output>");
    expect(await stream.read()).toContain("event: ready");
    load.mockImplementationOnce(async () => {
      started.complete();
      await resume.wait;
      return 17;
    });
    await commitOutsideAction(17);
    await started.wait;
    denyView();
    resume.complete();
    expect(await stream.read()).toContain('"version":2,"html":""');
  } finally {
    resume.complete();
    await stream.close();
  }
});

it("replaces a page connection while its old render is still pending", async () => {
  const { app, pageUrl, load, commitOutsideAction } = setup();
  const { path } = await pageUrl();
  const old = await openStream(app, path);
  const started = deferred();
  const resume = deferred();
  try {
    expect(await old.read()).toContain('"version":1');
    expect(await old.read()).toContain("event: ready");
    load.mockImplementationOnce(async () => {
      started.complete();
      await resume.wait;
      return 1;
    });
    await commitOutsideAction(1);
    await started.wait;
    await commitOutsideAction(2);
    const next = await openStream(app, path);
    try {
      expect(await old.read()).toBe("");
      expect(await next.read()).toContain(
        '"version":1,"html":"<output>2</output>"'
      );
      expect(await next.read()).toContain("event: ready");
      resume.complete();
      await commitOutsideAction(3);
      expect(await next.read()).toContain(
        '"version":2,"html":"<output>3</output>"'
      );
    } finally {
      await next.close();
    }
  } finally {
    resume.complete();
    await old.close();
  }
});

it("sends reconnect with a renewed page token before ending a stream at its lifetime", async () => {
  const { app, pageUrl, denyView } = setup(undefined, {
    maxStreamMs: 50,
    pageLifetimeMs: 1_000,
  });
  const { path } = await pageUrl();
  const renderedBy = Date.now();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const stream = await openStream(app, path);
  let renewed: unknown;
  try {
    expect(await stream.read()).toContain('"version":1');
    expect(await stream.read()).toContain("event: ready");
    const reconnect = await stream.read();
    expect(reconnect).toContain("event: reconnect");
    renewed = JSON.parse(/^data: (.*)$/m.exec(reconnect)?.[1] ?? "null");
    expect(await stream.read()).toBe("");
  } finally {
    await stream.close();
    vi.restoreAllMocks();
  }
  if (typeof renewed !== "string") throw new Error("Expected a renewed token");
  const renewedPath = path.replace(/[^/]+$/, renewed);

  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // The SSR token has expired, and the renewed one still opens the page.
    vi.setSystemTime(renderedBy + 1_001);
    const expired = await openStream(app, path);
    try {
      expect(await expired.read()).toContain("event: reset");
    } finally {
      await expired.close();
    }
    const next = await openStream(app, renewedPath);
    try {
      expect(await next.read()).toContain('"version":1');
    } finally {
      await next.close();
    }
  } finally {
    vi.useRealTimers();
  }

  // A user who can no longer read a view of the page gets no renewed token.
  vi.spyOn(Math, "random").mockReturnValue(0);
  const denied = await openStream(app, renewedPath);
  try {
    expect(await denied.read()).toContain('"version":1');
    expect(await denied.read()).toContain("event: ready");
    denyView();
    const reconnect = await denied.read();
    expect(reconnect).toContain("event: reconnect");
    expect(reconnect).toContain("data: null");
  } finally {
    await denied.close();
    vi.restoreAllMocks();
  }
});

it("sends evicted to the oldest stream beyond maxStreamsPerSession", async () => {
  const { app, pageUrl } = setup(undefined, { maxStreamsPerSession: 1 });
  const oldest = await openStream(app, (await pageUrl()).path);
  try {
    expect(await oldest.read()).toContain('"version":1');
    expect(await oldest.read()).toContain("event: ready");
    const newest = await openStream(app, (await pageUrl()).path);
    try {
      expect(await oldest.read()).toContain("event: evicted");
      expect(await oldest.read()).toBe("");
      expect(await newest.read()).toContain('"version":1');
    } finally {
      await newest.close();
    }
  } finally {
    await oldest.close();
  }
});

it("requests a new SSR document when the page registration has expired", async () => {
  const { app, pageUrl } = setup();
  const { path } = await pageUrl();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 1);
    const stream = await openStream(app, path);
    try {
      expect(await stream.read()).toContain("event: reset");
      expect(await stream.read()).toBe("");
    } finally {
      await stream.close();
    }
  } finally {
    vi.useRealTimers();
  }
});

it("opens a page rendered by another runtime with the same page key and trusts SSR only for pristine views", async () => {
  const pageKeys = [
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ];
  let count = 0;
  function serve() {
    const hypersig = createHypersig({
      origin,
      pubsub: createMemoryPubSub<CounterEvent>(),
      pageKeys,
      authenticate(request) {
        const sessionId = request.headers.get("X-Session");
        return sessionId ? { sessionId } : null;
      },
    });
    const counter = hypersig.live({
      name: "counter",
      subscribe: () => [changed("main")],
      authorize: () => true,
      load: () => count,
      snapshotRevision: { read: () => count, from: (value) => value },
      render: (value) => html`<output>${value}</output>`,
    });
    const app = new Hono();
    app.route("/", hypersig.routes);
    app.get("/", (c) =>
      hypersig.page(
        c.req.raw,
        (page) =>
          html`<html>
            ${page.runtime("/runtime.js")}${page.view(counter, {})}
          </html>`
      )
    );
    return { app, publish: hypersig.publish };
  }
  const rendering = serve();
  const streaming = serve();
  const response = await rendering.app.request("/", {
    headers: { "X-Session": "owner" },
  });
  const path = /data-hs-stream="([^"]+)"/.exec(await response.text())?.[1];
  if (!path) throw new Error("Missing SSE URL");

  const touched = await openStream(streaming.app, path, ["counter"]);
  try {
    expect(await touched.read()).toContain(
      '"version":1,"html":"<output>0</output>"'
    );
    expect(await touched.read()).toContain("event: ready");
  } finally {
    await touched.close();
  }

  const pristine = await openStream(
    streaming.app,
    path,
    ["counter"],
    ["counter"]
  );
  try {
    expect(await pristine.read()).toContain("event: ready");
    count = 1;
    await streaming.publish(changed("main"));
    expect(await pristine.read()).toContain(
      '"version":1,"html":"<output>1</output>"'
    );
  } finally {
    await pristine.close();
  }

  const tooMany = Array.from({ length: 33 }, (_, index) => `view-${index}`);
  const query = new URLSearchParams([
    ["view", "counter"],
    ...tooMany.map((key) => ["pristine", key]),
  ]);
  const rejected = await streaming.app.request(`${path}?${query}`, {
    headers: { "X-Session": "owner" },
  });
  expect(rejected.status).toBe(400);
});

it("rejects a page token from an app at another origin that shares its page keys", async () => {
  const pageKeys = [Buffer.alloc(32, 9).toString("base64")];
  function serve(publicOrigin: string, pageContext?: string) {
    const hypersig = createHypersig({
      origin: publicOrigin,
      ...(pageContext !== undefined && { pageContext }),
      pubsub: createMemoryPubSub<CounterEvent>(),
      pageKeys,
      authenticate(request) {
        const sessionId = request.headers.get("X-Session");
        return sessionId ? { sessionId } : null;
      },
    });
    const counter = hypersig.live({
      name: "counter",
      subscribe: () => [changed("main")],
      authorize: () => true,
      load: () => 0,
      render: (value) => html`<output>${value}</output>`,
    });
    const app = new Hono();
    app.route("/", hypersig.routes);
    app.get("/", (c) =>
      hypersig.page(
        c.req.raw,
        (page) =>
          html`<html>
            ${page.runtime("/runtime.js")}${page.view(counter, {})}
          </html>`
      )
    );
    return app;
  }
  async function renderPath(app: Hono) {
    const response = await app.request("/", {
      headers: { "X-Session": "owner" },
    });
    const path = /data-hs-stream="([^"]+)"/.exec(await response.text())?.[1];
    if (!path) throw new Error("Missing SSE URL");
    return path;
  }
  const staging = serve("https://staging.example.com");
  const production = serve("https://example.com/");
  const path = await renderPath(staging);

  const foreign = await openStream(production, path, ["counter"]);
  try {
    expect(await foreign.read()).toContain("event: reset");
  } finally {
    await foreign.close();
  }
  const sameOrigin = await openStream(
    serve("https://staging.example.com/app"),
    path,
    ["counter"]
  );
  try {
    expect(await sameOrigin.read()).toContain('"html":"<output>0</output>"');
  } finally {
    await sameOrigin.close();
  }

  // An explicit context lets two origins serve one deployment's pages.
  const shared = "counter-app";
  const sharedPath = await renderPath(serve("https://a.example.com", shared));
  const otherOrigin = await openStream(
    serve("https://b.example.com", shared),
    sharedPath,
    ["counter"]
  );
  try {
    expect(await otherOrigin.read()).toContain('"html":"<output>0</output>"');
  } finally {
    await otherOrigin.close();
  }
});

it("binds schema wire input and accepts only the application's topic types", () => {
  const { increment, publish } = setup();
  expect(increment.bind({ amount: "2" })["data-hs-input"]).toBe(
    '{"amount":"2"}'
  );
  expectTypeOf<typeof increment.bind>()
    .parameter(0)
    .toEqualTypeOf<{ amount: string }>();
  expectTypeOf(increment.field("amount")).toEqualTypeOf<"amount">();
  // @ts-expect-error The schema does not accept a field named "ammount".
  increment.field("ammount");
  expect(increment.fieldError("amount")).toEqual({
    "data-hs-field-error": "amount",
  });
  // @ts-expect-error A field error outlet names a field the schema accepts.
  increment.fieldError("ammount");
  expect(increment.draft("amount")).toEqual({
    name: "amount",
    "data-hs-draft": "",
  });
  // @ts-expect-error A draft key is a field name the schema accepts.
  increment.draft("ammount");
  expect(increment.form({ draft: true })["data-hs-draft-form"]).toBe(
    "increment"
  );
  expect(increment.form()).not.toHaveProperty("data-hs-draft-form");
  expectTypeOf(publish).parameter(0).toEqualTypeOf<CounterEvent>();
  expectTypeOf(otherTopic("invoice-1")).not.toMatchTypeOf<CounterEvent>();
});

it("accepts only literal Action names and rejects a repeated name at registration", () => {
  const { hypersig } = setup();
  const definition = {
    input: v.object({}),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  };
  expect(() => hypersig.action("increment", definition)).toThrow(
    "Invalid or duplicate Action name: increment"
  );
  // @ts-expect-error An Action name with a space cannot form its URL path.
  expect(() => hypersig.action("save memo", definition)).toThrow(
    "Invalid or duplicate Action name: save memo"
  );
  const name: string = "computed";
  // @ts-expect-error A name typed as string escapes the literal check.
  hypersig.action(name, definition);
});

it("marks the outlets the runtime fills", () => {
  expect(errorOutlet()).toEqual({ "data-hs-error": "" });
  expect(connectionStatusOutlet()).toEqual({ "data-hs-connection-status": "" });
});

it("binds only JSON input and leaves other input to forms", () => {
  const { hypersig } = setup();
  const schedule = hypersig.action("schedule", {
    input: v.object({ at: v.date(), note: v.optional(v.string()) }),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  // @ts-expect-error A Date becomes a string in JSON, so the schema would reject it.
  schedule.bind({ at: new Date() });
  expect(schedule.form()).toMatchObject({ action: schedule.url });

  const rename = hypersig.action("rename", {
    input: v.object({ title: v.string(), note: v.optional(v.string()) }),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(rename.bind({ title: "Draft" })["data-hs-input"]).toBe(
    '{"title":"Draft"}'
  );
  expectTypeOf<typeof rename.bind>()
    .parameter(0)
    .toEqualTypeOf<{ title: string; note?: string | undefined }>();
});

it("reports a failed render without exposing its error or interrupting other views", async () => {
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, pageUrl, load, commitOutsideAction, publish } = setup();
  const { path } = await pageUrl();
  const stream = await openStream(app, path, ["counter.main", "other"]);
  try {
    expect(await stream.read()).toContain("<output>0</output>");
    expect(await stream.read()).toContain('"target":"other"');
    expect(await stream.read()).toContain("event: ready");
    const error = new Error("internal render failure");
    load.mockRejectedValueOnce(error);
    await commitOutsideAction(1);
    expect(await stream.read()).toBe(
      'event: view-error\ndata: "counter.main"\n\n'
    );
    expect(logger).toHaveBeenCalledWith(error);
    await publish(changed("other"));
    expect(await stream.read()).toContain('"target":"other","version":3');
    await commitOutsideAction(2);
    expect(await stream.read()).toContain(
      '"version":4,"html":"<output>2</output>"'
    );
  } finally {
    logger.mockRestore();
    await stream.close();
  }
});

it("rechecks ancestor access before releasing a child fragment", async () => {
  const app = new Hono();
  let allowed = true;
  let pauseChild = false;
  const started = deferred();
  const resume = deferred();
  const hypersig = createHypersig({
    origin,
    authenticate: () => ({ sessionId: "owner" }),
    pubsub: createMemoryPubSub<CounterEvent>(),
  });
  const child = hypersig.live({
    name: "child",
    subscribe: () => [changed("child")],
    authorize: () => true,
    async load() {
      if (!pauseChild) return "initial child";
      started.complete();
      await resume.wait;
      return "private child";
    },
    render: (label) => html`<output>${label}</output>`,
  });
  const parent = hypersig.live({
    name: "parent",
    subscribe: () => [changed("parent")],
    authorize: () => allowed,
    load: () => "Parent",
    render: (label, _params, context) =>
      html`<section>${label}${context.view(child, {})}</section>`,
  });
  app.route("/", hypersig.routes);
  app.get("/", (c) =>
    hypersig.page(
      c.req.raw,
      (page) =>
        html`<html>
          ${page.runtime("/runtime.js")}${page.view(parent, {})}
        </html>`
    )
  );
  const response = await app.request("/");
  const source = await response.text();
  expect(source).toMatch(
    /<div id="hs-view-parent\/child" data-hs-view="parent\/child">\s*<output>initial child<\/output>\s*<\/div>/
  );
  const path = /data-hs-stream="([^"]+)"/.exec(source)?.[1];
  if (!path) throw new Error("Missing SSE URL");
  expect((await app.request(path + "?view=parent%2Fchild-1")).status).toBe(400);

  const stream = await openStream(app, path, ["parent"]);
  try {
    expect(await stream.read()).toContain('"children":["parent/child"]');
    expect(await stream.read()).toContain(
      '"target":"parent/child","version":2'
    );
    expect(await stream.read()).toContain("event: ready");
    pauseChild = true;
    await hypersig.publish(changed("child"));
    await started.wait;
    allowed = false;
    resume.complete();
    expect(await stream.read()).toContain(
      '"target":"parent/child","version":3,"html":""'
    );
    await hypersig.publish(changed("parent"));
    expect(await stream.read()).toContain(
      '"target":"parent","version":4,"html":""'
    );
  } finally {
    resume.complete();
    await stream.close();
  }
});

it("builds call statements from values and signals", () => {
  const { increment } = setup();
  const s = signals({ amount: "1", flag: false }, { name: "call-input" });
  expect(increment.call({ amount: "2" })).toEqual([
    "call",
    increment.url,
    { amount: ["lit", "2"] },
    [],
    [],
  ]);
  expect(increment.call({ amount: s.amount })).toEqual([
    "call",
    increment.url,
    { amount: ["sig", s.amount.path] },
    [],
    [],
  ]);
  // @ts-expect-error The schema does not accept a field named "ammount".
  increment.call({ ammount: "1" });

  const { hypersig } = setup();
  const rename = hypersig.action("rename", {
    input: v.object({ title: v.optional(v.string()), note: v.string() }),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(rename.call({ title: undefined, note: s.amount })[2]).toEqual({
    note: ["sig", s.amount.path],
  });
});

it("passes the action output to onSuccess and runs onError on failure", () => {
  const { hypersig } = setup();
  const s = signals({ base: 0 }, { name: "call-output" });
  const save = hypersig.action("save-memo", {
    input: v.object({ title: v.string() }),
    output: v.object({ revision: v.number() }),
    authorize: () => true,
    execute: () => ({ revision: 1 }),
  });
  const statement = save.call(
    { title: "a" },
    {
      onSuccess: (out) => s.base.set(out.get("revision")),
      onError: s.base.set(0),
    }
  );
  expect(statement[3]).toEqual([
    ["set", s.base.path, ["get", ["output"], "revision"]],
  ]);
  expect(statement[4]).toEqual([["set", s.base.path, ["lit", 0]]]);
});

it("exposes pending and restored state as expressions", () => {
  const { increment } = setup();
  expect(increment.pending().node).toEqual([
    "sig",
    ["$pending", increment.url],
  ]);
  expect(increment.draftRestored().node).toEqual([
    "sig",
    ["$restored", increment.url],
  ]);
});

it("attaches result statements to forms", () => {
  const { increment } = setup();
  const s = signals({ flag: false }, { name: "call-form" });
  const form = increment.form({
    onSuccess: () => s.flag.toggle(),
    onError: [s.flag.set(false)],
  });
  expect(form["data-hs-on-success"]).toBe(
    JSON.stringify([["toggle", s.flag.path]])
  );
  expect(form["data-hs-on-error"]).toBe(
    JSON.stringify([["set", s.flag.path, ["lit", false]]])
  );
  expect(increment.form()).not.toHaveProperty("data-hs-on-success");
  expect(increment.form()).not.toHaveProperty("data-hs-on-error");
});

it("attaches submit statements to forms", () => {
  const { increment } = setup();
  const s = signals({ flag: false }, { name: "submit-form" });
  expect(
    increment.form({ onSubmit: [s.flag.toggle()] })["data-hs-on-submit"]
  ).toBe(JSON.stringify([["toggle", s.flag.path]]));
  expect(increment.form()).not.toHaveProperty("data-hs-on-submit");
});

it("exports the types that signal and Action signatures name", () => {
  const { increment } = setup();
  const group = signals({ count: 0 }, { name: "exported-types" });
  expectTypeOf(group).toEqualTypeOf<SignalGroup<{ count: number }>>();
  expectTypeOf(group.with({})).toEqualTypeOf<SignalScope<{ count: number }>>();
  expectTypeOf(group.count.path).toEqualTypeOf<SignalPath>();
  expectTypeOf(group.count.node).toEqualTypeOf<ExprNode>();
  expectTypeOf(group.count.set(1)).toEqualTypeOf<StmtNode>();
  const handlers: ResultHandlers<number> = {
    onSuccess: (output) => group.count.set(output),
  };
  expect(increment.call({ amount: "1" }, handlers)[3]).toEqual([
    ["set", group.count.path, ["output"]],
  ]);
});

function controlHypersig(libraryOptions?: Record<string, unknown>) {
  return createHypersig({
    origin,
    authenticate: () => ({ sessionId: "owner" }),
    pubsub: createMemoryPubSub<CounterEvent>(),
    ...(libraryOptions ? { jsonSchema: { libraryOptions } } : {}),
  });
}

const ignoreUnsupported = { ignoreActions: ["trim"] };

it("derives control attributes from the input schema", () => {
  const todo = controlHypersig(ignoreUnsupported).action("todo", {
    input: toStandardJsonSchema(
      v.object({
        title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
        code: v.pipe(v.string(), v.regex(/^[0-9]+$/)),
        loose: v.pipe(v.string(), v.regex(/[0-9]/)),
        count: v.pipe(v.number(), v.minValue(1), v.maxValue(5)),
        note: v.optional(v.string()),
        done: v.boolean(),
      })
    ),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(todo.control("title")).toEqual({
    name: "title",
    required: true,
    minLength: 1,
    maxLength: 200,
  });
  expect(todo.control("code")).toEqual({
    name: "code",
    required: true,
    pattern: "^[0-9]+$",
  });
  expect(todo.control("loose")).toEqual({ name: "loose", required: true });
  expect(todo.control("count")).toEqual({ name: "count", min: 1, max: 5 });
  expect(todo.control("note")).toEqual({ name: "note" });
  expect(todo.control("done")).toEqual({ name: "done" });
  // @ts-expect-error The schema has no field named "titel".
  todo.control("titel");
});

it("requires a field only when its schema rejects the empty string", () => {
  const choose = controlHypersig().action("required-rule", {
    input: toStandardJsonSchema(
      v.object({
        any: v.string(),
        filled: v.pipe(v.string(), v.minLength(1)),
        choice: v.picklist(["a", "b"]),
        blankable: v.picklist(["", "a"]),
        digits: v.pipe(v.string(), v.regex(/^[0-9]+$/)),
        optionalDigits: v.pipe(v.string(), v.regex(/^[0-9]*$/)),
      })
    ),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(choose.control("any")).toEqual({ name: "any" });
  expect(choose.control("filled")).toEqual({
    name: "filled",
    required: true,
    minLength: 1,
  });
  expect(choose.control("choice")).toEqual({ name: "choice", required: true });
  expect(choose.control("blankable")).toEqual({ name: "blankable" });
  expect(choose.control("digits")).toEqual({
    name: "digits",
    required: true,
    pattern: "^[0-9]+$",
  });
  // The server accepts "" for this pattern, so the browser must too.
  expect(choose.control("optionalDigits")).toEqual({
    name: "optionalDigits",
    pattern: "^[0-9]*$",
  });
});

it("emits only patterns the browser checks exactly as the server does", () => {
  const match = controlHypersig().action("pattern-rule", {
    input: toStandardJsonSchema(
      v.object({
        alternation: v.pipe(v.string(), v.regex(/^a|b$/)),
        escapedDollar: v.pipe(v.string(), v.regex(/^a\$/)),
        invalidUnderV: v.pipe(v.string(), v.regex(/^[a-z-]+$/)),
        grouped: v.pipe(v.string(), v.regex(/^(a|b)$/)),
        digits: v.pipe(v.string(), v.regex(/^[0-9]+$/)),
      })
    ),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(match.control("alternation")).toEqual({
    name: "alternation",
    required: true,
  });
  expect(match.control("escapedDollar")).toEqual({
    name: "escapedDollar",
    required: true,
  });
  expect(match.control("invalidUnderV")).toEqual({
    name: "invalidUnderV",
    required: true,
  });
  expect(match.control("grouped")).toEqual({
    name: "grouped",
    required: true,
    pattern: "^(a|b)$",
  });
  expect(match.control("digits")).toEqual({
    name: "digits",
    required: true,
    pattern: "^[0-9]+$",
  });
});

it("offers control() only when the input schema converts to JSON Schema", () => {
  const plain = controlHypersig().action("plain", {
    input: v.object({ title: v.string() }),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  // @ts-expect-error A schema without JSON Schema conversion has no control().
  expect(plain.control).toBeUndefined();
});

function fakeSchema(convert: () => Record<string, unknown>) {
  const wrapped = toStandardJsonSchema(v.object({ x: v.string() }));
  return {
    "~standard": {
      ...wrapped["~standard"],
      jsonSchema: { input: convert, output: convert },
    },
  };
}

it("converts the schema once", () => {
  const convert = vi.fn<() => Record<string, unknown>>(() => ({
    type: "object",
    properties: { x: {} },
    required: ["x"],
  }));
  const action = controlHypersig().action("once", {
    input: fakeSchema(convert) as ReturnType<
      typeof toStandardJsonSchema<
        v.ObjectSchema<{ x: v.StringSchema<undefined> }, undefined>
      >
    >,
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  action.control("x");
  action.control("x");
  expect(convert).toHaveBeenCalledTimes(1);
});

it("reads only object schemas", () => {
  const action = controlHypersig().action("scalar", {
    input: fakeSchema(() => ({ type: "string" })) as ReturnType<
      typeof toStandardJsonSchema<
        v.ObjectSchema<{ x: v.StringSchema<undefined> }, undefined>
      >
    >,
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(action.control("x")).toEqual({ name: "x" });
});

it("returns only the name when the converter yields no object", () => {
  const input = toStandardJsonSchema(v.object({ x: v.string() }));
  // The converter's type promises an object, so only a runtime swap yields null.
  Object.defineProperty(input["~standard"].jsonSchema, "input", {
    value: () => null,
  });
  const action = controlHypersig().action("not-object", {
    input,
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(action.control("x")).toEqual({ name: "x" });
});

it("returns only the name for a field the properties do not describe", () => {
  const action = controlHypersig().action("missing-property", {
    input: fakeSchema(() => ({
      type: "object",
      properties: { y: { type: "string", minLength: 1 } },
      required: ["x", "y"],
    })) as ReturnType<
      typeof toStandardJsonSchema<
        v.ObjectSchema<{ x: v.StringSchema<undefined> }, undefined>
      >
    >,
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(action.control("x")).toEqual({ name: "x" });
});

it("names the action when conversion fails", () => {
  const action = controlHypersig().action("convert-fails", {
    input: toStandardJsonSchema(
      v.object({ title: v.pipe(v.string(), v.trim()) })
    ),
    output: v.null(),
    authorize: () => true,
    execute: () => null,
  });
  expect(() => action.control("title")).toThrow(
    /convert-fails.*libraryOptions/s
  );
});

it("limits top-level page props to JSON in the Hono adapter", () => {
  const { hypersig } = setup();
  const dated = hypersig.live({
    name: "dated",
    subscribe: () => [changed("dated")],
    authorize: () => true,
    load: (params: { at: Date }) => params.at.toISOString(),
    render: (value) => html`<time>${value}</time>`,
  });
  hypersig.live({
    name: "calendar",
    subscribe: () => [changed("calendar")],
    authorize: () => true,
    load: () => null,
    render: (_data, _params, context) =>
      context.view(dated, { at: new Date() }),
  });
  const placeDated = (
    page: Parameters<Parameters<typeof hypersig.page>[1]>[0]
  ) =>
    // @ts-expect-error Date is not JSON, so it cannot travel in the page token.
    page.view(dated, { at: new Date() });
  expectTypeOf(placeDated).returns.toEqualTypeOf<Promise<HtmlEscapedString>>();
  interface Filter {
    query: string;
    sort?: "asc" | "desc";
  }
  const filtered = hypersig.live({
    name: "filtered",
    subscribe: () => [changed("filtered")],
    authorize: () => true,
    load: (params: Filter) => params.query,
    render: (value) => html`<p>${value}</p>`,
  });
  const placeFiltered = (
    page: Parameters<Parameters<typeof hypersig.page>[1]>[0]
  ) => {
    const filter: Filter = { query: "a" };
    return page.view(filtered, filter);
  };
  expectTypeOf(placeFiltered).returns.toEqualTypeOf<
    Promise<HtmlEscapedString>
  >();
});

it("lists the names hypersig.ts/element exports and shares them with hypersig.ts", async () => {
  const element = await import("./element.js");
  const index = await import("./index.js");
  expect(Object.keys(element).sort()).toEqual([
    "customElement",
    "defineElement",
    "event",
    "json",
  ]);
  expect(index.customElement).toBe(element.customElement);
  expect(index.event).toBe(element.event);
  expect(index.json).toBe(element.json);
});
