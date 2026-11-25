import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const devPort = 3219;
const prodPort = 3220;
const devUrl = `http://127.0.0.1:${devPort}`;
const prodUrl = `http://127.0.0.1:${prodPort}`;

export default defineConfig({
  testDir: "./tests",
  projects: [
    { name: "development", use: { baseURL: devUrl } },
    { name: "production", use: { baseURL: prodUrl } },
  ],
  webServer: [
    {
      command: `bun run dev --port ${devPort}`,
      env: { PORT: String(devPort), PUBLIC_ORIGIN: devUrl },
      url: devUrl + "/health",
    },
    {
      command: "bun run start",
      env: {
        PORT: String(prodPort),
        PUBLIC_ORIGIN: prodUrl,
        SESSION_SECRET: randomBytes(32).toString("hex"),
      },
      url: prodUrl + "/health",
    },
  ],
});
