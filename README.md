# hypersig.ts

[日本語](README.ja.md)

hypersig.ts is a TypeScript web framework that keeps server-rendered pages in step with the data you have saved.

- When you save data and announce the change, the server re-renders only the parts of the page that depend on it (Live Views) and streams them to every open tab over SSE.
- The browser receives HTML and a small runtime, never your application code. There is no hydration.
- The names the browser acts on, such as Action names, form field names, and Live View keys, come from types, so a typo is a type error.

You write the app with Hono and run it on Node, Bun, or Cloudflare Workers. With [Void](https://void.cloud/), the same Hono app plugs in through a middleware ([Void example](examples/void/README.md)).

| Package               | What it is                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `hypersig-ts`         | The Hono adapter                                                                           |
| `hypersig-ts/core`    | The core, for combining rendering and transport yourself                                   |
| `hypersig-ts/element` | Custom element declarations and their browser implementation (no Hono or React dependency) |
| `hypersig-ts/react`   | Mounts React components as custom elements (needs `react` and `react-dom` ^19)             |
| `hypersig-ts/redis`   | Delivers publications between processes through Redis Pub/Sub (bring your own client)      |

[English documentation](https://imaimai17468.github.io/hypersig-ts/) · [日本語ドキュメント](https://imaimai17468.github.io/hypersig-ts/ja/) · [Migrating from htmx](https://imaimai17468.github.io/hypersig-ts/from-htmx/)

> **Stability:** 0.x: minor versions may contain breaking changes; see [CHANGELOG](CHANGELOG.md).

## Install

```sh
npm install hypersig-ts hono
```

The package is ESM only and needs Node `^22.22.2 || ^24.15.0 || >=26.0.0` or Bun.

## Quick start

A counter that updates in every open tab. Input is validated with any [Standard Schema](https://standardschema.dev/) library; this example uses Valibot (`npm install valibot`).

```tsx
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  errorOutlet,
  topic,
} from "hypersig-ts";
import * as v from "valibot";

const counterChanged = topic("counter", () => "main");
let count = 0;

const hypersig = createHypersig({
  origin: "http://localhost:3000",
  pubsub: createMemoryPubSub<ReturnType<typeof counterChanged>>(),
  // Replace with your own session lookup. Give every session its own id.
  authenticate: () => ({ sessionId: "demo" }),
});

const increment = hypersig.action("increment", {
  input: v.object({}),
  output: v.number(),
  authorize: () => true,
  async execute() {
    count += 1;
    await hypersig.publish(counterChanged());
    return count;
  },
});

const counter = hypersig.live({
  name: "counter",
  subscribe: () => [counterChanged()],
  authorize: () => true,
  load: () => count,
  render: (value) => (
    <p>
      <output>{value}</output>
      <button type="button" {...increment.bind({})}>
        Increment
      </button>
    </p>
  ),
});

const app = new Hono();
app.route("/", hypersig.routes);
app.get("/runtime.js", async (c) =>
  c.body(
    await readFile(new URL(import.meta.resolve("hypersig-ts/runtime.js"))),
    {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    }
  )
);
app.get("/", (c) =>
  hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Counter</title>
        {page.runtime("/runtime.js")}
      </head>
      <body>
        {page.view(counter, {})}
        <p role="status" {...connectionStatusOutlet()}></p>
        <p role="alert" {...errorOutlet()}></p>
      </body>
    </html>
  ))
);

export default app;
```

`export default app` serves the app on Bun. On Node, pass `app` to `serve()` from `@hono/node-server`. Set `origin` to the public origin the browser uses, because every Action compares it with the request's `Origin` header. Pressing **Increment** in one tab updates the count in all of them. See [Get started](https://imaimai17468.github.io/hypersig-ts/start/) and the [API reference](https://imaimai17468.github.io/hypersig-ts/reference/) for sessions, forms, Signals, and deployment.

## Set up the repository

Use mise to install the Bun and Node versions the repository pins.

```sh
mise install
mise exec -- bun install --frozen-lockfile
```

## Run the examples

```sh
mise exec -- bun run example:counter
```

Open `http://127.0.0.1:3000` in two tabs and press **Increment main** in one of them; both counters update. [Counter source](examples/counter/server.tsx)

| Example                                        | Command                                                                    | What it shows                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TodoMVC](examples/todomvc/server.tsx)         | `mise exec -- bun run example:todomvc`                                     | An action shows as pending at once, and values change once they are committed                                                                     |
| [Shared memo](examples/shared-memo/server.tsx) | `mise exec -- bun run example:memo`                                        | The revision an edit started from and draft restoration, with no hand-written JavaScript                                                          |
| [Reviews](examples/rating/server.tsx)          | `mise exec -- bun run example:rating`                                      | Typed attributes and events on a custom element, whose children survive Live View updates                                                         |
| [Sortable](examples/sortable/server.tsx)       | `mise exec -- bun run example:sortable`                                    | A React and dnd-kit component mounted as a custom element, saving the new order                                                                   |
| [Widgets](examples/widgets/server.tsx)         | `mise exec -- bun run example:widgets`                                     | A combobox, tabs, a disclosure panel, a character counter, and a toast, with Signals alone, and a favorite button that shows the click as pending |
| [Void](examples/void/README.md)                | `cd examples/void && mise exec -- bun install && mise exec -- bun run dev` | The same Hono app plugged into Void through a middleware, also deployed to Workers                                                                |

To run one alongside Counter, set `PORT=3001` on one of them. [Running on Void](examples/void/README.md) · [Deploying to Workers](examples/void/worker/README.md)

## Development commands

If mise is not activated in your shell, prefix each command with `mise exec --`.

| Command                | What it does                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `bun run format:fix`   | Fix formatting                                                 |
| `bun run check`        | Check formatting, lint, and types                              |
| `bun run test`         | Run the tests with Vitest and jsdom                            |
| `bun run test:browser` | Start the examples and drive them with Playwright              |
| `bun run test:outbox`  | Verify the shared memo's SQLite outbox                         |
| `bun run build`        | Emit ESM, type declarations, and browser JavaScript to `dist/` |

Before running the browser tests for the first time, install Chromium with `mise exec -- node node_modules/@playwright/test/cli.js install chromium`.

## License

[ISC](LICENSE)

[Development rules](AGENTS.md) · [Architecture (Japanese)](docs/architecture.md) · [Benchmarks and reproduction steps (Japanese)](bench/README.md)
