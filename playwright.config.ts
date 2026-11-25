import { defineConfig } from "@playwright/test";

const todoPort = 3218;
const memoPort = 3221;
const ratingPort = 3222;
const sortablePort = 3225;
const widgetsPort = 3226;
const todo = `http://127.0.0.1:${todoPort}`;
const memo = `http://127.0.0.1:${memoPort}`;
const rating = `http://127.0.0.1:${ratingPort}`;
const sortable = `http://127.0.0.1:${sortablePort}`;
const widgets = `http://127.0.0.1:${widgetsPort}`;

export default defineConfig({
  testDir: "./browser-tests",
  projects: [
    // counter.spec.ts starts a counter server for each worker.
    { name: "counter", testMatch: "counter.spec.ts" },
    { name: "todomvc", testMatch: "todomvc.spec.ts", use: { baseURL: todo } },
    { name: "memo", testMatch: "memo.spec.ts", use: { baseURL: memo } },
    { name: "rating", testMatch: "rating.spec.ts", use: { baseURL: rating } },
    {
      name: "sortable",
      testMatch: "sortable.spec.ts",
      use: { baseURL: sortable },
    },
    {
      name: "widgets",
      testMatch: "widgets.spec.ts",
      use: { baseURL: widgets },
    },
  ],
  webServer: [
    {
      command: "bun examples/todomvc/server.tsx",
      env: { PORT: String(todoPort) },
      url: todo + "/health",
    },
    {
      command: "bun examples/shared-memo/server.tsx",
      env: { PORT: String(memoPort) },
      url: memo + "/health",
    },
    {
      command:
        "bun run example:rating:browser && bun examples/rating/server.tsx",
      env: { PORT: String(ratingPort) },
      url: rating + "/health",
    },
    {
      command:
        "bun run example:sortable:browser && bun examples/sortable/server.tsx",
      env: { PORT: String(sortablePort) },
      url: sortable + "/health",
    },
    {
      command: "bun examples/widgets/server.tsx",
      env: { PORT: String(widgetsPort) },
      url: widgets + "/health",
    },
  ],
});
