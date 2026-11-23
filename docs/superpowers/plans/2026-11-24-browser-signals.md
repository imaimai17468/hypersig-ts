# ブラウザ側 Signal 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 型から組み立てた式をデータとして HTML に入れ、ブラウザのランタイムが評価する Signal を hypersig.ts に足す。共有メモの `editor.ts` を削除し、TodoMVC の完了切り替えを楽観的更新にする。

**Architecture:** 式・文・属性の JSON の型と評価器を `src/protocol.ts` と `src/evaluate.ts` に一度だけ定義し、サーバー側のビルダー（`src/signal.ts`）とブラウザ側のランタイム（`src/signal-runtime.ts`）の両方が使う。サーバーは値の入ったハンドルで式を評価して初期 HTML に書き、ブラウザは `data-hs-*` 属性を読んで同じ評価器で表示を更新する。Live View の中の `data-hs-signals` は morph のたびにストアを上書きする。

**Tech Stack:** TypeScript 7、Hono JSX、vitest（jsdom）、Playwright、Idiomorph、DOMPurify

**Spec:** `docs/superpowers/specs/2026-11-24-browser-signals-design.md`

## Global Constraints

- 値は `JsonValue`（`src/action.ts`）に限る。`Date` や `bigint` は型エラー。
- `eval` と `new Function` は使わない。CSP の `script-src 'self'` のまま動く。
- `bindAttr` で書ける属性は `disabled`、`checked`、`aria-pressed`、`aria-expanded`、`aria-current`、`aria-hidden`、`aria-invalid`、`aria-busy`、`data-*`（`data-hs-*` を除く）。`href`、`src`、`on*`、`style` は型にも実行時にも含めない。
- Signal グループと ref の `name` は `Identifier` 型（`src/identifier.ts`）で検査する。ID は `name-番号`、`name` の既定は `signal` と `ref`。
- 組み込みの Signal のパスは先頭が `$`（`Identifier` に使えない文字）で、アプリが書けない。
- ブラウザのランタイムの増分を計測して報告する。目安は gzip で 4 KB 以下。
- 各タスクの終わりに `bun run format:fix`、`bun run check`、`bun run test` を通す。ライブラリを変えたタスクは `bun run build` も通す。コミットは `AGENTS.md` の形式に従い、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- Live View の中の `bindValue` の入力欄に入力している最中に、その Live View が更新される。入力中の値が残るべき（Task 4 にテストを足す）。
- 受信した断片に、壊れた JSON の `data-hs-signals` や、知らない演算子を含む式がある。例外を出さず、ほかの束縛は更新されるべき（Task 4）。
- 送信中のボタンをもう一度押す。ハンドラ全体を飛ばし、楽観的な書き換えが二重に起きないべき（Task 5）。
- ネットワークエラー（status 0）で Action が失敗する。HTTP エラーと同じく元に戻るべき（Task 5）。
- `signalFamily` のキーに `"`、`/`、`.` を含むアプリのデータを使う。パスは配列なので、別の行と混ざらないべき（Task 2）。

---

### Task 1: ワイヤ形式と評価器

**Files:**

- Modify: `src/protocol.ts`
- Create: `src/evaluate.ts`
- Test: `src/evaluate.test.ts`

**Interfaces:**

- Produces（`src/protocol.ts`）:
  ```ts
  export type SignalPath = readonly string[];
  export type ExprNode =
    | ["lit", JsonValue]
    | ["sig", SignalPath]
    | ["not", ExprNode]
    | ["and" | "or" | "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "add" | "sub" | "mul" | "concat", ExprNode, ExprNode]
    | ["if", ExprNode, ExprNode, ExprNode]
    | ["get", ExprNode, string]
    | ["uuid"]
    | ["output"];
  export type StmtNode =
    | ["set", SignalPath, ExprNode]
    | ["toggle", SignalPath]
    | ["focus", string]
    | ["call", string, Record<string, ExprNode>, StmtNode[], StmtNode[]];
  export const signalAttributes: { signals: "data-hs-signals"; text: "data-hs-text"; show: "data-hs-show"; attr: "data-hs-attr"; bind: "data-hs-bind"; ref: "data-hs-ref"; onSuccess: "data-hs-on-success"; onError: "data-hs-on-error" };
  export const eventAttributes: { click: "data-hs-on-click"; input: "data-hs-on-input"; change: "data-hs-on-change" };
  export const bindableAttributes: readonly ["disabled", "checked", "aria-pressed", "aria-expanded", "aria-current", "aria-hidden", "aria-invalid", "aria-busy"];
  export const booleanAttributes: readonly ["disabled", "checked"];
  export function isBindableAttribute(name: string): boolean; // 一覧か data-*（data-hs-* を除く）
  export function isExprNode(value: unknown): value is ExprNode;
  export function isStmtNode(value: unknown): value is StmtNode;
  ```
  `JsonValue` は `src/action.ts` から import する。`import/no-cycle` に当たる場合は `JsonValue` を `src/protocol.ts` に移し、`src/action.ts` から再 export する。
- Produces（`src/evaluate.ts`）:

  ```ts
  export interface EvaluationContext {
    read(path: SignalPath): JsonValue | undefined;
    output?: JsonValue;
    uuid(): string;
  }
  export function evaluate(
    node: ExprNode,
    context: EvaluationContext
  ): JsonValue;
  export function formatText(value: JsonValue): string; // null → "", 真偽値 → "true"/"false", 数値と文字列 → String, それ以外 → JSON.stringify
  ```

  型が合わない演算（`gt` に数値以外など）と、読めないパスは `null` を返す。`eq` / `ne` はプリミティブなら `Object.is`、それ以外は `JSON.stringify` の比較。

- [ ] **Step 1: 失敗するテストを書く**（`src/evaluate.test.ts`）
  - `evaluates arithmetic, comparison, logic and conditions`: `["add", ["lit", 1], ["sig", ["g", "n"]]]` に `n = 2` を読ませると `3`。`["gt", ["sig", ["g","n"]], ["lit", 1]]` は `true`。`["if", ["lit", false], ["lit","a"], ["lit","b"]]` は `"b"`。`["concat", ["lit","v"], ["lit","1"]]` は `"v1"`。
  - `reads output fields and generates ids`: `["get", ["output"], "revision"]` を `output: { revision: 4 }` で評価すると `4`。`["uuid"]` は `context.uuid()` の戻り値。
  - `returns null for mismatched types and unknown paths`: `["gt", ["lit","a"], ["lit",1]]` と未定義のパスは `null`。
  - `validates nodes from untrusted attributes`: `isExprNode(["eval", "x"])`、`isExprNode(["add", ["lit",1]])`、`isStmtNode(["set", "a", ["lit",1]])` は `false`。正しいノードは `true`。
  - `allows only listed attributes`: `isBindableAttribute` は `"aria-pressed"` と `"data-completed"` で `true`、`"href"`、`"onclick"`、`"style"`、`"data-hs-action"` で `false`。
- [ ] **Step 2:** `bun run test src/evaluate.test.ts` が import の失敗で FAIL することを確かめる。
- [ ] **Step 3:** 上の Interfaces を実装する。`isExprNode` / `isStmtNode` は再帰で引数の数と型を検査する。
- [ ] **Step 4:** `bun run test src/evaluate.test.ts` が PASS。
- [ ] **Step 5:** `bun run check` と `bun run test` を通してコミットする（`Define the signal wire format and its evaluator`）。

### Task 2: サーバー側のビルダー

**Files:**

- Create: `src/signal.ts`
- Modify: `src/index.ts`（`signals`、`signalFamily`、`ref`、`lit`、`uuid`、`on` と、型 `Expr`、`Signal`、`SignalScope`、`SignalRef` を export）
- Test: `src/signal.test.ts`

**Interfaces:**

- Consumes: Task 1 の `ExprNode`、`StmtNode`、`SignalPath`、`signalAttributes`、`eventAttributes`、`isBindableAttribute`、`evaluate`、`formatText`。
- Produces:

  ```ts
  export interface Expr<T extends JsonValue> { readonly node: ExprNode; eq(other: T | Expr<T>): Expr<boolean>; ne(other: T | Expr<T>): Expr<boolean> }
  // T で増えるメソッド（条件型で付ける）:
  //   number: add/sub/mul(other) → Expr<number>, gt/ge/lt/le(other) → Expr<boolean>
  //   boolean: not() → Expr<boolean>, and/or(other) → Expr<boolean>, then<R>(a: R | Expr<R>, b: R | Expr<R>) → Expr<R>
  //   string: concat(other: string | Expr<string>) → Expr<string>
  //   object: get<K extends keyof T & string>(key: K) → Expr<T[K]>
  export interface Signal<T extends JsonValue> extends Expr<T> { readonly path: SignalPath; set(value: T | Expr<T>): StmtNode; toggle: T extends boolean ? () => StmtNode : never }
  export type SignalGroup<Values extends Record<string, JsonValue>> = { readonly [K in keyof Values]: Signal<Values[K]> } & {
    with(values: Partial<Values>): SignalScope<Values>;
  };
  export type SignalScope<Values> = SignalGroup<Values> & {
    init(): { "data-hs-signals": string };
    bindText(expr: Expr<JsonValue>): { "data-hs-text": string; children: string };
    bindShow(expr: Expr<boolean>): { "data-hs-show": string; hidden?: true };
    bindAttr(attrs: Partial<Record<BindableAttribute, Expr<JsonValue>>>): Record<string, string | true> & { "data-hs-attr": string };
    bindValue(signal: Signal<string | number | boolean>): { "data-hs-bind": string; value?: string; checked?: true };
  };
  export function signals<const Name extends string = never, Values extends Record<string, JsonValue>>(initial: Values, options?: { name?: Identifier<Name> }): SignalGroup<Values>;
  export function signalFamily<const Name extends string = never, Values extends Record<string, JsonValue>>(initial: Values, options?: { name?: Identifier<Name> }): { at(key: string): SignalGroup<Values> };
  export interface SignalRef { attr(): { "data-hs-ref": string }; focus(): StmtNode }
  export function ref<const Name extends string = never>(options?: { name?: Identifier<Name> }): SignalRef;
  export function lit<T extends JsonValue>(value: T): Expr<T>;
  export function uuid(): Expr<string>;
  export const on: { click(stmts: StmtNode | readonly StmtNode[]): { "data-hs-on-click": string }; input(...): ...; change(...): ... };
  /** Task 3 が Action の組み込み Signal と出力の Expr を作るのに使う。 */
  export function exprOf<T extends JsonValue>(node: ExprNode): Expr<T>;
  export function serializeStmts(stmts: StmtNode | readonly StmtNode[]): string;
  ```
  - パス: グループは `[id, field]`、ファミリーは `[id, key, field]`。ID は `signals()` / `signalFamily()` / `ref()` を呼んだときに、モジュール内の名前ごとのカウンタで `name-番号` を振る。
  - `data-hs-signals` の JSON は `[パス, 値]` の組の配列（例: `[[["memo-editor-1","base"],3],[["memo-editor-1","published"],5]]`）。グループもファミリーも同じ形なので、ランタイムは深さを推測しない。`with` で渡した項目だけでなく、全項目を初期値で埋めて書く。
  - サーバーでの評価: スコープの `read` は、自分のパスなら `with` の値か初期値を返す。ほかのグループのパスはモジュール内の登録表（ID → 初期値）から初期値を返す。先頭が `$` のパスは `false` を返す。`uuid` はサーバーでの評価では `""` を返す。
  - `bindAttr` は、`disabled` / `checked` が真なら `true`、偽なら属性を返さない。それ以外は `formatText` の結果を返す。キーの型は `BindableAttribute = typeof bindableAttributes[number] | \`data-${string}\``。実行時にも `isBindableAttribute` で検査し、外れたら例外を投げる。

- [ ] **Step 1: 失敗するテストを書く**（`src/signal.test.ts`）
  - `renders evaluated values for the request`: `const editor = signals({ base: 0, published: 0 }, { name: "memo-editor" })` と `const e = editor.with({ base: 3, published: 5 })` で、`e.bindText(e.base)` が `{ "data-hs-text": '["sig",["memo-editor-1","base"]]', children: "3" }`。`e.bindShow(e.published.gt(e.base))` は `hidden` を持たない。`editor.with({ base: 5, published: 5 }).bindShow(...)` は `hidden: true`。`e.init()["data-hs-signals"]` は `'[[["memo-editor-1","base"],3],[["memo-editor-1","published"],5]]'`。
  - `renders with Hono JSX`: `String(<span {...e.bindText(e.base)} />)` が `<span data-hs-text="...">3</span>` を含む。
  - `numbers groups per name`: 同じ `name` の 2 つ目は `-2`、`name` なしは `signal-1` で始まる。
  - `keys family members by arbitrary data`: `rows.at('a"/.b')` と `rows.at("a")` のパスが `[id, 'a"/.b', "completed"]` と `[id, "a", "completed"]` で、`init()` の JSON で別のキーになる。
  - `binds only allowed attributes`: `bindAttr({ "aria-pressed": e.flag, disabled: e.flag })` を `flag = true` で `{ "aria-pressed": "true", disabled: true, "data-hs-attr": ... }`、`false` で `disabled` を含まない。`// @ts-expect-error href could navigate to a value from a signal.` を付けた `bindAttr({ href: lit("/") })` が実行時にも例外を投げる。
  - `serializes statements and checks types`: `on.click([e.base.set(e.published), e.flag.toggle()])` の JSON。`// @ts-expect-error A number signal cannot take a string.` で `e.base.set("x")`。`// @ts-expect-error toggle exists only on boolean signals.` で `e.base.toggle()`。`// @ts-expect-error Signal values are JSON.` で `signals({ at: new Date() })`。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** `src/signal.ts` を実装し、`src/index.ts` から export する。
- [ ] **Step 4:** PASS を確かめる。
- [ ] **Step 5:** check / test / build を通してコミットする（`Add typed signal builders that render evaluated HTML`）。

### Task 3: Action の呼び出しと組み込み Signal

**Files:**

- Modify: `src/action.ts`
- Test: `src/index.test.ts`

**Interfaces:**

- Consumes: Task 2 の `Expr`、`exprOf`、`serializeStmts`、Task 1 の `StmtNode`。
- Produces（`registerAction` の戻り値に足す）:

  ```ts
  call(input: { [K in keyof Wire]: Wire[K] | Expr<Wire[K]> } /* Wire が JsonValue のときだけ。BindInput と同じメッセージ型 */, options?: { onSuccess?(output: Expr<Output>): StmtNode | readonly StmtNode[]; onError?: StmtNode | readonly StmtNode[] }): StmtNode; // ["call", url, input, onSuccess, onError]
  pending(): Expr<boolean>;       // ["sig", ["$pending", url]]
  draftRestored(): Expr<boolean>; // ["sig", ["$restored", url]]
  ```

  `form()` のオプションに `onSuccess?(output: Expr<Output>)` と `onError?` を足し、`data-hs-on-success` / `data-hs-on-error` に `serializeStmts` の結果を入れる。`Output` が `JsonValue` でないときは `onSuccess` の引数を `never` にする。`input` の値は `lit` を通して `ExprNode` にする。

- [ ] **Step 1: 失敗するテストを書く**（`src/index.test.ts`）
  - `builds call statements from values and signals`: `increment.call({ amount: s.amount })` が `["call", increment.url, { amount: ["sig", [...]] }, [], []]`。`// @ts-expect-error The schema does not accept a field named "ammount".` で `increment.call({ ammount: "1" })`。
  - `passes the action output to onSuccess`: `save.call(input, { onSuccess: (out) => s.base.set(out.get("revision")) })` の第 4 要素が `[["set", [...], ["get", ["output"], "revision"]]]`。
  - `exposes pending and restored state as expressions`: `increment.pending().node` が `["sig", ["$pending", increment.url]]`、`draftRestored()` も同様。
  - `attaches success statements to forms`: `increment.form({ onSuccess: () => s.flag.toggle() })["data-hs-on-success"]` が `'[["toggle",[...]]]'`。オプションがなければ属性はない。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS を確かめる。
- [ ] **Step 5:** check / test / build を通してコミットする（`Let actions run from signal statements`）。

### Task 4: ブラウザのランタイム（ストア、束縛、イベント、Live View の上書き）

**Files:**

- Create: `src/signal-runtime.ts`
- Modify: `src/browser.ts`（起動と、morph のあとの呼び出し）、`src/drafts.ts`（`restoreDrafts` が復元したフォームの Action URL を返す）
- Test: `src/signal-runtime.test.ts`

**Interfaces:**

- Consumes: Task 1 のすべて。
- Produces:

  ```ts
  export interface SignalRuntimeOptions {
    root: Document;
    /** Task 5 で browser.ts の send を渡す。Task 4 では未使用でよい。 */
    send?(
      control: HTMLElement,
      url: string,
      body: string
    ): Promise<{ ok: true; data: JsonValue } | { ok: false }>;
    uuid?(): string; // 既定 crypto.randomUUID
  }
  export interface SignalRuntime {
    /** morph した Live View の中にある data-hs-signals を、確定した値としてストアに入れる。入れ子の [data-hs-view] の中は読まない。 */
    applySnapshots(view: HTMLElement): void;
    write(path: SignalPath, value: JsonValue): void;
    read(path: SignalPath): JsonValue | undefined;
  }
  export function startSignals(options: SignalRuntimeOptions): SignalRuntime;
  ```
  - 起動の順序は設計書の「ページを読み込んだときの順序」どおり。`browser.ts` は `restoreDrafts` のあとに `startSignals` を呼ぶ。
  - ストアは `Map<string, JsonValue>`。キーはパスの `JSON.stringify`。`data-hs-signals` の `[パス, 値]` の組をそのまま入れる。パスが文字列の配列でないか、値が `JsonValue` でない組は無視する。
  - 変更があったら、マイクロタスクで文書中の束縛を全部評価し直す。`data-hs-text` は `textContent`、`data-hs-show` は `hidden`、`data-hs-attr` は許可した属性だけ、`data-hs-bind` は `value` / `checked`（フォーカス中の入力欄は書き換えない）。
  - `input` / `change` イベントで、`data-hs-bind` の入力欄の値をストアに書く。`number` への変換は `Number()` で、有限でなければ書かない。
  - `click` / `input` / `change` で、最も近い `data-hs-on-*` の文を順に実行する。`set`、`toggle`、`focus`（`[data-hs-ref="id"]` の要素）。`call` は Task 5。
  - 属性の JSON が壊れているか、`isExprNode` / `isStmtNode` を通らない場合は、その束縛だけを無視する。
  - `browser.ts` の html-update の処理で、`Idiomorph.morph` のあとに `runtime.applySnapshots(node)` を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**（`src/signal-runtime.test.ts`、jsdom で `document.body.innerHTML` を組み、`startSignals({ root: document })`）。HTML は Task 2 のビルダーと Hono JSX で作る。
  - `initializes from data-hs-signals and updates bound text on click`
  - `prefers a restored or browser-kept input value at load`: `bindValue` の入力欄の `value` を `defaultValue` と違う値にしてから起動すると、ストアがその値になる。
  - `converts number inputs and ignores non-finite values`
  - `binds only allowed attributes even from a crafted attribute`: `data-hs-attr='{"href":["lit","/x"]}'` を手で置いても `href` を付けない。
  - `applies Live View snapshots but not those of nested views`
  - `keeps a focused input's value when its Live View snapshot arrives`（Review Focus 1）
  - `ignores malformed signal attributes and keeps other bindings working`（Review Focus 2）
  - `focuses a ref`
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装し、`browser.ts` と `drafts.ts` を繋ぐ。
- [ ] **Step 4:** PASS を確かめ、`bun run test:browser` が既存の 19 件のまま通ることを確かめる。
- [ ] **Step 5:** check / test / build を通してコミットする（`Run signal bindings in the browser runtime`）。

### Task 5: 楽観的更新と組み込み Signal

**Files:**

- Modify: `src/signal-runtime.ts`、`src/browser.ts`（`handleActions` の `send` を返し、`startSignals` に渡す。送信中と成功・失敗をランタイムに伝える）
- Test: `src/signal-runtime.test.ts`

**Interfaces:**

- Consumes: Task 4 の `SignalRuntimeOptions.send`、Task 3 の `call` / `pending` / `draftRestored` / `form` の属性。
- Produces: なし（ランタイム内の振る舞い）。
- 振る舞い:
  - `call` を実行するとき、同じハンドラでそれより前に `set` / `toggle` したパスの元の値を記録し、送信が終わるまで「保留中」にする。保留中のパスに `applySnapshots` で値が届いたら、適用せずに最新の値だけを覚える。
  - 成功: 覚えた値があれば適用する。`onSuccess` を `output` 付きで実行する。
  - 失敗（HTTP エラーとネットワークエラー）: 覚えた値があればそれを、なければ元の値を書き戻す。`onError` を実行する。
  - クリックした要素が送信中なら、ハンドラ全体を実行しない（Review Focus 3）。
  - `["$pending", url]` は、その URL の送信が始まると `true`、終わると `false`。フォームの送信（`data-hs-form`）とボタンの `data-hs-action` も対象にする。
  - `["$restored", url]` は、起動時に `restoreDrafts` が返した URL を `true` にし、その URL の Action が成功したら `false` にする。
  - フォームの送信が成功したら `data-hs-on-success` を、失敗したら `data-hs-on-error` を実行する。`send` が JSON の `data` を返すように変える（今は `reportSuccess` のときだけ読む）。

- [ ] **Step 1: 失敗するテストを書く**（`send` は解決を手で制御できる偽物を渡す）
  - `shows an optimistic change before the response and keeps it on success`
  - `reverts on failure unless the server sent a newer value`
  - `holds snapshots while a call is pending and applies the latest on success`
  - `reverts on a network error`（Review Focus 4。`send` が `{ ok: false }` を返す）
  - `skips the whole handler while its control is pending`（Review Focus 3）
  - `tracks pending state per action URL`
  - `clears the restored flag when the form's action succeeds`
  - `runs form success statements with the action output`
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS と、`bun run test:browser` の既存 19 件を確かめる。
- [ ] **Step 5:** check / test / build を通してコミットする（`Apply optimistic signal writes around action calls`）。

### Task 6: 共有メモを Signal に移す

**Files:**

- Delete: `examples/shared-memo/editor.ts`
- Modify: `examples/shared-memo/server.tsx`（`editor.js` のルートと `<script>` を消す）、`browser-tests/memo.spec.ts`（必要ならセレクタだけ）
- Test: `browser-tests/memo.spec.ts`

**Interfaces:**

- Consumes: Task 2〜5 の公開 API。
- 置き換え:
  - `const editor = signals({ base: 0, published: 0, operation: "" }, { name: "memo-editor" })`。フォームは `editor.with({ base: draft.revision, published: <公開中の版>, operation: operationId })` のスコープで描く。
  - `publishedMemo` の描画に `{...editor.with({ published: <版> }).init()}` を出す。
  - 「編集元は版 N」は `bindText(e.base)`、新しい版の案内は `bindShow(e.published.gt(e.base))`、復元の案内は `bindShow(save.draftRestored())`。
  - hidden の `baseRevision` と `operationId` は `{...save.draft(...)} {...e.bindValue(...)}`。
  - 「表示中の版から編集を続ける」は `on.click([e.base.set(e.published), e.operation.set(uuid()), draftRef.focus()])` と `bindAttr({ disabled: save.pending() })`。
  - フォームは `save.form({ reportSuccess: true, draft: true, onSuccess: (out) => [e.base.set(out.get("revision")), e.operation.set(uuid())] })`。

- [ ] **Step 1:** `editor.ts` を消し、`bun run test:browser` で memo のテストが FAIL することを確かめる。
- [ ] **Step 2:** 上の置き換えを書く。
- [ ] **Step 3:** `bun run test:browser` が通ることを確かめる。テストの変更はセレクタの差し替えだけに留める。振る舞いの差（ボタンでエラー表示を消さない）でテストが落ちる場合は、その期待を変え、コミットの本文に差として書く。
- [ ] **Step 4:** `grep -rn "querySelector\|getElementById" examples/shared-memo` が何も出さないことを確かめる。
- [ ] **Step 5:** コミットする（`Replace the shared memo editor script with signals`）。

### Task 7: TodoMVC の楽観的な完了切り替え

**Files:**

- Modify: `examples/todomvc/server.tsx`、`examples/todomvc/style.css`（`.completed` を `li[data-completed="true"]` に）
- Test: `browser-tests/todomvc.spec.ts`

**Interfaces:**

- Consumes: Task 2〜5 の公開 API。
- 置き換え: `const rows = signalFamily({ completed: false }, { name: "todo-row" })`。`TodoRow` で `const r = rows.at(todo.key).with({ completed: todo.completed })`。`<li {...r.init()} {...r.bindAttr({ "data-completed": r.completed })}>`、ボタンは `{...r.bindAttr({ "aria-pressed": r.completed })}` と `{...on.click([r.completed.toggle(), toggle.call({ todoKey: todo.key, completed: r.completed })])}`、記号は `{...r.bindText(r.completed.then("✓", "○"))}`。

- [ ] **Step 1: 失敗するテストを書く**（`browser-tests/todomvc.spec.ts`）
  - `toggles a task before the server answers`: `page.route("**/_hypersig/actions/set-todo-completed", ...)` で応答を 1 秒遅らせ、クリック直後（100 ms 以内）に `aria-pressed="true"` を確かめる。応答のあとも `true` のまま。
  - `reverts a toggle the server rejects`: 同じルートを 500 で応答させ、`aria-pressed` が `false` に戻ることを確かめる。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 置き換えを書く。
- [ ] **Step 4:** `bun run test:browser` 全体が通ることを確かめる。
- [ ] **Step 5:** コミットする（`Toggle TodoMVC tasks optimistically with signals`）。

### Task 8: ドキュメントとランタイムの大きさ

**Files:**

- Modify: `site/content/en/reference.html`、`site/content/ja/reference.html`（Signals の節）、`docs/architecture.md`（Signal の節と既知の制約）、`AGENTS.md`（Thesis の一覧に「Signal の名前と式」を足す）

- [ ] **Step 1:** `git stash` の前後、またはこのブランチの最初のコミットとの比較で、`dist/runtime.js` の minify 後と `gzip -9` 後の大きさを測る。
- [ ] **Step 2:** reference に `signals` / `signalFamily` / `with` / 束縛 / `on` / `ref` / `call` / `pending` / `draftRestored` を書く。楽観的な表示が一瞬戻る順序の制約を書く。
- [ ] **Step 3:** `docs/architecture.md` に、Live View との役割分担、読み込みの順序、計測したランタイムの増分を書く。4 KB を超えた場合は理由を書く。
- [ ] **Step 4:** `bun run format:fix`、`bun run check`、`bun run test`、`bun run build`、`bun run test:browser` を通す。
- [ ] **Step 5:** コミットする（`Document browser signals`）。
