/// <reference types="bun" />
import { Context, Hono } from "hono";
import { hc } from "hono/client";
import { getCookie, setCookie } from "hono/cookie";
import * as v from "valibot";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  CustomTag,
  errorOutlet,
  on,
  signals,
  topic,
} from "../../src/index.js";
import { rating } from "./elements.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
// Built from rating.ts by `bun run example:rating:browser`.
const ratingScript = Bun.file(new URL("./dist/rating.js", import.meta.url));
// Demo only: unsigned in-memory session IDs that never expire, with no
// eviction or rate limit on minting them. See
// examples/shared-memo or examples/void/session.ts for a signed, expiring
// session.
const sessions = new Set<string>();
const cookie = "rating-session";
const maxScore = 5;
const scores: number[] = [];

const ratingsChanged = topic("ratings", () => "shared");
type RatingEvent = ReturnType<typeof ratingsChanged>;

const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<RatingEvent>(),
  authenticate(request) {
    const sessionId = getCookie(new Context(request), cookie);
    return sessionId && sessions.has(sessionId) ? { sessionId } : null;
  },
});

const vote = signals({ score: 0 }, { name: "vote" });

const save = hypersig.action("save-rating", {
  input: v.object({
    score: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxScore)),
  }),
  output: v.number(),
  // Every authenticated demo session can rate.
  authorize: () => true,
  async execute({ score }) {
    scores.push(score);
    await hypersig.publish(ratingsChanged());
    return scores.length;
  },
});

const summary = hypersig.live({
  name: "rating-summary",
  subscribe: () => [ratingsChanged()],
  authorize: () => true,
  load: () => ({
    count: scores.length,
    average:
      scores.length === 0
        ? 0
        : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  }),
  render({ count, average }) {
    const e = vote.with({});
    return (
      <section aria-label="Ratings" {...e.init()}>
        <p>
          Average <output id="rating-average">{average.toFixed(1)}</output> from{" "}
          <output id="rating-count">{count}</output>{" "}
          {count === 1 ? "rating" : "ratings"}
        </p>
        <CustomTag
          of={rating}
          id="rating"
          aria-label="Your rating"
          {...e.bindElement(rating, { value: e.score, max: maxScore })}
          {...rating.on("rate", (detail) => [
            e.score.set(detail),
            save.call({ score: detail }),
          ])}
        />
        <button type="button" {...on.click(e.score.set(0))}>
          Clear
        </button>
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
  .get("/rating.js", (c) =>
    c.body(ratingScript.stream(), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    })
  );
const links = hc<typeof app>("/");

async function renderPage(c: Context): Promise<Response> {
  const current = getCookie(c, cookie);
  if (!current || !sessions.has(current)) {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
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
        <title>hypersig Star Rating</title>
        {page.runtime(links["runtime.js"].$path())}
        <script type="module" src={links["rating.js"].$path()}></script>
      </head>
      <body>
        <main>
          <h1>Star rating</h1>
          {page.view(summary, {})}
          <p role="status" {...connectionStatusOutlet()}></p>
          <p role="alert" {...errorOutlet()}></p>
        </main>
      </body>
    </html>
  ));
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return response;
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`Star rating listening on ${origin}`);
