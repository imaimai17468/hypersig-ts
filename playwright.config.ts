import { defineConfig } from "@playwright/test";

const counterPort = 3217;
const todoPort = 3218;
const counter = `http://127.0.0.1:${counterPort}`;
const todo = `http://127.0.0.1:${todoPort}`;

export default defineConfig({
  testDir: "./browser-tests",
  projects: [
    {
      name: "counter",
      testMatch: "counter.spec.ts",
      use: { baseURL: counter },
    },
    { name: "todomvc", testMatch: "todomvc.spec.ts", use: { baseURL: todo } },
  ],
  webServer: [
    {
      command: "bun examples/counter/server.tsx",
      env: { PORT: String(counterPort), COUNTER_METRICS: "1" },
      url: counter + "/metrics",
    },
    {
      command: "bun examples/todomvc/server.tsx",
      env: { PORT: String(todoPort) },
      url: todo + "/health",
    },
  ],
});
