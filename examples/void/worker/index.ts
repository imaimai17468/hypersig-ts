/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { createCounterApp } from "../app.js";
import type { CounterStore } from "../store.js";

interface Bindings {
  readonly COUNTERS: DurableObjectNamespace<CounterRoom>;
  readonly ASSETS: Fetcher;
  readonly PUBLIC_ORIGIN: string;
  readonly SESSION_SECRET: string;
}

function createSqliteCounterStore(storage: DurableObjectStorage): CounterStore {
  const { sql } = storage;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`
  );
  return {
    read(key) {
      const [row] = sql
        .exec<{ value: number }>(
          "SELECT value FROM counters WHERE key = ?",
          key
        )
        .toArray();
      return row?.value ?? 0;
    },
    async increment(key) {
      const { value } = sql
        .exec<{ value: number }>(
          `INSERT INTO counters (key, value) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET value = value + 1
         RETURNING value`,
          key
        )
        .one();
      await storage.sync();
      return value;
    },
  };
}

export class CounterRoom extends DurableObject<Bindings> {
  readonly #app: ReturnType<typeof createCounterApp>;

  constructor(context: DurableObjectState, env: Bindings) {
    super(context, env);
    this.#app = createCounterApp({
      origin: new URL(env.PUBLIC_ORIGIN).origin,
      title: "hypersig on Workers",
      sessionSecret: env.SESSION_SECRET,
      store: createSqliteCounterStore(context.storage),
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.#app.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/assets/hypersig-runtime.js")
      return env.ASSETS.fetch(request);
    return env.COUNTERS.getByName("shared-counter").fetch(request);
  },
} satisfies ExportedHandler<Bindings>;
