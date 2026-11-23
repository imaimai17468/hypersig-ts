---
paths:
  - "src/**/*.ts"
---

# Library changes

## Public API

- Export the package API from `src/index.ts`. Reuse familiar platform terms for concepts the framework shares with the web, such as `src` for a resource URL. Name callbacks for what they report, such as `onOpenChange` when several actions can change the open state.
- When adding or changing a stateful API, show who owns the value, what updates it, and when a caller can observe the new value. Document ordering or cleanup when callers depend on it.
- When an API changes, verify its types and runtime behavior using the built package from a caller's perspective.

## Module placement

- Place a private module beside its caller. Keep related modules together by purpose when their dependencies are shared. Split a module when each piece has a clear responsibility and a name that describes it.

## Tests

- Import Vitest APIs from `vite-plus/test`. Test observable behavior through the public API that a consumer uses.
- In type tests, describe the failure that `@ts-expect-error` is intended to verify.
