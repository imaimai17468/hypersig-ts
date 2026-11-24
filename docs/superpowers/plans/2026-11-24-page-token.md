# ページ登録の暗号化トークン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ページ登録をプロセスのメモリから AES-GCM のトークンに移し、どのプロセスでも SSE を受けられるようにする。

**Architecture:** SSR はトップレベル View の「名前・props・SSR 時の版とダイジェスト」とセッション ID、期限を暗号化して `data-hs-stream` の URL に入れる。`openPage` はトークンを復号し、ランタイムに登録済みの定義から `ViewInstance` を組み立て直す。ブラウザは SSR のまま触っていない View を `pristine` で知らせ、接続が開くたびに version を数え直す。

**Tech Stack:** TypeScript 7、WebCrypto（AES-GCM、SHA-256）、Hono、Vitest（`vite-plus/test`）、Playwright

**Spec:** `docs/superpowers/specs/2026-11-24-page-token-design.md`

## Global Constraints

- 暗号化は WebCrypto の AES-GCM。Node の `crypto` モジュールは使わない（Workers でも動かす）。
- 鍵は `pageKeys` の先頭で暗号化し、すべてで復号を試す。省いたら起動時に乱数で作る。
- 期限は SSR から数え、既定 12 時間（`pageLifetimeMs`）。接続中は延長しない。
- `name` は必須・ランタイム内で一意。キーは `name`（同じ親の下で複数置くときだけ `name.key`）。
- トップレベルの `page.view` の `params` は `JsonValue`（`src/protocol.ts`）。子の `context.view` は制限なし。
- 改ざん・鍵の不一致・期限切れ・消えた View 名はどれも `expired`（`reset`）。
- 接続 URL のパラメーター名（`view`、`pristine`）は `src/protocol.ts` で一度だけ定義する。
- 仕上げに `bun run format:fix`、`bun run check`、`bun run test`、`bun run build`。ブラウザに関わるタスクは `bun run test:browser`。

## Review Focus

1. **トークンの長さ**：View 32 個に大きめの props を入れると URL が長くなる。6 KB を超えたら SSR が View 名を含む例外を投げること（Task 2 にテストを置く）。
2. **props を JSON に直したときのずれ**：`{ filter: undefined }` のような省略可能なプロパティは往復で消える。消えても `key()` と `subscribe()` が同じ結果になること（Task 2 にテストを置く）。
3. **同じプロセスでの二重接続**：同じトークンで 2 本目が来たら 1 本目が閉じ、2 本目が更新を受けること。1 本目が終わっても 2 本目の対応表を消さないこと（Task 2 にテストを置く）。
4. **再試行で古い URL を使い続けること**：認可を失った View が空の更新を受けたあと、ネットワークが切れて再接続しても、View が描画し直されること（Task 4 のブラウザテスト）。
5. **鍵の指定ミス**：32 バイトにならない鍵や空の配列は、`createLiveRuntime` を呼んだ時点で例外にすること（Task 2 にテストを置く）。

---

### Task 1: View 名を一意な ID にし、定義をランタイムに登録する

**Files:**
- Modify: `src/render.ts`（`ViewRegistry`、`renderContext`）
- Modify: `src/live-runtime.ts`（`registry`、`live`、`liveShared`）
- Modify: `src/live.ts`（`name` を必須に、単体の `live()` を削除）
- Modify: `src/core.ts`、`src/index.ts`（`live` の export を外す）
- Modify: `examples/counter/server.tsx`、`examples/todomvc/server.tsx`、`examples/rating/server.tsx`（`hypersig.live` に）
- Test: `src/core.test.ts`、`src/index.test.ts`、`browser-tests/*.spec.ts`（キーの文字列 `xxx-1` を `xxx` に）

**Interfaces:**
- Produces: `ViewRegistry` に `register(definition): void`（名前の検査と重複検査、重複は `Duplicate Live View name: <name>`）、`identify(definition): string`（登録済みなら `name`、未登録は `Unregistered Live View: <name>` を投げる）、`resolve(name): LiveView | SharedLiveView | undefined` を持たせる。
- Produces: `LiveViewDefinition.name: string`（必須）。`NamedView<Name>` は `name: string extends Name ? string : Identifier<Name>` に。

- [ ] **Step 1: テストを書き換える**
  `src/core.test.ts` の「keys each Live View definition apart from every other definition」を次に置き換える。
  - `panel` と `item` を登録し、描画結果が `<div data-target="panel">first</div>`、`item.a`、`item.b` になる。
  - 同じ名前で 2 回 `runtime.live` すると `Duplicate Live View name: panel` を投げる。
  - `runtime.live` を通さないオブジェクト（`{ ...base, name: "loose", render }`）を `page.view` に渡すと `Unregistered Live View: loose` で reject する。
  - `name` を省いた定義は型エラー（`// @ts-expect-error name is required`）。
  最初のテストの「A different definition is a different view, even with the same name」は、`replacement` を `name: "replacement"` で登録し、キー `parent/replacement` を期待する形に直す。ほかのテストのキー文字列から `-1` などを外す。

- [ ] **Step 2: 失敗を確かめる**
  Run: `bun run test src/core.test.ts`
  Expected: 名前のキーと重複・未登録の例外のテストが FAIL

- [ ] **Step 3: 実装する**
  `registry` は `Map<string, definition>` と `WeakSet<definition>` を持つ。`live` / `liveShared` が `register` を呼んでから定義を返す。`renderContext.view` は `registry.identify(definition)` を使う（今の連番の `counts` は消す）。`src/live.ts` の単体 `live` と `name` の既定値 `view` の説明を消す。サンプル 3 つを `hypersig.live` に直す。

- [ ] **Step 4: テストを通す**
  Run: `bun run test && bun run check`
  Expected: PASS（`index.test.ts` とブラウザテストのキー文字列も直してあること）

- [ ] **Step 5: ブラウザテスト**
  Run: `bun run test:browser`
  Expected: PASS

- [ ] **Step 6: Commit**
  `git commit -m "Key Live Views by their registered name"`

### Task 2: トークンでページ登録を作り、組み立て直す

**Files:**
- Create: `src/page-token.ts`（鍵の読み込み、`sealPage`、`openPageToken`、`PageClaims` の検査）
- Modify: `src/render.ts`（`ViewInstance` の生成を `createViewInstance` に切り出す）
- Modify: `src/live-runtime.ts`（`pages` を消す。`renderPage`、`openPage`、二重接続の対応表）
- Modify: `src/diagnostics.ts`（`{ type: "page-token-invalid" }` を追加）
- Modify: `src/live.ts`（トップレベル用 `PageRenderContext`）
- Modify: `src/core.ts`、`src/index.ts`（`PageRenderContext` の型を export）
- Test: `src/core.test.ts`

**Interfaces:**
- Consumes: Task 1 の `registry.resolve(name)`、`registry.identify(definition)`
- Produces:
  - `LiveRuntimeOptions` に `pageKeys?: readonly string[]`（base64 または base64url で 32 バイト）、`pageLifetimeMs?: number`（既定 `12 * 60 * 60_000`）
  - `src/page-token.ts`:
    - `interface PageClaims { format: 1; sessionId: string; expiresAt: number; views: { name: string; params: JsonValue }[]; snapshots?: Record<string, { revision: string | number; digest: string }> }`
    - `createPageSealer(keys: readonly string[] | undefined): { seal(claims: PageClaims): Promise<string>; open(token: string, now: number): Promise<PageTokenResult> }`
    - `type PageTokenResult = { status: "valid"; claims: PageClaims } | { status: "invalid" } | { status: "expired" }`
    - `maxTokenLength = 6144`
  - `src/render.ts`: `createViewInstance(definition, params, target, renderer, registry): ViewInstance`
  - `src/live.ts`: `PageRenderContext<User, Event, Markup>` — `view` の `params` が `NoInfer<Params> & JsonValue`
  - `renderPage(user, render: (context: PageRenderContext, token: string) => Markup | Promise<Markup>): Promise<string>`（呼び方は今のまま）
  - `openPage(token: string, request: { views: readonly string[]; pristine: readonly string[] }, user: User): Promise<OpenPage<User>>`（`pristine` は Task 3 で使う。このタスクでは受け取るだけ）

- [ ] **Step 1: テストを書く**（`src/core.test.ts`）
  - `serves a page rendered by another runtime that holds the same key`：鍵 `k1` の runtime A で SSR、同じ鍵・同じ定義を登録した runtime B の `openPage` が `open`。B の `publish` で更新が届く。
  - `continues a page after the runtime is recreated`：A で SSR、A を捨てて作り直した A' で `open`。
  - `rejects tampered, foreign-key and expired tokens as expired`：1 文字変えたトークン、別の鍵の runtime、`vi.setSystemTime` で 12 時間 + 1 ms 進めたものが `expired`。改ざんと別の鍵は `onDiagnostic` に `{ type: "page-token-invalid" }`。
  - `accepts a token sealed with a rotated-out key`：`pageKeys: [k1]` で SSR、`[k2, k1]` の runtime で `open`。
  - `resets when a token names a view the runtime no longer has`：B に定義を登録しないと `expired`。
  - `denies another session and unknown keys`：`{ sessionId: "other" }` は `denied`、トークンにないキーは `unknown-view`、空や 33 個は `invalid-count`。
  - `replaces the earlier connection of the same token`（Review Focus 3）
  - `throws when the page token is too long`（Review Focus 1）：大きな props の View を並べると `renderPage` が `Live View page token is too long` を含む例外で reject。
  - `keeps keys and subscriptions when optional props are omitted`（Review Focus 2）
  - `rejects page keys that are not 32 bytes`（Review Focus 5）：`pageKeys: ["short"]` と `pageKeys: []` で `createLiveRuntime` が `RangeError`。
  - `places the real token wherever the runtime script is written`：`render` の中で View より前に `token` を文字列に入れ、結果の文書に仮の文字列が残らず、その値で `openPage` が `open`。
  - 型テスト：`page.view(v, { at: new Date() })` は型エラー（`// @ts-expect-error Date is not JSON`）、子の `context.view(v, { at: new Date() })` は通る。
  既存のテストは `openPage(token, keys, user)` を `await openPage(token, { views: keys, pristine: [] }, user)` に直す。

- [ ] **Step 2: 失敗を確かめる**
  Run: `bun run test src/core.test.ts`
  Expected: 新しいテストが FAIL

- [ ] **Step 3: `src/page-token.ts` を実装する**
  トークンは `base64url(iv(12 バイト) || 暗号文)`。平文は `JSON.stringify(claims)`。`open` は全鍵で復号を試し、JSON と `PageClaims` の形を検査し、`expiresAt <= now` なら `expired`。鍵を省いたら `crypto.getRandomValues` の 32 バイトから作る。鍵の取り込みは非同期なので Promise を保持する。

- [ ] **Step 4: `live-runtime.ts` を実装する**
  `renderPage`：仮の文字列 `crypto.randomUUID()` を `render` に渡し、直列化後に `split/join` で本物のトークンに置き換える。claims の `views` はトップレベルで描画した View（`renderContext` が集めた `views` の定義と、その `params` を `JSON.parse(JSON.stringify(params))` したもの）。ページ数の上限と寿命の掃除は消す。
  `openPage`：`sealer.open(token, Date.now())`、セッション照合、各 View を `registry.resolve` と `createViewInstance` で組み立て、キーを照合。
  二重接続：`Map<string, () => void>` をトークンのキーで持ち、接続の終わりに自分の `close` のときだけ消す。version は接続ごとのローカル変数で 1 から数える。`refresh` はセッションの照合だけにする。

- [ ] **Step 5: テストを通す**
  Run: `bun run test && bun run check`
  Expected: PASS

- [ ] **Step 6: Commit**
  `git commit -m "Seal page registrations into an encrypted token"`

### Task 3: SSR のスナップショットをダイジェストと `pristine` で扱う

**Files:**
- Modify: `src/render.ts`（`LeafSnapshot` を `{ revision; digest }` に）
- Modify: `src/stream.ts`（`lastUpdate.html` を `digest` に、近道の条件）
- Modify: `src/live-runtime.ts`（claims の `snapshots`、`pristine` の受け渡し）
- Test: `src/core.test.ts`

**Interfaces:**
- Consumes: Task 2 の `openPage(token, { views, pristine }, user)`、`PageClaims.snapshots`
- Produces: `digestHtml(html: string): Promise<string>`（SHA-256 の base64url、`src/page-token.ts`）

- [ ] **Step 1: テストを書く**
  - 既存の版照合の初回スキップのテスト（`initial-sync-skipped`）は、`pristine: [key]` を渡したときにだけ HTML を送らず `initial-sync-skipped` を報告するよう直す。
  - `renders a pristine-less view even when its revision is unchanged`：同じトークンで `pristine: []` なら、版が同じでも HTML を送る。
  - `skips an unchanged topic update after the initial sync`：初回スキップのあと、同じ HTML になる Topic 更新を送らない（ダイジェストでの比較）。

- [ ] **Step 2: 失敗を確かめる**
  Run: `bun run test src/core.test.ts`
  Expected: FAIL

- [ ] **Step 3: 実装する**
  `renderPage` は SSR の `initialSnapshot` を `{ revision, digest }` にして claims の `snapshots[target]` に入れる。`openPage` は `pristine` にあり `snapshots` にもある View だけ `initialSnapshots` に入れる。`stream.ts` は描画のたびに `digestHtml(fragment.html)` を求めて `lastUpdate.digest` で比べる。

- [ ] **Step 4: テストを通す**
  Run: `bun run test && bun run check`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Trust the SSR snapshot only for views the browser left untouched"`

### Task 4: Hono アダプターとブラウザのランタイム

**Files:**
- Modify: `src/protocol.ts`（`streamParams = { view: "view", pristine: "pristine" } as const`）
- Modify: `src/hono.ts`（`/stream/:token` で `pristine` を読み、`await runtime.openPage`）
- Modify: `src/browser.ts`（`pristine` の管理、`open` で `versions` を作り直す、`pristine` が減った接続の開き直し）
- Test: `src/index.test.ts`、`browser-tests/counter.spec.ts`

**Interfaces:**
- Consumes: Task 2・3 の `openPage`、`streamParams`

- [ ] **Step 1: テストを書く**
  - `src/index.test.ts`：`createHypersig` を 2 つ同じ `pageKeys` で作り、片方の `page()` の HTML から `data-hs-stream` を取り出し、もう片方の `routes` に `?view=...` で GET すると SSE の更新が届く。`?pristine=` の有無で初回の更新の有無が変わる。
  - 既存の「requests a new SSR document when the page registration has expired」は、`vi.setSystemTime` で期限を過ぎさせて `reset` を確かめる形に直す。
  - `browser-tests/counter.spec.ts`：
    - 版照合のある View を持つページで、サーバーを再起動したあと（テスト用のサーバーを止めて同じ `pageKeys` で立て直す）も、ほかのタブの Increment が届く。再起動前の version より小さい version の更新でも反映される。
    - 認可を失った View が空になったあと、ネットワークを切って（`context.setOffline`）戻すと、認可を戻した View が描画し直される（Review Focus 4）。

- [ ] **Step 2: 失敗を確かめる**
  Run: `bun run test src/index.test.ts && bun run test:browser`
  Expected: FAIL

- [ ] **Step 3: 実装する**
  `browser.ts`：接続を作るとき、まだ書き換えていないトップレベルのキーを `pristine` に付ける（最初の接続では全キー）。更新を適用したら、その更新の対象のルートキーを外す。`clearViews()` で全部外す。`source` の `open` で `versions` を新しい `WeakMap` にする。`error` で `readyState` が `CONNECTING` で、開いたときより `pristine` が減っていたら、`source.close()` し、1 秒後に `synchronize()` で開き直す（その間に別の接続ができていれば何もしない）。
  `hono.ts`：`openPage(token, { views: getAll(streamParams.view), pristine: getAll(streamParams.pristine) }, user)`。

- [ ] **Step 4: テストを通す**
  Run: `bun run test && bun run check && bun run build && bun run test:browser`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Reconnect pages across processes from the browser runtime"`

### Task 5: Workers のサンプルとドキュメント

**Files:**
- Modify: `examples/void/app.tsx`、`examples/void/worker/index.ts`、`examples/void/worker/wrangler.toml` または `.dev.vars` の扱い（鍵の受け渡しは実装で決める）
- Modify: `examples/void/worker/worker.test.ts`（再起動後は `reset` ではなく更新が続くことを確かめる）
- Modify: `examples/void/worker/README.md`、`docs/architecture.md`（「状態とライフサイクル」「Workers の共有状態」「レンダラーと配信の境界」の該当段落）
- Modify: `site/content/{ja,en}/deploy.html`（`#instances`）、`site/content/{ja,en}/limits.html`（複数台の記述）、`site/content/{ja,en}/reference.html`（`pageKeys`、`pageLifetimeMs`、`name` 必須、単体 `live` の削除）

- [ ] **Step 1: Worker のテストを書き換える**
  `worker.test.ts` の再起動の場面で、古いストリームに `reset` ではなく `ready` と現在値の更新が届き、別の入口の Increment が届くことを確かめる。

- [ ] **Step 2: 失敗を確かめる**
  Run: `cd examples/void && bun run test:worker`
  Expected: FAIL

- [ ] **Step 3: サンプルとドキュメントを直す**
  `createCounterApp` に `pageKeys` を渡せるようにし、Worker はシークレットから渡す。ドキュメントの「ページ登録はプロセスのメモリ」「1,024」「30 分」「接続先を固定」の記述を、トークン方式、鍵の共有、12 時間の期限、鍵の入れ替え手順に書き換える。英語版と日本語版で同じ内容にする。

- [ ] **Step 4: 確かめる**
  Run: `cd examples/void && bun run test:worker && bun run test`、ルートで `bun run format:fix && bun run check && bun run test && bun run build`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Document page tokens and continue Workers pages across restarts"`
