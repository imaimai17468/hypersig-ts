import { expect, it } from "vite-plus/test";
import { createLiveRuntime, createMemoryPubSub, topic } from "./core.js";
import type { LiveMessage, LiveRenderer, Principal } from "./core.js";

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
