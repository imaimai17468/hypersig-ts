import { expect, it, vi } from "vite-plus/test";
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
    key: () => "child",
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
    render: (data, params) => `replacement:${params.format}:${data}`,
  });
  const unversioned = { ...replacement };
  delete unversioned.revision;
  let currentChild = child;
  const sentinel = runtime.live({
    key: () => "sentinel",
    revision: () => 1,
    subscribe: () => [change("sentinel")],
    authorize: () => true,
    load: () => "marker",
    render: (marker) => marker,
  });
  const parent = runtime.live({
    key: () => "parent",
    subscribe: () => [change("parent")],
    authorize: () => true,
    load: () => ({ format, channel }),
    async render(params, _props, context) {
      const first = await context.view(currentChild, params);
      const second = await context.view(sentinel, {});
      return first + second;
    },
  });

  let token = "";
  const initial = await runtime.renderPage(user, (page, pageToken) => {
    token = pageToken;
    return page.view(parent, {});
  });
  expect(initial).toContain("plain:0");
  expect(runtime.openPage("missing", ["parent"], user).status).toBe("expired");
  expect(runtime.openPage(token, [], user).status).toBe("invalid-count");
  expect(runtime.openPage(token, ["parent/child"], user).status).toBe(
    "unknown-view"
  );
  expect(
    runtime.openPage(token, ["parent"], { sessionId: "other" }).status
  ).toBe("denied");

  const page = runtime.openPage(token, ["parent"], user);
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

    currentChild = replacement;
    await runtime.publish(change("parent"));
    await update("parent");
    await update("parent/child", "replacement:formatted:2");

    currentChild = unversioned;
    for (let i = 0; i < 2; i++) {
      await runtime.publish(change("parent"));
      await update("parent");
      await update("parent/child", "replacement:formatted:2");
    }

    allowed = false;
    await runtime.publish(change("other"));
    await update("parent/child", "");
  } finally {
    connection.close();
    await live;
  }
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
    key: () => "counter",
    authorize: () => true,
    subscribe: () => [changed()],
    load: () => value,
    render: (count) => String(count),
  });
  const user = { sessionId: "viewer" };
  let token = "";
  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  const registered = runtime.openPage(token, ["counter"], user);
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
    key: () => "status",
    authorize: (_params: object, user) => user.allowed,
    subscribe: (_params, user) => [changed(user.group)],
    load: (_params, user) => `${user.group}:${revision}`,
    renderShared(snapshot) {
      drawn.push(snapshot);
      return snapshot;
    },
  });
  async function open(user: User) {
    let token = "";
    await runtime.renderPage(user, (page, key) => {
      token = key;
      return page.view(view, {});
    });
    const registered = runtime.openPage(token, ["status"], user);
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
    key: () => "snapshot",
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
  let token = "";
  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  const registered = runtime.openPage(token, ["snapshot"], user);
  if (registered.status !== "open")
    throw new Error("Expected a registered page");
  const connection = createConnection();
  const live = registered.connect(connection, () => user);
  try {
    await expect(connection.read()).resolves.toEqual({ type: "ready" });
    expect(diagnostics).toContain("initial-sync-skipped");
    await firstSkip.promise;
    expect(snapshotReads).toBe(1);

    // No Topic was delivered for these commits.
    snapshot = { revision: 1, text: "second" };
    await readingSecond.promise;
    snapshot = { ...snapshot, revision: 2 };
    releaseSecond.resolve();
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "second", version: 1 },
    });
    await sameHtmlSkip.promise;
    expect(snapshotReads).toBe(3);

    failProbe = true;
    snapshot = { revision: 3, text: "third" };
    await expect(connection.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "third", version: 2 },
    });
    expect(diagnostics).toContain("revision-error");
    expect(snapshotReads).toBe(4);
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
      key: () => "status",
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
    let token = "";
    await runtime.renderPage(user, (page, key) => {
      token = key;
      return page.view(view, {});
    });
    const registered = runtime.openPage(token, ["status"], user);
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

it("reuses only the initial SSR snapshot and processes updates during its revision check", async () => {
  const changed = topic("change", () => "leaf");
  let value = 0;
  let reads = 0;
  const checking = deferred();
  const release = deferred();
  const runtime = createLiveRuntime<
    Principal,
    ReturnType<typeof changed>,
    string
  >({
    renderer,
    pubsub: createMemoryPubSub(),
  });
  const view = runtime.live({
    key: () => "leaf",
    authorize: () => true,
    subscribe: () => [changed()],
    load() {
      reads++;
      return value;
    },
    snapshotRevision: {
      async read() {
        const captured = value;
        checking.resolve();
        await release.promise;
        return captured;
      },
      from: (data) => data,
    },
    render: String,
  });
  const user = { sessionId: "viewer" };
  let token = "";
  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  const registered = runtime.openPage(token, ["leaf"], user);
  if (registered.status !== "open") throw new Error("Expected registered page");
  const first = createConnection();
  const initial = registered.connect(first, () => user);
  try {
    await checking.promise;
    value = 1;
    await runtime.publish(changed());
    release.resolve();
    await expect(first.read()).resolves.toEqual({ type: "ready" });
    await expect(first.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1", version: 1 },
    });
    expect(reads).toBe(2);
  } finally {
    release.resolve();
    first.close();
    await initial;
  }
  const next = createConnection();
  const resumed = registered.connect(next, () => user);
  try {
    await expect(next.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "1", version: 2 },
    });
    await expect(next.read()).resolves.toEqual({ type: "ready" });
    expect(reads).toBe(3);
  } finally {
    next.close();
    await resumed;
  }

  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  value = 2;
  const changedBeforeConnect = runtime.openPage(token, ["leaf"], user);
  if (changedBeforeConnect.status !== "open")
    throw new Error("Expected registered page");
  const late = createConnection();
  const connected = changedBeforeConnect.connect(late, () => user);
  try {
    await expect(late.read()).resolves.toMatchObject({
      type: "update",
      update: { html: "2", version: 1 },
    });
    await expect(late.read()).resolves.toEqual({ type: "ready" });
    expect(reads).toBe(5);
  } finally {
    late.close();
    await connected;
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
    key: () => "leaf",
    authorize: () => true,
    subscribe: () => [changed()],
    load: () => value,
    renderShared: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  let token = "";
  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  const registered = runtime.openPage(token, ["leaf"], user);
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
    key: () => "counter",
    subscribe: () => [changed()],
    authorize: () => true,
    load: () => count,
    render: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  let token = "";
  await runtime.renderPage(user, (page, key) => {
    token = key;
    return page.view(view, {});
  });
  const registered = runtime.openPage(token, ["counter"], user);
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
    key: () => "slow",
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
    key: () => "fast",
    authorize: () => true,
    subscribe: () => [changed("fast")],
    load: () => fast,
    render: (value) => String(value),
  });
  const user = { sessionId: "viewer" };
  let token = "";
  await runtime.renderPage(user, async (page, key) => {
    token = key;
    return (await page.view(slowView, {})) + (await page.view(fastView, {}));
  });
  const registered = runtime.openPage(token, ["slow", "fast"], user);
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
