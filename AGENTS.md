# Project Instructions

hypersig.ts is a TypeScript frontend framework.

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
