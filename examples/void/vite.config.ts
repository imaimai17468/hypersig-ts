import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, searchForWorkspaceRoot } from "vite";
import { voidPlugin } from "void";

const source = normalizePath(
  fileURLToPath(new URL("../../src", import.meta.url))
);
const app = normalizePath(fileURLToPath(new URL("./app.tsx", import.meta.url)));

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "hono/jsx" } },
  plugins: [
    voidPlugin(),
    {
      name: "hypersig-ssr-reload",
      apply: "serve",
      async hotUpdate({ file, modules, read, server, timestamp }) {
        if (
          this.environment.config.consumer !== "server" ||
          !modules.length ||
          (file !== app && !file.startsWith(`${source}/`))
        )
          return;
        await read();
        const invalidated = new Set<(typeof modules)[number]>();
        for (const mod of modules) {
          this.environment.moduleGraph.invalidateModule(
            mod,
            invalidated,
            timestamp,
            true
          );
        }
        this.environment.hot.send({ type: "full-reload" });
        server.environments.client?.hot.send({
          type: "full-reload",
          path: "*",
        });
        return [];
      },
    },
  ],
  server: {
    port: Number(process.env.PORT ?? 5173),
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), source],
    },
  },
});
