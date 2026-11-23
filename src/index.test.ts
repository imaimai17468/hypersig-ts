import { Hono } from "hono";
import { html } from "hono/html";
import * as v from "valibot";
import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import { createHypersig, createMemoryPubSub, live, topic } from "./index.js";
import type { PubSub } from "./index.js";

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
  pubsub: PubSub<CounterEvent> = createMemoryPubSub<CounterEvent>()
) {
  let count = 0;
  let allowed = true;
  let userActive = true;
  const app = new Hono();
  const hypersig = createHypersig({
    origin,
    pubsub,
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
  const counter = live({
    key: ({ id }: { id: string }) => id,
    subscribe: ({ id }) => [changed(id)],
    authorize: () => allowed,
    load,
    render: (value) => html`<output>${value}</output>`,
  });
  const sibling = hypersig.live({
    key: () => "other",
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

async function openStream(app: Hono, path: string, keys = ["main"]) {
  const query = new URLSearchParams(keys.map((key) => ["view", key]));
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
  expect((await app.request(path + "?view=main")).status).toBe(401);
  expect(
    (
      await app.request(path + "?view=main", {
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
      'event: html-update\ndata: {"target":"main","version":1,"html":"<output>1</output>"}\n\n'
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
      '"version":2,"html":"<output>3</output>"'
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
        '"version":2,"html":"<output>2</output>"'
      );
      expect(await next.read()).toContain("event: ready");
      resume.complete();
      await commitOutsideAction(3);
      expect(await next.read()).toContain(
        '"version":3,"html":"<output>3</output>"'
      );
    } finally {
      await next.close();
    }
  } finally {
    resume.complete();
    await old.close();
  }
});

it("requests a new SSR document when the page registration has expired", async () => {
  const { app, pageUrl } = setup();
  const { path } = await pageUrl();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  try {
    const stream = await openStream(app, path);
    try {
      expect(await stream.read()).toContain("event: reset");
      expect(await stream.read()).toBe("");
    } finally {
      await stream.close();
    }
  } finally {
    clock.mockRestore();
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
  expectTypeOf(publish).parameter(0).toEqualTypeOf<CounterEvent>();
  expectTypeOf(otherTopic("invoice-1")).not.toMatchTypeOf<CounterEvent>();
});

it("reports a failed render without exposing its error or interrupting other views", async () => {
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, pageUrl, load, commitOutsideAction, publish } = setup();
  const { path } = await pageUrl();
  const stream = await openStream(app, path, ["main", "other"]);
  try {
    expect(await stream.read()).toContain("<output>0</output>");
    expect(await stream.read()).toContain('"target":"other"');
    expect(await stream.read()).toContain("event: ready");
    const error = new Error("internal render failure");
    load.mockRejectedValueOnce(error);
    await commitOutsideAction(1);
    expect(await stream.read()).toBe('event: view-error\ndata: "main"\n\n');
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
    key: () => "child",
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
    key: () => "parent",
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
  expect((await app.request(path + "?view=parent%2Fchild")).status).toBe(400);

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
