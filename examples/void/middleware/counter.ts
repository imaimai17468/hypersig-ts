import { defineMiddleware } from "void/handler";
import { createCounterApp } from "../app.js";
import { createMemoryCounterStore } from "../store.js";

const development = import.meta.env.DEV;
const port = process.env.PORT ?? (development ? "5173" : "3000");
const origin = new URL(process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`)
  .origin;
const pageKey = process.env.HYPERSIG_PAGE_KEY;
const counter = createCounterApp({
  origin,
  title: "hypersig on Void",
  development,
  sessionSecret: readSessionSecret(process.env.SESSION_SECRET),
  ...(pageKey ? { pageKeys: [pageKey] } : {}),
  store: createMemoryCounterStore(),
});

// A secret made per process ends every session on restart and differs between
// instances, so only development makes one.
function readSessionSecret(secret: string | undefined): string {
  if (secret) return secret;
  if (development) return crypto.randomUUID();
  throw new Error("Set SESSION_SECRET to a secret of at least 32 characters");
}

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  if (
    path === "/" ||
    path.startsWith("/counters/") ||
    path.startsWith("/_hypersig/")
  ) {
    return counter.fetch(c.req.raw);
  }
  await next();
});
