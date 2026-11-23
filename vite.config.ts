import { existsSync } from "node:fs";
import { defineConfig } from "vite-plus";

const hasVoidExample = existsSync(
  new URL("./examples/void/node_modules/void/package.json", import.meta.url)
);

export default defineConfig({
  fmt: {
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "es5",
    printWidth: 80,
    sortImports: { newlinesBetween: false },
  },
  lint: {
    ignorePatterns: [
      "node_modules/**",
      "dist/**",
      ...(hasVoidExample ? [] : ["examples/void/**"]),
    ],
    options: { typeAware: true, typeCheck: true },
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error" },
    rules: {
      "import/no-cycle": "error",
      "typescript/ban-ts-comment": "error",
      "typescript/consistent-type-exports": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/switch-exhaustiveness-check": "error",
    },
    overrides: [
      {
        files: ["src/**/*.{test,spec}.ts"],
        plugins: ["vitest"],
        rules: {
          "vitest/no-focused-tests": "error",
        },
      },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "jsdom",
  },
});
