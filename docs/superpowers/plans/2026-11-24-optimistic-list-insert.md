# 一覧への楽観的な追加 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live View の外に置いたテンプレートから仮の行を複製して一覧に入れ、Action の結果とキーの照合で消す仕組みを足し、TodoMVC の追加と削除を応答前に表示する。

**Architecture:** ワイヤ形式に `insert` 文と属性を足し（`src/protocol.ts`）、サーバー側のビルダー `insertTemplate`（`src/signal.ts`）とフォームの `onSubmit`（`src/action.ts`）を作る。ブラウザのランタイム（`src/signal-runtime.ts`）は、`insert` を楽観的な書き込みと同じく `call` やフォームの送信に結び付け、失敗で取り除き、確定した行（`data-hs-confirms`）が届いたら取り除く。`src/browser.ts` は Idiomorph に仮の行を消させない。

**Tech Stack:** TypeScript 7、Hono JSX、vitest（jsdom）、Playwright、Idiomorph

**Spec:** `docs/superpowers/specs/2026-11-24-optimistic-list-insert-design.md`

## Global Constraints

- 確定した一覧は Live View だけが持つ。ブラウザは仮の行だけを描く。
- テンプレートは初期 HTML の、Live View の外にある `<template data-hs-template>` だけを使う。DOMPurify の `FORBID_TAGS: ["style", "template"]` は変えない。
- `insertTemplate` の `name` は `Identifier` で検査し、ID は `name-番号`（既定の `name` は `insert`）。`item` のパスは `["$item", field]`。
- `insert` の値と表示は今の束縛を通る。出力先は `textContent` と許可した属性だけ。
- `eval` / `new Function` は使わない。値は `JsonValue`。
- 各タスクの終わりに `bun run format:fix`、`bun run check`、`bun run test` を通す。ライブラリを変えたら `bun run build`、例やランタイムを変えたら `bun run test:browser` も通す。作業単位でコミットし、通ったら `git push origin main` する。`README.md` はステージしない。

## Review Focus

- 挿入先がないページ（TodoMVC の Completed）で `insert` を実行する。何も入らず、例外も出ず、`call` は送られるべき（Task 2）。
- テンプレートが Live View の中にある、または ID が見つからない。`insert` は無視されるべき（Task 2）。
- 送信中のフォームをもう一度送信する。`onSubmit` 全体を飛ばし、仮の行が二重に入らないべき（Task 2）。
- 確定した行が Action の応答より先に届く。仮の行はその時点で消え、行は 1 つだけ見えるべき（Task 2）。
- 送信中に、同じ一覧へ別のタブの追加などで Live View の更新が届く。仮の行は消えず、ほかの行に書き換えられないべき（Task 3 のブラウザテスト）。

---

### Task 1: ワイヤ形式、`insertTemplate`、フォームの `onSubmit`

**Files:**

- Modify: `src/protocol.ts`、`src/signal.ts`、`src/action.ts`、`src/index.ts`
- Test: `src/signal.test.ts`、`src/index.test.ts`、`src/evaluate.test.ts`（`isStmtNode` の検査）

**Interfaces:**

- Produces（`src/protocol.ts`）:
  - `StmtNode` に `["insert", string, Record<string, ExprNode>, ExprNode]` を足す（テンプレート ID、値、キー）。`isStmtNode` も対応する。
  - `signalAttributes` に `template: "data-hs-template"`、`insert: "data-hs-insert"`、`item: "data-hs-item"`、`itemKey: "data-hs-item-key"`、`pendingItem: "data-hs-pending-item"`、`confirms: "data-hs-confirms"`、`onSubmit: "data-hs-on-submit"` を足す。
- Produces（`src/signal.ts`、`src/index.ts` から export）:
  ```ts
  export interface InsertTemplate<Values extends SignalValues> {
    readonly id: string;
    readonly item: { readonly [K in keyof Values]: Expr<Values[K]> };
    template(): { "data-hs-template": string };
    slot(): { "data-hs-insert": string };
    insert(
      values: { [K in keyof Values]: Values[K] | Expr<Values[K]> },
      key: string | Expr<string>
    ): StmtNode;
    confirms(key: string): { "data-hs-confirms": string }; // JSON [id, key]
    bindText: SignalScope<Values>["bindText"]; // テンプレートの中で使う。サーバーは $item を initial で評価する
    bindShow: SignalScope<Values>["bindShow"];
    bindAttr: SignalScope<Values>["bindAttr"];
  }
  export function insertTemplate(
    initial,
    options?: { name?: Identifier<Name> }
  ): InsertTemplate<Widened<Values>>;
  ```
  型引数の並びは `signals()` と同じ形にする（`name` のリテラル検査と `Values` の推論を両立させる）。サーバー側の評価で、`$item` のパスはこのテンプレートの `initial` を返す。それ以外の `$` パスは今までどおり `false`。
- Produces（`src/action.ts`）: `form()` のオプションに `onSubmit?: Statements` を足し、`data-hs-on-submit` に `serializeStmts` の結果を入れる。

- [ ] **Step 1: 失敗するテストを書く**
  - `src/signal.test.ts` `defines insert templates`: `const t = insertTemplate({ title: "" }, { name: "new-todo" })` で、`t.template()` が `{ "data-hs-template": "new-todo-1" }`、`t.slot()` が `{ "data-hs-insert": "new-todo-1" }`、`t.item.title.node` が `["sig", ["$item", "title"]]`、`t.bindText(t.item.title).children` が `""`、`t.confirms("k1")` が `{ "data-hs-confirms": '["new-todo-1","k1"]' }`。
  - `serializes insert statements`: `t.insert({ title: s.title }, s.key)` が `["insert", "new-todo-1", { title: ["sig", [...]] }, ["sig", [...]]]`、`t.insert({ title: "x" }, "k")` は値を `lit` にする。`// @ts-expect-error The template has no field named "titel".` で `t.insert({ titel: "x" }, "k")`。`// @ts-expect-error A key is a string.` で `t.insert({ title: "x" }, 1)`。
  - `src/evaluate.test.ts`: `isStmtNode(["insert", "t", { a: ["lit", 1] }, ["lit", "k"]])` は `true`、キーのない `["insert", "t", {}]` と、値が式でない `["insert", "t", { a: 1 }, ["lit", "k"]]` は `false`。
  - `src/index.test.ts` `attaches submit statements to forms`: `add.form({ onSubmit: [s.flag.toggle()] })["data-hs-on-submit"]` が `'[["toggle",[...]]]'`、オプションがなければ属性はない。
- [ ] **Step 2:** `bun run test` で新しいテストが FAIL することを確かめる。
- [ ] **Step 3:** 上の Interfaces を実装する。
- [ ] **Step 4:** `bun run test` が PASS。check と build も通す。
- [ ] **Step 5:** コミットして push する（`Add insert templates and form submit statements`）。

### Task 2: ランタイムの仮の行

**Files:**

- Modify: `src/signal-runtime.ts`、`src/browser.ts`
- Test: `src/signal-runtime.test.ts`

**Interfaces:**

- Consumes: Task 1 の `insert` 文と属性、`form({ onSubmit })`。
- Produces（`SignalRuntime` に足す）:
  ```ts
  /** フォームの data-hs-on-submit を楽観的なスコープで実行し、束縛を同期的に反映してから FormData を作って送る。送信中のフォームでは何もせず { ok: false }。 */
  sendForm(form: HTMLFormElement, url: string, submitter: HTMLElement | null): Promise<SendResult>;
  /** Idiomorph の beforeNodeRemoved / beforeNodeMorphed で使う。仮の行（data-hs-item-key を持ち、まだ取り除かれていない要素）なら true。 */
  isPreview(node: Node): boolean;
  ```
  `applySnapshots(view)` は、今の処理に加えて、`view` の中の仮の行のうち、同じテンプレート ID とキーの `data-hs-confirms` を持つ要素が `view` にあるものを取り除く。
- 振る舞い:
  - `insert` の実行: `data-hs-template` の値が一致し、`[data-hs-view]` の中にない最初の `<template>` を探す。見つからなければ何もしない。値とキーを評価し、`template.content` の最初の要素を複製して、`data-hs-item`（値の JSON）、`data-hs-item-key`、`data-hs-pending-item` を付け、`data-hs-insert` が同じ ID の要素すべての最後の子に入れる。挿入先がなければ何もしない。
  - 束縛の評価で `["$item", field]` を読むときは、その要素から最も近い `[data-hs-item]` の JSON の `field` を返す。`$item` はアプリの文、入力欄、スナップショットからは書けない（今の `$` の規則のまま）。
  - 同じハンドラ（または `onSubmit`）で `call` / フォームの送信より前に入れた仮の行は、その送信が受け持つ。失敗したら取り除く。成功したら `data-hs-pending-item` を外し、その時点で対応する `data-hs-confirms` が同じ Live View にあれば取り除く。`call` を伴わない仮の行は、確定した行が届くまで残る。
  - `browser.ts`: Idiomorph の `beforeNodeRemoved` は `isPreview(node)` なら `false` を返す。`beforeNodeMorphed` は、元の要素が仮の行なら `false` を返す（ほかの行に書き換えさせない）。フォームの submit は `runtime.sendForm` を通す（`data-hs-reset-on-success` の処理は今のまま残す）。

- [ ] **Step 1: 失敗するテストを書く**（jsdom、HTML は Task 1 のビルダーと `jsx` で作る）
  - `inserts a preview from a template outside views and fills its bindings`
  - `ignores an insert whose template is missing or inside a Live View`（Review Focus 2）
  - `does nothing when no slot is on the page but still sends the call`（Review Focus 1）
  - `removes a preview when its call fails`
  - `removes a preview as soon as its confirmed row arrives, even while pending`（Review Focus 4）
  - `keeps a preview after success until its confirmed row arrives`
  - `runs submit statements and sends the bound values they wrote`（hidden の入力欄に束縛したキーが `FormData` に入る）
  - `skips submit statements while the form is pending`（Review Focus 3）
  - `reports previews for the morph callbacks`（`isPreview` が仮の行で `true`、取り除いたあとと普通の行で `false`）
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** `bun run test` と、既存の 21 件の `bun run test:browser` が通ることを確かめる。check と build も通す。
- [ ] **Step 5:** コミットして push する（`Insert optimistic previews from templates`）。

### Task 3: TodoMVC の追加と削除

**Files:**

- Modify: `examples/todomvc/server.tsx`、`examples/todomvc/todos.ts`（追加でキーを受け取る）、`examples/todomvc/style.css`
- Test: `browser-tests/todomvc.spec.ts`

**Interfaces:**

- Consumes: Task 1〜2 の公開 API。
- 置き換え:
  - `add-todo` の入力に `todoKey: v.pipe(v.string(), v.uuid())` を足し、`commit({ kind: "add", key: todoKey, title })` にする。同じキーの項目があれば `ActionError(409, ...)` を投げる。
  - `const newTodo = insertTemplate({ title: "" }, { name: "new-todo" })`。ページの本体（Live View の外）に `<template {...newTodo.template()}>` を置き、中に仮の行（タイトルは `newTodo.bindText(newTodo.item.title)`）を描く。
  - 一覧の `<ul>` に、フィルタが `all` か `active` のときだけ `{...newTodo.slot()}` を付ける。一覧が空のときも挿入先が描かれるようにする。
  - 確定した行の `<li>` に `{...newTodo.confirms(todo.key)}` を付ける。
  - 追加フォーム: `const composer = signals({ title: "", key: "" }, { name: "composer" })`。`add.form({ resetOnSuccess: true, onSubmit: [c.key.set(uuid()), newTodo.insert({ title: c.title }, c.key)] })`。hidden の `name={add.field("todoKey")}` と `c.bindValue(c.key)`、タイトルの入力に `c.bindValue(c.title)`。
  - 削除: 行の Signal を `signalFamily({ completed: false, removed: false })` にし、`<li>` に `r.bindShow(r.removed.not())`、削除ボタンを `on.click([r.removed.set(true), remove.call({ todoKey: todo.key })])` にする。
  - `style.css`: `[data-hs-pending-item]` を薄く表示する。`li[hidden]` が確実に隠れるようにする。

- [ ] **Step 1: 失敗するテストを書く**（`browser-tests/todomvc.spec.ts`、応答の遅延は 1500 ms、途中の確認のタイムアウトは 1000 ms）
  - `adds a task before the server answers`: `add-todo` を遅らせ、送信直後に新しいタイトルの行が見え、`data-hs-pending-item` を持つ。応答のあと、その行は 1 つだけ残り、`data-hs-pending-item` を持たない。送信したリクエストの本文に UUID 形式の `todoKey` がある。
  - `removes a preview the server rejects`: `add-todo` を遅らせて 500 で応答させ、途中で行が見え、応答のあと消える。
  - `hides a deleted task before the server answers and restores it on failure`: `remove-todo` を遅らせ、途中で行が見えなくなる。500 で応答させた場合は行が戻る。
  - `keeps the preview while another update arrives`（Review Focus 5）: `add-todo` を遅らせている間に、別のコンテキストから別の項目を追加し、その更新が届いても仮の行が元のタイトルのまま残る。
  - `does not insert on the completed filter`: Completed のページで追加しても仮の行が入らない。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 置き換えを書く。
- [ ] **Step 4:** `bun run test:browser` 全体と、check、test が通ることを確かめる。
- [ ] **Step 5:** コミットして push する（`Add and delete TodoMVC tasks optimistically`）。

### Task 4: ドキュメント

**Files:**

- Modify: `site/content/{en,ja}/reference.html`（Signals の節に `insertTemplate`、`slot`、`insert`、`confirms`、`onSubmit`、挿入先の置き方の責任、削除の書き方）、`site/content/{en,ja}/limits.html`（「設計上の制約」の 1 点目を、仮の行で追加を表示できること、並べ替えや編集はできないことに書き換える）、`docs/architecture.md`（仮の行の節と、ランタイムの増分）

- [ ] **Step 1:** `dist/runtime.js` の minify 後と `gzip -9` 後の大きさを、この計画を追加したコミット（`Plan optimistic list inserts`）と HEAD で測る。古い方は scratchpad の一時的な `git worktree` でビルドし、終わったら消す。
- [ ] **Step 2:** 上の 3 つのファイルを書く。英語と日本語で内容を揃える。
- [ ] **Step 3:** `mise exec -- node site/build.ts`、format:fix、check、test、build、test:browser を通す。
- [ ] **Step 4:** コミットして push する（`Document optimistic list inserts`）。
