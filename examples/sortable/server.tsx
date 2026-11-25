/// <reference types="bun" />
import { Context, Hono } from "hono";
import { hc } from "hono/client";
import { getCookie, setCookie } from "hono/cookie";
import * as v from "valibot";
import {
  ActionError,
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  CustomTag,
  errorOutlet,
  signals,
  topic,
} from "../../src/index.js";
import { sortableList } from "./elements.js";
import type { Item } from "./elements.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
// Built from list.tsx by `bun run example:sortable:browser`.
const listScript = Bun.file(new URL("./dist/list.js", import.meta.url));
const stylesheet = Bun.file(new URL("./style.css", import.meta.url));
const cookie = "sortable-session";
const initialItems: readonly Item[] = [
  { key: "code", label: "Write code" },
  { key: "review", label: "Review" },
  { key: "test", label: "Test" },
  { key: "deploy", label: "Deploy" },
];
const lastKey = "deploy";
// Each session has its own list, shared by that session's tabs.
// Demo only: one list per unsigned session ID, kept in memory without expiry,
// eviction or a rate limit on minting sessions. See
// examples/shared-memo or examples/void/session.ts for a signed, expiring
// session.
const lists = new Map<string, readonly Item[]>();

const itemsChanged = topic("task-order", (sessionId: string) => sessionId);
type ItemEvent = ReturnType<typeof itemsChanged>;

const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<ItemEvent>(),
  authenticate(request) {
    const sessionId = getCookie(new Context(request), cookie);
    return sessionId && lists.has(sessionId) ? { sessionId } : null;
  },
});

/** The items in the order of `keys`, or null when `keys` is not a reordering. */
function reorderItems(
  items: readonly Item[],
  keys: readonly string[]
): Item[] | null {
  if (keys.length !== items.length || new Set(keys).size !== keys.length) {
    return null;
  }
  const reordered: Item[] = [];
  for (const key of keys) {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) return null;
    reordered.push(item);
  }
  return reordered;
}

const reorder = hypersig.action("reorder-items", {
  input: v.object({ keys: v.pipe(v.array(v.string()), v.maxLength(100)) }),
  output: v.literal(true),
  // A session can reorder only its own list.
  authorize: () => true,
  async execute({ keys }, { sessionId }): Promise<true> {
    const next = reorderItems(lists.get(sessionId) ?? [], keys);
    if (!next) throw new ActionError(409, "The list changed. Reload the page.");
    // The rule this example enforces, so a save can fail.
    if (next.at(-1)?.key !== lastKey) {
      throw new ActionError(422, "Deploy has to stay last.");
    }
    lists.set(sessionId, next);
    await hypersig.publish(itemsChanged(sessionId));
    return true;
  },
});

const ui = signals({ failures: 0 }, { name: "sortable" });

const taskList = hypersig.live({
  name: "task-list",
  subscribe: (_params, { sessionId }) => [itemsChanged(sessionId)],
  authorize: () => true,
  load: (_params, { sessionId }) => lists.get(sessionId) ?? [],
  render(items) {
    const e = ui.with({});
    return (
      <section aria-label="Release steps" {...e.init()}>
        <CustomTag
          of={sortableList}
          id="tasks"
          items={items}
          {...e.bindElement(sortableList, { failures: e.failures })}
          {...sortableList.on("reorder", (keys) => [
            reorder.call(
              { keys },
              { onError: [e.failures.set(e.failures.add(1))] }
            ),
          ])}
        >
          {/* Shown until list.js renders the sortable list. */}
          <ol aria-label="Tasks">
            {items.map((item) => (
              <li>{item.label}</li>
            ))}
          </ol>
        </CustomTag>
      </section>
    );
  },
});

const app = new Hono()
  .route("/", hypersig.routes)
  .get("/", (c) => renderPage(c))
  .get("/health", (c) => c.text("OK"))
  .get("/runtime.js", (c) =>
    c.body(runtime.stream(), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    })
  )
  .get("/list.js", (c) =>
    c.body(listScript.stream(), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    })
  )
  .get("/style.css", (c) =>
    c.body(stylesheet.stream(), {
      headers: { "Content-Type": "text/css; charset=utf-8" },
    })
  );
const links = hc<typeof app>("/");

async function renderPage(c: Context): Promise<Response> {
  const current = getCookie(c, cookie);
  if (!current || !lists.has(current)) {
    const sessionId = crypto.randomUUID();
    lists.set(sessionId, initialItems);
    setCookie(c, cookie, sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect(links.index.$path());
  }
  const response = await hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>hypersig Sortable List</title>
        <link rel="stylesheet" href={links["style.css"].$path()} />
        {page.runtime(links["runtime.js"].$path())}
        <script type="module" src={links["list.js"].$path()}></script>
      </head>
      <body>
        <main>
          <h1>Release steps</h1>
          <p>
            Drag a step by its handle, or focus the handle and use Space and the
            arrow keys. Deploy has to stay last.
          </p>
          {page.view(taskList, {})}
          <p role="status" {...connectionStatusOutlet()}></p>
          <p role="alert" {...errorOutlet()}></p>
        </main>
      </body>
    </html>
  ));
  // React and dnd-kit set styles through `element.style`, which `style-src`
  // does not restrict, so no inline styles need to be allowed.
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return response;
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`Sortable list listening on ${origin}`);
