# Project Instructions

hypersig.ts is a TypeScript web framework that keeps the page in step with data the server has committed. The server renders every view, and when the application publishes a change, it renders only the views subscribed to it and streams their HTML over Server-Sent Events. It carries over the thesis of the Rust [hypersig](https://github.com/imaimai17468/hypersig): every string the browser acts on is produced from a TypeScript type, so a mistake in one is a type error.

## Thesis

These strings come from a typed value, never from a string literal in application code:

- Action names, URLs, and inputs
- Form field names, including the fields that `data-hs-field-error` and `data-hs-draft` refer to
- Topic names and keys
- Live View keys
- Signal names and expressions, built with `signals()`, `signalFamily()`, and the `Expr` methods
- Links to the application's pages, built with Hono's `hc<typeof app>(...).$path()`

A change that lets an application write one of these by hand again, or that turns a type error into a runtime failure, needs the user's own words. Where TypeScript cannot hold a restriction, the API documentation names what goes unchecked and what happens when it is broken.

## Workflow

- Use the Bun and Node versions in `mise.toml`. Follow the setup commands in [README.md](README.md).
- Check existing usage and the pinned toolchain before relying on a command option, import path, or dependency behavior. Use official documentation or the dependency's source for behavior the repository does not establish.
- Format with `bun run format:fix` and run `bun run check` before finishing. Run `bun run test` for behavior changes and `bun run build` for changes to library code or the build setup. Report any applicable check you could not run.

## Design principles

- Design the boundaries a feature introduces so they can accommodate another state or implementation without changing callers. Give each distinct state a name and define the interface where a real module boundary needs one. Add concrete variants and abstractions as the work calls for them.
- Express constraints in types where possible. Use narrowing, type guards, or `satisfies` to resolve type errors.
- Exercise each new decision branch with inputs that make the test fail when that branch breaks.
- Keep comments about the behavior of the code they accompany. Prefer a clearer name or type when it can carry the same information.

## Scoped rules

- Read [Function design](.claude/rules/functions.md) when writing or changing TypeScript.
- Read [Library changes](.claude/rules/library.md) when designing the package API or editing library code or tests under `src/`.
