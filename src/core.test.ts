import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import {
  createLiveRuntime,
  createMemoryPubSub,
  shareTopicSubscriptions,
  topic,
} from "./core.js";
import type {
  LiveDiagnostic,
  LiveMessage,
  LiveRenderer,
  PageRenderContext,
  Principal,
} from "./core.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const renderer: LiveRenderer<string> = {
  empty: () => "",
  boundary: (target, html) => `<div data-target="${target}">${html}</div>`,
  serialize: async (value) => value,
};

/** Writes the page token into the document, as `page.runtime()` does in the Hono adapter. */
const streamToken = (token: string) =>
  `<script data-token="${token}"></script>`;

function readToken(document: string) {
  const token = /data-token="([^"]+)"/.exec(document)?.[1];
  if (!token) throw new Error("Expected a page token in the document");
  return token;
}

const bytes = (value: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(value)));
// 0xfb bytes encode to "+/v7…", so the same key in base64url reads "-_v7…".
const key1 = bytes(0xfb);
const key2 = bytes(0x01);
const viewer = { sessionId: "viewer" };
const counterChanged = topic("counter", (scope: string) => scope);
type CounterEvent = ReturnType<typeof counterChanged>;

function counterRuntime(
  store: { count: number },
  options: Omit<
    Parameters<typeof createLiveRuntime<Principal, CounterEvent, string>>[0],
    "renderer" | "pubsub"
  > = {}
) {
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub: createMemoryPubSub(),
    ...options,
  });
  const view = runtime.live({
    name: "counter",
    subscribe: () => [counterChanged("all")],
    authorize: () => true,
    load: () => store.count,
    render: String,
  });
  return { runtime, view };
}

async function renderCounter({
  runtime,
  view,
}: ReturnType<typeof counterRuntime>) {
  return readToken(
    await runtime.renderPage(
      viewer,
      async (page, token) => streamToken(token) + (await page.view(view, {}))
    )
  );
}

function createConnection() {
  const lifetime = new AbortController();
  const channel = new TransformStream<LiveMessage, LiveMessage>();
  const reader = channel.readable.getReader();
  const writer = channel.writable.getWriter();

  return {
    signal: lifetime.signal,
    close: () => {
      lifetime.abort();
      void writer.abort().catch(() => {});
    },
    send: (message: LiveMessage) => writer.write(message),
    async read() {
      const { done, value } = await reader.read();
      if (done) throw new Error("Expected a live message");
      return value;
    },
  };
}

it("runs without an HTTP adapter and retains subscribed children across parent renders", async () => {
  const change = topic(
    "change",
    (name: "parent" | "child" | "other" | "sentinel") => name
  );
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof change>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const user = { sessionId: "viewer" };
  let value = 0;
  let draws = 0;
  let format = "plain";
  let channel: "child" | "other" = "child";
  let allowed = true;

  const child = runtime.live({
    name: "child",
    revision: (params: { format: string; channel: "child" | "other" }) =>
      params.format,
    subscribe: (params) => [change(params.channel)],
    authorize: () => allowed,
    load() {
      draws++;
      return value;
    },
    render: (data, params) => `${params.format}:${data}`,
  });
  const replacement = runtime.live({
    ...child,
    name: "replacement",
    render: (data, params) => `replacement:${params.format}:${data}`,
  });
  const unversioned = runtime.live({ ...replacement, name: "unversioned" });
  delete unversioned.revision;
  let currentChild = child;
  const sentinel = runtime.live({
    name: "sentinel",
    revision: () => 1,
    subscribe: () => [change("sentinel")],
    authorize: () => true,
    load: () => "marker",
    render: (marker) => marker,
  });
  const parent = runtime.live({
    name: "parent",
    subscribe: () => [change("parent")],
    authorize: () => true,
    load: () => ({ format, channel }),
    async render(params, _props, context) {
      const first = await context.view(currentChild, params);
      const second = await context.view(sentinel, {});
      return first + second;
    },
  });

  const initial = await runtime.renderPage(
    user,
    async (page, pageToken) =>
      streamToken(pageToken) + (await page.view(parent, {}))
  );
  const token = readToken(initial);
  expect(initial).toContain("plain:0");
  expect(
    (await runtime.openPage(token, { views: [], pristine: [] }, user)).status
  ).toBe("invalid-count");
  expect(
    (
      await runtime.openPage(
        token,
        { views: ["parent/child"], pristine: [] },
        user
      )
    ).status
  ).toBe("unknown-view");
  expect(
    (
      await runtime.openPage(
        token,
        { views: ["parent"], pristine: [] },
        { sessionId: "other" }
      )
    ).status
  ).toBe("denied");

  const page = await runtime.openPage(
    token,
    { views: ["parent"], pristine: [] },
    user
  );
  if (page.status !== "open") throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = page.connect(connection, () => user);

  function update(target: string, html?: string) {
    const patch = html === undefined ? { target } : { target, html };
    return expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: patch,
    });
  }
  try {
    await update("parent");
    await update("parent/child", "plain:0");
    await update("parent/sentinel", "marker");
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    expect(draws).toBe(2);

    await runtime.publish(change("parent"));
    await update("parent");
    await runtime.publish(change("sentinel"));
    await update("parent/sentinel", "marker");
    expect(draws).toBe(2);

    value = 1;
    await Promise.all([
      runtime.publish(change("parent")),
      runtime.publish(change("child")),
    ]);
    await update("parent");
    await update("parent/child", "plain:1");

    format = "formatted";
    await runtime.publish(change("parent"));
    await update("parent");
    await update("parent/child", "formatted:1");

    channel = "other";
    await runtime.publish(change("parent"));
    await update("parent");
    await update("parent/child", "formatted:1");
    await runtime.publish(change("child"));
    await runtime.publish(change("sentinel"));
    await update("parent/sentinel", "marker");
    value = 2;
    await runtime.publish(change("other"));
    await update("parent/child", "formatted:2");

    // A different definition is a different view, even with the same name.
    currentChild = replacement;
    await runtime.publish(change("parent"));
    await update("parent");
    await update("parent/replacement", "replacement:formatted:2");

    currentChild = unversioned;
    for (let i = 0; i < 2; i++) {
      await runtime.publish(change("parent"));
      await update("parent");
      await update("parent/unversioned", "replacement:formatted:2");
    }

    allowed = false;
    await runtime.publish(change("other"));
    await update("parent/unversioned", "");
  } finally {
    connection.close();
    await live;
  }
});

it("keys each Live View by its registered, unique name", async () => {
  const change = topic("change", () => "all");
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof change>,
    string
  >({ renderer, pubsub: createMemoryPubSub() });
  const base = {
    subscribe: () => [change()],
    authorize: () => true,
    load: () => "",
  };
  const panel = runtime.live({
    ...base,
    name: "panel",
    render: () => "first",
  });
  const repeated = runtime.live({
    ...base,
    name: "item",
    key: (params: { id: string }) => params.id,
    load: (params: { id: string }) => params.id,
    render: (id) => id,
  });
  const user = { sessionId: "viewer" };

  const html = await runtime.renderPage(user, async (page) =>
    [
      await page.view(panel, {}),
      await page.view(repeated, { id: "a" }),
      await page.view(repeated, { id: "b" }),
    ].join("")
  );
  expect(html).toBe(
    [
      '<div data-target="panel">first</div>',
      '<div data-target="item.a">a</div>',
      '<div data-target="item.b">b</div>',
    ].join("")
  );

  expect(() =>
    runtime.live({ ...base, name: "panel", render: () => "second" })
  ).toThrow("Duplicate Live View name: panel");

  await expect(
    runtime.renderPage(user, async (page) => {
      await page.view(repeated, { id: "a" });
      return page.view(repeated, { id: "a" });
    })
  ).rejects.toThrow("Invalid, duplicate or too-deep Live View key: item.a");
  await expect(
    runtime.renderPage(user, async (page) => {
      await page.view(panel, {});
      return page.view(panel, {});
    })
  ).rejects.toThrow("Invalid, duplicate or too-deep Live View key: panel");

  const loose = { ...base, name: "loose", render: () => "" };
  await expect(
    runtime.renderPage(user, (page) => page.view(loose, {}))
  ).rejects.toThrow("Unregistered Live View: loose");

  const name: string = "no.dots";
  expect(() => runtime.live({ ...base, name, render: () => "" })).toThrow(
    "Invalid Live View name: no.dots"
  );

  expect(() =>
    runtime.live({
      ...base,
      // @ts-expect-error A literal name with "/" would break the parent/child key path.
      name: "no/slash",
      render: () => "",
    })
  ).toThrow("Invalid Live View name: no/slash");

  // @ts-expect-error name is required
  const nameless: Parameters<typeof runtime.live>[0] = {
    ...base,
    render: () => "",
  };
  void nameless;
});

it("reconciles a missed notification without sending unchanged HTML", async () => {
  const changed = topic("counter", () => "shared");
  const diagnostics: LiveDiagnostic<ReturnType<typeof changed>>[] = [];
  const pubsub = createMemoryPubSub<ReturnType<typeof changed>>();
  let value = 0;
  let reconcileCount = 0;
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: {
      ...pubsub,
      publish: () => Promise.reject(new Error("delivery unavailable")),
    },
    reconcileIntervalMs: 25,
    onDiagnostic(event) {
      diagnostics.push(event);
      if (
        event.type === "render" &&
        event.reason === "reconcile" &&
        ++reconcileCount === 1
      )
        value = 1;
    },
  });
  const view = runtime.live({
    name: "counter",
    authorize: () => true,
    subscribe: () => [changed()],
    load: () => value,
    render: (count) => String(count),
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) => streamToken(key) + (await page.view(view, {}))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["counter"], pristine: [] },
    user
  );
  if (registered.status !== "open")
    throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = registered.connect(connection, () => user);
  try {
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { version: 1, html: "0" },
    });
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    await expect(runtime.publish(changed())).rejects.toThrow(
      "delivery unavailable"
    );
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { version: 2, html: "1" },
    });
    expect(diagnostics).toEqual([
      { type: "render", target: "counter", reason: "connect" },
      { type: "publish-error", topic: changed() },
      { type: "render", target: "counter", reason: "reconcile" },
      { type: "render", target: "counter", reason: "reconcile" },
    ]);
  } finally {
    connection.close();
    await live;
  }
});

it("shares leaf HTML across equal snapshots while checking access for each viewer", async () => {
  const changed = topic("shared", (key: string) => key);
  interface User extends Principal {
    group: string;
    allowed: boolean;
  }
  const runtime = createLiveRuntime<User, ReturnType<typeof changed>, string>({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const drawn: string[] = [];
  let revision = 0;
  const view = runtime.liveShared({
    name: "status",
    authorize: (_params: object, user) => user.allowed,
    subscribe: (_params, user) => [changed(user.group)],
    load: (_params, user) => `${user.group}:${revision}`,
    renderShared(snapshot) {
      drawn.push(snapshot);
      return snapshot;
    },
  });
  async function open(user: User) {
    const token = readToken(
      await runtime.renderPage(
        user,
        async (page, key) => streamToken(key) + (await page.view(view, {}))
      )
    );
    const registered = await runtime.openPage(
      token,
      { views: ["status"], pristine: [] },
      user
    );
    if (registered.status !== "open")
      throw new Error("Expected a registered page");
    const connection = createConnection();
    const live = registered.connect(connection, () => user);
    return { connection, live };
  }
  const alice = { sessionId: "alice", group: "team", allowed: true };
  const bob = { sessionId: "bob", group: "team", allowed: true };
  const carol = { sessionId: "carol", group: "private", allowed: true };
  const clients = await Promise.all([alice, bob, carol].map(open));
  try {
    for (const { connection } of clients) {
      await connection.read();
      await expect(connection.read()).resolves.toEqual({ type: "ready" });
    }
    drawn.length = 0;
    const [first, second, third] = clients;
    if (!first || !second || !third) throw new Error("Expected three viewers");
    revision = 1;
    await runtime.publish(changed("team"));
    await expect(first.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "team:1" },
    });
    await expect(second.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "team:1" },
    });
    await runtime.publish(changed("private"));
    await expect(third.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "private:1" },
    });
    expect(drawn).toEqual(["team:1", "private:1"]);
    bob.allowed = false;
    await runtime.publish(changed("team"));
    await expect(second.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "" },
    });
  } finally {
    for (const client of clients) client.connection.close();
    await Promise.all(clients.map(({ live }) => live));
  }
});

it("checks a cheap revision before re-reading a snapshot and falls back when the check fails", async () => {
  const changed = topic("snapshot", () => "probe");
  let snapshot = { revision: 0, text: "first" };
  let snapshotReads = 0;
  let failProbe = false;
  const firstSkip = deferred();
  const sameHtmlSkip = deferred();
  const readingSecond = deferred();
  const releaseSecond = deferred();
  const diagnostics: string[] = [];
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
    reconcileIntervalMs: 25,
    onDiagnostic(event) {
      diagnostics.push(event.type);
      if (event.type === "reconcile-skipped") {
        if (snapshot.revision === 0) firstSkip.resolve();
        if (snapshot.revision === 2) sameHtmlSkip.resolve();
      }
    },
  });
  const view = runtime.live({
    name: "snapshot",
    subscribe: () => [changed()],
    authorize: () => true,
    async load() {
      snapshotReads++;
      const captured = snapshot;
      if (captured.revision === 1) {
        readingSecond.resolve();
        await releaseSecond.promise;
      }
      return captured;
    },
    snapshotRevision: {
      read() {
        if (failProbe) {
          failProbe = false;
          throw new Error("revision unavailable");
        }
        return snapshot.revision;
      },
      from: (data) => data.revision,
    },
    render: (data) => data.text,
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) => streamToken(key) + (await page.view(view, {}))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["snapshot"], pristine: [] },
    user
  );
  if (registered.status !== "open")
    throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = registered.connect(connection, () => user);
  try {
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "first", version: 1 },
    });
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    await firstSkip.promise;
    expect(snapshotReads).toBe(2);

    // No Topic was delivered for these commits.
    snapshot = { revision: 1, text: "second" };
    await readingSecond.promise;
    snapshot = { ...snapshot, revision: 2 };
    releaseSecond.resolve();
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "second", version: 2 },
    });
    await sameHtmlSkip.promise;
    expect(snapshotReads).toBe(4);

    failProbe = true;
    snapshot = { revision: 3, text: "third" };
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "third", version: 3 },
    });
    expect(diagnostics).toContain("revision-error");
    expect(snapshotReads).toBe(5);
  } finally {
    releaseSecond.resolve();
    connection.close();
    await live;
  }
});

it("merges overlapping authorized loads by scope and revision and releases both outcomes", async () => {
  const changed = topic("change", () => "all");
  interface User extends Principal {
    scope: string;
    revision: number;
    allowed: boolean;
  }
  const runtime = createLiveRuntime<User, ReturnType<typeof changed>, string>({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const gate = deferred();
  const selected = deferred();
  const reads: string[] = [];
  let useShared = false;
  let blockReads = true;
  let fail = false;
  let requests = 0;
  const view = runtime.liveShared(
    {
      name: "status",
      authorize: (_params: object, user) => user.allowed,
      subscribe: () => [changed()],
      load: (_params, user): string =>
        `individual:${user.sessionId}:${useShared ? "refresh" : "initial"}`,
      renderShared: (data) => data,
    },
    {
      shareLoad(_params, { scope, revision }) {
        if (!useShared || scope === "") return;
        if (++requests === 4) selected.resolve();
        return {
          scope,
          revision,
          async load() {
            const value = `${scope}:${revision}`;
            reads.push(value);
            if (fail) throw new Error("read failed");
            if (blockReads) await gate.promise;
            return value;
          },
        };
      },
    }
  );

  async function open(sessionId: string, scope: string, revision: number) {
    const user = { sessionId, scope, revision, allowed: true };
    const token = readToken(
      await runtime.renderPage(
        user,
        async (page, key) => streamToken(key) + (await page.view(view, {}))
      )
    );
    const registered = await runtime.openPage(
      token,
      { views: ["status"], pristine: [] },
      user
    );
    if (registered.status !== "open")
      throw new Error("Expected registered page");
    const connection = createConnection();
    const live = registered.connect(connection, () => user);
    await connection.read();
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    return { user, connection, live };
  }
  const [alice, bob, carol, newer, privateOnly] = await Promise.all([
    open("alice", "team", 1),
    open("bob", "team", 1),
    open("carol", "other-team", 1),
    open("newer", "team", 2),
    open("private", "", 1),
  ] as const);
  const peers = [bob, carol, newer, privateOnly];
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    useShared = true;
    await runtime.publish(changed());
    await selected.promise;
    bob.user.allowed = false;
    gate.resolve();
    for (const [client, html] of [
      [alice, "team:1"],
      [bob, ""],
      [carol, "other-team:1"],
      [newer, "team:2"],
      [privateOnly, "individual:private:refresh"],
    ] as const) {
      await expect(client.connection.read()).resolves.toMatchObject({
        type: "update",
        update: { html },
      });
    }
    expect([...reads].sort()).toEqual(["other-team:1", "team:1", "team:2"]);

    for (const peer of peers) peer.connection.close();
    await Promise.all(peers.map(({ live }) => live));
    blockReads = false;
    fail = true;
    await runtime.publish(changed());
    await expect(alice.connection.read()).resolves.toEqual({
      type: "view-error",
      target: "status",
    });
    fail = false;
    await runtime.publish(changed());
    await expect(alice.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "team:1" },
    });
    expect(reads.filter((read) => read === "team:1")).toHaveLength(3);
  } finally {
    gate.resolve();
    for (const client of [alice, ...peers]) client.connection.close();
    await Promise.all([alice, ...peers].map(({ live }) => live));
    log.mockRestore();
  }
});

it("renders the current snapshot on each connection and counts versions per connection", async () => {
  const changed = topic("change", () => "leaf");
  let value = 0;
  let reads = 0;
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const view = runtime.live({
    name: "leaf",
    authorize: () => true,
    subscribe: () => [changed()],
    load() {
      reads++;
      return value;
    },
    snapshotRevision: { read: () => value, from: (data) => data },
    render: String,
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) => streamToken(key) + (await page.view(view, {}))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["leaf"], pristine: [] },
    user
  );
  if (registered.status !== "open") throw new Error("Expected registered page");
  const first = createConnection();
  const initial = registered.connect(first, () => user);
  try {
    await expect(first.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "0", version: 1 },
    });
    await expect(first.read()).resolves.toEqual({ type: "ready" });
    value = 1;
    await runtime.publish(changed());
    await expect(first.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1", version: 2 },
    });
    expect(reads).toBe(3);
  } finally {
    first.close();
    await initial;
  }
  const next = createConnection();
  const resumed = registered.connect(next, () => user);
  try {
    await expect(next.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1", version: 1 },
    });
    await expect(next.read()).resolves.toEqual({ type: "ready" });
    expect(reads).toBe(4);
  } finally {
    next.close();
    await resumed;
  }
});

it("omits an unchanged leaf frame and closes a stalled stream", async () => {
  const changed = topic("change", () => "leaf");
  let value = 0;
  const rendered = deferred();
  const diagnostics: string[] = [];
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
    sendTimeoutMs: 100,
    onDiagnostic(event) {
      diagnostics.push(event.type);
      if (event.type === "render" && event.reason === "topic" && value === 0)
        rendered.resolve();
    },
  });
  const view = runtime.liveShared({
    name: "leaf",
    authorize: () => true,
    subscribe: () => [changed()],
    load: () => value,
    renderShared: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) => streamToken(key) + (await page.view(view, {}))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["leaf"], pristine: [] },
    user
  );
  if (registered.status !== "open") throw new Error("Expected registered page");
  const live = createConnection();
  const open = registered.connect(live, () => user);
  try {
    await live.read();
    await expect(live.read()).resolves.toEqual({ type: "ready" });
    await runtime.publish(changed());
    await rendered.promise;
    value = 1;
    await runtime.publish(changed());
    await expect(live.read()).resolves.toMatchObject({
      type: "update",
      update: { version: 2, html: "1" },
    });
    value = 2;
    await runtime.publish(changed());
    // No reader consumes this frame. The connection must close itself.
    await open;
    expect(live.signal.aborted).toBe(true);
    expect(diagnostics).toContain("send-timeout");
  } finally {
    live.close();
    await open;
  }
});

it("shares broker subscriptions and replaces disconnected or failed bindings", async () => {
  const change = topic("broker", () => "shared");
  const memory = createMemoryPubSub<ReturnType<typeof change>>();
  let starts = 0;
  let closes = 0;
  let notifications = 0;
  let disconnects = 0;
  let disconnect = () => {};
  let reject = false;
  const bus = shareTopicSubscriptions<ReturnType<typeof change>>({
    publish: (event) => memory.publish(event),
    async subscribe(event, notify, onDisconnect) {
      starts++;
      if (reject) throw new Error("offline");
      const stop = await memory.subscribe(event, notify);
      disconnect = onDisconnect ?? (() => {});
      return () => {
        closes++;
        stop();
      };
    },
  });
  const subscribe = () =>
    bus.subscribe(
      change(),
      () => {
        notifications++;
      },
      () => {
        disconnects++;
      }
    );
  const [stopFirst, stopSecond] = await Promise.all([subscribe(), subscribe()]);
  expect(starts).toBe(1);
  await bus.publish(change());
  expect(notifications).toBe(2);
  stopFirst();
  expect(closes).toBe(0);
  disconnect();
  expect(disconnects).toBe(1);
  expect(closes).toBe(1);
  stopSecond();
  reject = true;
  const failed = await Promise.allSettled([subscribe(), subscribe()]);
  expect(failed.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  expect(starts).toBe(2);
  reject = false;
  const stopThird = await subscribe();
  expect(starts).toBe(3);
  await bus.publish(change());
  expect(notifications).toBe(3);
  stopThird();
  expect(closes).toBe(2);
});

it("rebinds a disconnected broker subscription and reads the changes missed during the outage", async () => {
  const changed = topic("counter", () => "shared");
  const bus = createMemoryPubSub<ReturnType<typeof changed>>();
  const diagnostics: string[] = [];
  let disconnect = () => {};
  let unsubscribeCount = 0;
  let rejectNextBinding = false;
  let count = 0;
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: shareTopicSubscriptions({
      publish: (event) => bus.publish(event),
      async subscribe(event, listener, onDisconnect) {
        if (rejectNextBinding) {
          rejectNextBinding = false;
          throw new Error("broker unavailable");
        }
        disconnect = onDisconnect ?? (() => {});
        const stop = await bus.subscribe(event, listener);
        return () => {
          unsubscribeCount++;
          stop();
        };
      },
    }),
    onDiagnostic: (event) => {
      diagnostics.push(event.type);
    },
  });
  const view = runtime.live({
    name: "counter",
    subscribe: () => [changed()],
    authorize: () => true,
    load: () => count,
    render: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) => streamToken(key) + (await page.view(view, {}))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["counter"], pristine: [] },
    user
  );
  if (registered.status !== "open")
    throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = registered.connect(connection, () => user);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await connection.read();
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    const obsolete = disconnect;
    count = 1;
    rejectNextBinding = true;
    disconnect();
    await expect(connection.read()).resolves.toEqual({
      type: "view-error",
      target: "counter",
    });
    expect(unsubscribeCount).toBe(1);
    count = 2;
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "2" },
    });
    expect(diagnostics).toEqual([
      "render",
      "subscription-disconnected",
      "subscribe-error",
      "render",
    ]);
    obsolete();
    count = 3;
    await runtime.publish(changed());
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "3" },
    });
  } finally {
    connection.close();
    await live;
    log.mockRestore();
  }
  expect(unsubscribeCount).toBe(2);
});

it("delivers a fast root update while another root loads and keeps the slow root in order", async () => {
  const changed = topic("change", (key: "slow" | "fast") => key);
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  let slow = 0;
  let fast = 0;
  const entered = deferred();
  const blocked = deferred();
  const slowView = runtime.live({
    name: "slow",
    authorize: () => true,
    subscribe: () => [changed("slow")],
    async load() {
      const snapshot = slow;
      if (snapshot === 1) {
        entered.resolve();
        await blocked.promise;
      }
      return snapshot;
    },
    render: (value) => String(value),
  });
  const fastView = runtime.live({
    name: "fast",
    authorize: () => true,
    subscribe: () => [changed("fast")],
    load: () => fast,
    render: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  const token = readToken(
    await runtime.renderPage(
      user,
      async (page, key) =>
        streamToken(key) +
        ((await page.view(slowView, {})) + (await page.view(fastView, {})))
    )
  );
  const registered = await runtime.openPage(
    token,
    { views: ["slow", "fast"], pristine: [] },
    user
  );
  if (registered.status !== "open")
    throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = registered.connect(connection, () => user);
  try {
    await connection.read();
    await connection.read();
    await expect(connection.read()).resolves.toEqual({ type: "ready" });

    slow = 1;
    await runtime.publish(changed("slow"));
    await entered.promise;
    fast = 1;
    await runtime.publish(changed("fast"));
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { target: "fast", version: 3, html: "1" },
    });
    slow = 2;
    await runtime.publish(changed("slow"));
    blocked.resolve();
    for (const [version, html] of [
      [4, "1"],
      [5, "2"],
    ] as const) {
      await expect(connection.read()).resolves.toMatchObject({
        type: "update",
        update: { target: "slow", version, html },
      });
    }
  } finally {
    blocked.resolve();
    connection.close();
    await live;
  }
});

async function expectCounterUpdates(
  page: Awaited<
    ReturnType<ReturnType<typeof counterRuntime>["runtime"]["openPage"]>
  >,
  publisher: ReturnType<typeof counterRuntime>["runtime"],
  store: { count: number }
) {
  if (page.status !== "open")
    throw new Error(`Expected an open page, got ${page.status}`);
  const connection = createConnection();
  const live = page.connect(connection, () => viewer);
  try {
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { target: "counter", version: 1, html: String(store.count) },
    });
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    store.count++;
    await publisher.publish(counterChanged("all"));
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { target: "counter", version: 2, html: String(store.count) },
    });
  } finally {
    connection.close();
    await live;
  }
}

const counterKeys = { views: ["counter"], pristine: [] };

it("serves a page rendered by another runtime that holds the same key", async () => {
  const store = { count: 0 };
  const origin = counterRuntime(store, { pageKeys: [key1] });
  const receiver = counterRuntime(store, { pageKeys: [key1] });
  const token = await renderCounter(origin);
  const page = await receiver.runtime.openPage(token, counterKeys, viewer);
  expect(page.status).toBe("open");
  await expectCounterUpdates(page, receiver.runtime, store);
});

it("continues a page after the runtime is recreated", async () => {
  const store = { count: 0 };
  let current = counterRuntime(store, { pageKeys: [key1] });
  const token = await renderCounter(current);
  current = counterRuntime(store, { pageKeys: [key1] });
  const page = await current.runtime.openPage(token, counterKeys, viewer);
  expect(page.status).toBe("open");
  await expectCounterUpdates(page, current.runtime, store);
});

it("rejects tampered, foreign-key and expired tokens as expired", async () => {
  const store = { count: 0 };
  const diagnostics: LiveDiagnostic<CounterEvent>[] = [];
  const onDiagnostic = (event: LiveDiagnostic<CounterEvent>) => {
    diagnostics.push(event);
  };
  const owner = counterRuntime(store, { pageKeys: [key1], onDiagnostic });
  const foreign = counterRuntime(store, { pageKeys: [key2], onDiagnostic });
  const start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(start);
    const token = await renderCounter(owner);
    const middle = Math.floor(token.length / 2);
    const tampered =
      token.slice(0, middle) +
      (token[middle] === "A" ? "B" : "A") +
      token.slice(middle + 1);

    for (const [runtime, candidate] of [
      [owner.runtime, tampered],
      [owner.runtime, "not-a-token"],
      [foreign.runtime, token],
    ] as const) {
      diagnostics.length = 0;
      expect(
        (await runtime.openPage(candidate, counterKeys, viewer)).status
      ).toBe("expired");
      expect(diagnostics).toEqual([{ type: "page-token-invalid" }]);
    }

    diagnostics.length = 0;
    vi.setSystemTime(start + 12 * 60 * 60_000 - 1);
    expect(
      (await owner.runtime.openPage(token, counterKeys, viewer)).status
    ).toBe("open");
    vi.setSystemTime(start + 12 * 60 * 60_000 + 1);
    expect(
      (await owner.runtime.openPage(token, counterKeys, viewer)).status
    ).toBe("expired");
    expect(diagnostics).toEqual([]);

    const brief = counterRuntime(store, {
      pageKeys: [key1],
      pageLifetimeMs: 1_000,
    });
    vi.setSystemTime(start);
    const short = await renderCounter(brief);
    vi.setSystemTime(start + 1_000);
    expect(
      (await brief.runtime.openPage(short, counterKeys, viewer)).status
    ).toBe("expired");
  } finally {
    vi.useRealTimers();
  }
});

it("accepts a token sealed with a rotated-out key", async () => {
  const store = { count: 0 };
  const before = counterRuntime(store, { pageKeys: [key1] });
  const rotated = counterRuntime(store, { pageKeys: [key2, key1] });
  const token = await renderCounter(before);
  expect(
    (await rotated.runtime.openPage(token, counterKeys, viewer)).status
  ).toBe("open");

  // A rotated runtime seals with its first key only.
  const sealed = await renderCounter(rotated);
  const newKeyOnly = counterRuntime(store, { pageKeys: [key2] });
  expect(
    (await newKeyOnly.runtime.openPage(sealed, counterKeys, viewer)).status
  ).toBe("open");
  expect(
    (await before.runtime.openPage(sealed, counterKeys, viewer)).status
  ).toBe("expired");
});

it("accepts the same page key in base64 and base64url", async () => {
  const store = { count: 0 };
  const urlSafe = key1
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(urlSafe).not.toBe(key1);
  const token = await renderCounter(
    counterRuntime(store, { pageKeys: [key1] })
  );
  const receiver = counterRuntime(store, { pageKeys: [urlSafe] });
  expect(
    (await receiver.runtime.openPage(token, counterKeys, viewer)).status
  ).toBe("open");
});

it("resets when a token names a view the runtime no longer has", async () => {
  const store = { count: 0 };
  const token = await renderCounter(
    counterRuntime(store, { pageKeys: [key1] })
  );
  const redeployed = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub: createMemoryPubSub(),
    pageKeys: [key1],
  });
  expect((await redeployed.openPage(token, counterKeys, viewer)).status).toBe(
    "expired"
  );
});

it("denies another session and unknown keys", async () => {
  const counter = counterRuntime({ count: 0 });
  const token = await renderCounter(counter);
  const { runtime } = counter;
  expect(
    (await runtime.openPage(token, counterKeys, { sessionId: "other" })).status
  ).toBe("denied");
  expect(
    (
      await runtime.openPage(
        token,
        { views: ["missing"], pristine: [] },
        viewer
      )
    ).status
  ).toBe("unknown-view");
  expect(
    (await runtime.openPage(token, { views: [], pristine: [] }, viewer)).status
  ).toBe("invalid-count");
  expect(
    (
      await runtime.openPage(
        token,
        { views: Array.from({ length: 33 }, () => "counter"), pristine: [] },
        viewer
      )
    ).status
  ).toBe("invalid-count");
});

it("replaces the earlier connection of the same token", async () => {
  const store = { count: 0 };
  const counter = counterRuntime(store);
  const token = await renderCounter(counter);
  const open = async () => {
    const page = await counter.runtime.openPage(token, counterKeys, viewer);
    if (page.status !== "open") throw new Error("Expected an open page");
    const connection = createConnection();
    const live = page.connect(connection, () => viewer);
    await connection.read();
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    return { connection, live };
  };
  const first = await open();
  const second = await open();
  try {
    await first.live;
    expect(first.connection.signal.aborted).toBe(true);
    expect(second.connection.signal.aborted).toBe(false);
    store.count = 1;
    await counter.runtime.publish(counterChanged("all"));
    await expect(second.connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1", version: 2 },
    });

    // The first connection ended after the second took its place.
    const third = await open();
    try {
      await second.live;
      expect(second.connection.signal.aborted).toBe(true);
    } finally {
      third.connection.close();
      await third.live;
    }
  } finally {
    first.connection.close();
    second.connection.close();
    await Promise.all([first.live, second.live]);
  }
});

it("throws when the page token is too long", async () => {
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const bulky = runtime.live({
    name: "bulky",
    key: (params: { id: string; text: string }) => params.id,
    subscribe: () => [counterChanged("all")],
    authorize: () => true,
    load: () => "",
    render: () => "",
  });
  const text = "x".repeat(200);
  await expect(
    runtime.renderPage(viewer, async (page) => {
      let html = "";
      for (let id = 0; id < 32; id++)
        html += await page.view(bulky, { id: String(id), text });
      return html;
    })
  ).rejects.toThrow(/Live View page token is too long.*bulky/);
});

it("keeps keys and subscriptions when optional props are omitted", async () => {
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  let count = 0;
  const filtered = runtime.live({
    name: "filtered",
    key: (params: { filter?: string | undefined }) => params.filter ?? "all",
    subscribe: (params) => [counterChanged(params.filter ?? "all")],
    authorize: () => true,
    load: () => count,
    render: String,
  });
  const document = await runtime.renderPage(
    viewer,
    async (page, token) =>
      streamToken(token) + (await page.view(filtered, { filter: undefined }))
  );
  expect(document).toContain('data-target="filtered.all"');
  const page = await runtime.openPage(
    readToken(document),
    { views: ["filtered.all"], pristine: [] },
    viewer
  );
  if (page.status !== "open") throw new Error("Expected an open page");
  const connection = createConnection();
  const live = page.connect(connection, () => viewer);
  try {
    await connection.read();
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    count = 1;
    await runtime.publish(counterChanged("all"));
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { target: "filtered.all", html: "1" },
    });
  } finally {
    connection.close();
    await live;
  }
});

it("rejects page keys that are not 32 bytes", () => {
  const create = (pageKeys: readonly string[]) =>
    createLiveRuntime<Principal, CounterEvent, string>({
      renderer,
      pubsub: createMemoryPubSub(),
      pageKeys,
    });
  expect(() => create(["short"])).toThrow(RangeError);
  expect(() => create([])).toThrow(RangeError);
  expect(() => create(["!".repeat(44)])).toThrow(RangeError);
  expect(() => create([btoa("x".repeat(33))])).toThrow(RangeError);
  expect(() => create([key1, "short"])).toThrow(RangeError);
  expect(() => counterRuntime({ count: 0 }, { pageLifetimeMs: 0 })).toThrow(
    RangeError
  );
});

it("places the real token wherever the runtime script is written", async () => {
  const counter = counterRuntime({ count: 0 });
  let placeholder = "";
  const document = await counter.runtime.renderPage(
    viewer,
    async (page, token) => {
      placeholder = token;
      const script = streamToken(token);
      return script + (await page.view(counter.view, {})) + script;
    }
  );
  expect(document).not.toContain(placeholder);
  const tokens = [...document.matchAll(/data-token="([^"]+)"/g)].map(
    (match) => match[1]
  );
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBe(tokens[1]);
  expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(
    (await counter.runtime.openPage(readToken(document), counterKeys, viewer))
      .status
  ).toBe("open");

  // A page that never writes the token comes back as rendered.
  await expect(
    counter.runtime.renderPage(viewer, () => "static")
  ).resolves.toBe("static");
});

it("limits top-level props to JSON while child props stay unconstrained", () => {
  const runtime = createLiveRuntime<Principal, CounterEvent, string>({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const dated = runtime.live({
    name: "dated",
    subscribe: () => [counterChanged("all")],
    authorize: () => true,
    load: (params: { at: Date }) => params.at.toISOString(),
    render: String,
  });
  runtime.live({
    name: "parent",
    subscribe: () => [counterChanged("all")],
    authorize: () => true,
    load: () => null,
    render: (_data, _params, context) =>
      context.view(dated, { at: new Date() }),
  });
  const stamped = runtime.live({
    name: "stamped",
    subscribe: () => [counterChanged("all")],
    authorize: () => true,
    load: (params: { at: string; zone?: string | undefined }) => params.at,
    render: String,
  });
  const placeViews = async (
    page: PageRenderContext<Principal, CounterEvent, string>
  ) => {
    // @ts-expect-error Date is not JSON, so it cannot travel in the page token.
    await page.view(dated, { at: new Date() });
    return page.view(stamped, { at: "2026-11-24", zone: undefined });
  };
  expectTypeOf(placeViews).returns.toEqualTypeOf<Promise<string>>();
});
