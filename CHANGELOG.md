# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor version may contain breaking changes; each one is listed here.

## [Unreleased]

### Added

- `action.call(input, { pending })` shows the user's own action until it is committed. `pending` takes `set` statements, which run when the call runs, before its input is evaluated. The runtime remembers the latest committed value of each path from every `data-hs-signals` load, lets a Live View update replace the shown value during the request, and on failure writes the latest committed value back to each path the request still owns before `onError` runs; a later call that writes the same path takes it over, and a `set` or `toggle` statement or a `bindValue` input that writes it ends the pending value, so a failure keeps that newer write. A path with no committed value makes the handler that runs the call throw and send nothing; inside another call's `onSuccess` or `onError`, the exception goes to `reportError` instead of an unhandled rejection. Any statement other than `set` is a `TypeError` when the call is built, and `isStmtNode` accepts the optional sixth element of a `call` only as a list of `set` statements. The Widgets favorite toggle uses it instead of a second signal holding the committed value. The docs now recommend the pending state alone in most cases, and say that copying server data into signals and changing it there gives the data two owners. The runtime grows by 262 B gzipped.
- Guidance on showing the user's own action before the server confirms it, as a pending echo, in the concepts page and `docs/architecture.md`: the line between predicting the server's result (not done) and echoing the user's own action, when to use it, and three rules (mark it pending, revert to the latest committed value on failure, let the committed value replace it). The reference no longer advises reverting to the value the page was rendered with, which is stale once another tab commits during the request.
- The Widgets example has a Favorite toggle that shows the click as a pending echo, with a "Fail next save" control and browser tests for the pending state, the revert, a commit from another tab during the request, and a second tab.
- `hypersig-ts/core` exports the `JsonValue` type, for typing Live View params that hold any JSON. A param property typed `unknown` is rejected by `PageRenderContext.view`.

### Changed

- **Breaking:** `on.keydown` counts Shift for a character key when Control, Alt, or Meta is held, so `"Control+Shift+z"` and `"Control+z"` are different keys. The character after Control, Alt, or Meta is compared in either case and must be written in lowercase; `"Control+Z"` is now a type error and throws. Without Control, Alt, or Meta, Shift is still ignored for a character key and `"Shift+?"` is still rejected. As a result, `"Meta+z"` no longer also matches Cmd+Shift+Z on macOS; map `"Shift+Meta+z"` for that.
- **Breaking:** `bindAttr` leaves out a non-boolean attribute whose expression evaluates to `null` on the server and removes it in the browser, where it used to render the attribute empty. An attribute such as `aria-activedescendant` can now be absent instead of empty, and `bindAttr` accepts expressions of a union type such as `string | null`. An empty string still renders the attribute empty. The Widgets combobox no longer renders `aria-activedescendant=""` while closed.
- The browser runtime parses each `data-hs-on-keydown` key map once and reads it again only after the attribute changes, instead of parsing every enclosing map on every keydown.
- The "Live View page token is too long" error says that the SSR snapshots of shared views count toward the limit as well as params.

### Fixed

- `customElement()` with an attribute kind other than `string`, `number`, `boolean`, or `json` now reports a type error naming the attribute and its kind, instead of a misleading message about attribute names.

## [0.1.0] - 2026-11-25

First public release on npm as `hypersig-ts`. Earlier internal versions, including the `1.0.0` placeholder in `package.json`, were never published.

### Added

- **Live Views over SSE.** `hypersig.live()` defines a server-rendered region with `subscribe`, `authorize`, `load`, and `render`. When the application publishes a Topic after committing a change, only the subscribed views render again, and their HTML streams to open pages over Server-Sent Events, where the browser runtime morphs it into place. A reconnect reads the current state again. Nested views, keyed instances, and opt-in sharing of identical reads and renders across connections are supported.
- **Typed Actions, Topics, and forms.** `hypersig.action()` takes Standard Schema input and output, an `authorize` check, and `execute`. `bind()` and `call()` check button inputs, `form()` and `field()` check form field names, and `fieldError()` marks where a field's message goes. `control()` derives `required`, `minLength`, `maxLength`, `pattern`, `min`, and `max` from the input schema's JSON Schema without making the browser stricter than the server. `topic()` gives publishers and subscribers one type for each change.
- **Browser signals.** `signals()` and `signalFamily()` hold browser-only JSON state whose expressions are data the runtime evaluates, so pages work under `script-src 'self'` without `eval`. Bindings render on the server for a correct first paint. Statements include `set`, `toggle`, `focus`, and `action.call()`, triggered by `on.click`, `on.input`, `on.change`, `on.keydown` (typed key maps), `on.focusEnter`, and `on.focusLeave`, together with `refs()`, `timer()` for delays and debouncing, and `when()` for branching. Expressions cover numbers, booleans, strings, and arrays. `action.pending()`, `data-hs-pending`, and drafts restored with `form({ draft: true })` show progress and keep unfinished input.
- **Page tokens.** A page's view registrations are sealed into an encrypted token bound to the app (`pageContext`), so any process holding the same `pageKeys` can continue the page. Streams end after `maxStreamMs` to pick up fresh credentials, and the token is renewed while the user can still read the page.
- **Custom elements and React islands.** `customElement()` declares an element's tag, attributes (including JSON), and events once as a value shared by the server and the browser. `CustomTag` renders it, a signal scope's `bindElement()` binds its attributes to signals, `defineElement()` implements it in the browser from `hypersig-ts/element`, and `reactElement()` mounts a React component as the element from `hypersig-ts/react`.
- **Security defaults.** Actions compare the request's `Origin` header with the configured origin and validate input on the server. Live View HTML is sanitized with DOMPurify before it enters the page. `bindAttr` rejects `href`, `src`, `on*`, and `style`. Each session holds at most `maxStreamsPerSession` streams per process, and automatic reloads after a reset are limited.
- A Hono adapter (`createHypersig`), a renderer-agnostic core (`hypersig-ts/core`), typed outlets (`errorOutlet()`, `connectionStatusOutlet()`), diagnostics events, and examples: Counter, TodoMVC, Shared memo, Rating, Sortable, Widgets, and Void with Cloudflare Workers.

[Unreleased]: https://github.com/imaimai17468/hypersig-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imaimai17468/hypersig-ts/releases/tag/v0.1.0
