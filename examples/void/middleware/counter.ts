import { defineMiddleware } from "void/handler";
import { createCounterApp } from "../app.js";
import { createMemoryCounterStore } from "../store.js";

const development = import.meta.env.DEV;
const port = process.env.PORT ?? (development ? "5173" : "3000");
const origin = new URL(process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`)
  .origin;
const counter = createCounterApp({
  origin,
  title: "hypersig on Void",
  development,
  sessionSecret: process.env.SESSION_SECRET ?? crypto.randomUUID(),
  store: createMemoryCounterStore(),
});

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
