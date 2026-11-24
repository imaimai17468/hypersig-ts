# カスタム要素 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** カスタム要素を型付きで一度だけ宣言し、属性を Signal と結び、カスタムイベントで文を実行し、Live View の中でも JS が描いた中身を残せるようにする。

**Architecture:** ワイヤ形式に `["detail"]` 式と `data-hs-on-custom`、`data-hs-owns-children` を足す（`src/protocol.ts`）。サーバー側は `customElement`（`src/element.ts`、Hono JSX の `Element` コンポーネントを含む）と Signal のスコープの `bindElement`（`src/signal.ts`）。ブラウザ側は、カスタム要素の属性束縛とイベントのリスナー（`src/signal-runtime.ts`）、受信した断片の無害化（`src/sanitize.ts` に切り出す）、中身を残す morph（`src/browser.ts`）。

**Tech Stack:** TypeScript 7、Hono JSX、DOMPurify 3.4.18、Idiomorph 0.8.0、vitest（jsdom）、Playwright

**Spec:** `docs/superpowers/specs/2026-11-24-custom-elements-design.md`

## Global Constraints

- カスタム要素の名前: 小文字の英字で始まり、`-` を含み、小文字の英数字・`-`・`.`・`_` だけ。イベント名: 小文字の英字で始まり、小文字の英数字・`-`・`.`・`:`・`_` だけ。どちらもリテラルの型で検査する。
- 属性値の型は `string | number | boolean`、`detail` の型は `JsonValue`。
- カスタム要素（`localName` に `-` を含む要素）にだけ、`on` で始まらず、`style` でなく、`data-hs-` で始まらない小文字の属性名の束縛を許す。普通の要素の許可リストは変えない。
- DOMPurify の `FORBID_TAGS: ["style", "template"]` と `FORBID_ATTR: ["data-hs-stream", "style"]` は変えない。`allowCustomizedBuiltInElements` は `false`。
- `src/core.ts` は Hono に依存しないので、`customElement` は `src/index.ts` からだけ export する。
- 各タスクの終わりに `bun run format:fix`、`bun run check`、`bun run test`、`bun run build` を通す。ランタイムや例を変えたら `bun run test:browser` も通す。通ったら `git push origin main`。

## Review Focus

- 受信した断片の中のカスタム要素に `onclick`、`style`、`data-hs-stream` がある。取り除かれるべき（Task 2）。
- 普通の要素（`<div>`）の `data-hs-attr` に `value` などの許可外の属性がある。書かれないべき（Task 2）。
- 泡立たないカスタムイベント。要素に直接付けたリスナーで文が実行されるべき（Task 2）。
- `detail` が JSON にできない値（関数など）。`null` として扱われるべき（Task 2）。
- 中身を JS が描く要素で、サーバーの HTML の属性が変わる。属性は新しい値に、中身はそのままになるべき。`id` が変わったら作り直されるべき（Task 2）。

---

### Task 1: 宣言、描画、束縛

**Files:**

- Modify: `src/protocol.ts`、`src/signal.ts`、`src/index.ts`
- Create: `src/element.ts`
- Test: `src/element.test.ts`（JSX を使うなら `jsx` を `hono/jsx/jsx-runtime` から呼ぶ。テストファイルは `.ts`）、`src/evaluate.test.ts`

**Interfaces:**

- Produces（`src/protocol.ts`）: `ExprNode` に `["detail"]`、`isExprNode` と評価器の `EvaluationContext.detail?: JsonValue`（`["detail"]` はその値、なければ `null`）。属性名 `onCustom: "data-hs-on-custom"`、`ownsChildren: "data-hs-owns-children"`。`export function isCustomElementName(name: string): boolean`、`export function isBindableCustomAttribute(name: string): boolean`（`on` 始まり・`style`・`data-hs-` 始まり・大文字を含むものを拒む）。
- Produces（`src/element.ts`）:
  ```ts
  export interface CustomElementSpec {
    attributes: Record<string, string | number | boolean>;
    events: Record<string, JsonValue>;
  }
  export interface CustomElement<Spec extends CustomElementSpec> {
    readonly tag: string;
    readonly ownsChildren: boolean;
    Element: (
      props: ElementProps<Spec>
    ) => HtmlEscapedString | Promise<HtmlEscapedString>;
    on<Name extends keyof Spec["events"] & string>(
      event: Name,
      handler: (
        detail: Expr<Spec["events"][Name]>
      ) => StmtNode | readonly StmtNode[]
    ): { "data-hs-on-custom": string };
  }
  export function customElement<Spec extends CustomElementSpec>(
    tag: CustomTagName,
    options?: { ownsChildren?: boolean }
  ): CustomElement<Spec>;
  ```
  `CustomTagName` と イベント名の型でリテラルを検査する（既存の `Identifier` 型と同じ作り方）。`ElementProps<Spec>` は、Hono JSX の普通の HTML 属性、`Partial<Spec["attributes"]>`、任意の `data-*`、`children` を受け付ける。`on()` を同じ要素で複数回使ったときは、展開すると後勝ちになるので、`on()` は複数のイベントを受け取れる形（`rating.on({ rate: (d) => ..., change: (d) => ... })` のオーバーロード）も用意し、JSON は `[[name, stmts], ...]` にする。
- Produces（`src/signal.ts`）: `SignalScope` に `bindElement<Spec>(element: CustomElement<Spec>, values: { [K in keyof Spec["attributes"]]?: Spec["attributes"][K] | Expr<Spec["attributes"][K]> }): Record<string, string | true> & { "data-hs-attr": string }`。サーバーでの評価は `bindAttr` と同じ（真偽値は真なら `true`、偽なら属性なし、それ以外は文字列）。`src/signal.ts` が `src/element.ts` を import すると循環するなら、`bindElement` の引数は `{ readonly tag: string }` を満たす型パラメータで受ける。

- [ ] **Step 1: 失敗するテストを書く**
  - `declares a custom element and renders its tag`: `customElement<{ attributes: { value: number; max: number }; events: { rate: number } }>("star-rating", { ownsChildren: true })` の `Element({ id: "r", max: 5 })` を文字列にすると `<star-rating id="r" max="5" data-hs-owns-children="">` を含む。
  - `binds declared attributes from a scope`: `signals({ score: 3 })` のスコープで `bindElement(rating, { value: e.score, max: 5 })` が `{ value: "3", max: "5", "data-hs-attr": '{"value":["sig",[...]],"max":["lit",5]}' }`。
  - `serializes custom event handlers`: `rating.on("rate", (d) => e.score.set(d))` が `{ "data-hs-on-custom": '[["rate",[["set",[...],["detail"]]]]]' }`。複数イベントの形も同様。
  - 型: `// @ts-expect-error A custom element name needs a hyphen.` で `customElement("rating")`。`// @ts-expect-error The element declares no attribute "size".` で `bindElement(rating, { size: 1 })`。`// @ts-expect-error The value attribute is a number.` で `bindElement(rating, { value: "x" })`。`// @ts-expect-error The element dispatches no "change" event.` で `rating.on("change", ...)`。
  - `src/evaluate.test.ts`: `["detail"]` が `context.detail` を返し、なければ `null`。`isExprNode(["detail"])` は `true`。`isCustomElementName` / `isBindableCustomAttribute` の正例と負例（`onrate`、`style`、`data-hs-x`、`Value` は不可、`value`、`max`、`aria-label` は可）。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** PASS、check、build。
- [ ] **Step 5:** コミットして push する（`Declare custom elements and bind their attributes`）。

### Task 2: ブラウザのランタイム

**Files:**

- Modify: `src/signal-runtime.ts`、`src/browser.ts`
- Create: `src/sanitize.ts`（`browser.ts` の DOMPurify 呼び出しを切り出す）
- Test: `src/signal-runtime.test.ts`、`src/sanitize.test.ts`

**Interfaces:**

- Consumes: Task 1 の `["detail"]`、属性名、`isCustomElementName`、`isBindableCustomAttribute`。
- Produces: `src/sanitize.ts` の `export function sanitizeFragment(html: string): DocumentFragment`（今の設定に `CUSTOM_ELEMENT_HANDLING: { tagNameCheck: (name) => isCustomElementName(name), attributeNameCheck: (name) => isBindableCustomAttribute(name), allowCustomizedBuiltInElements: false }` を足す）。`SignalRuntime` に、morph のコールバックから使う `keepsChildren(previous: Element, next: Element): boolean` を足す（両方が `data-hs-owns-children` を持ち、同じタグ名で、`id` が一致するとき `true`）。
- 振る舞い:
  - `data-hs-attr` の各キー: 今の `isBindableAttribute` か、要素がカスタム要素で `isBindableCustomAttribute` を満たすときだけ書く。
  - 描画のたびに `data-hs-on-custom` を持つ要素を探し、まだリスナーを付けていなければ、宣言のイベント名ごとに `addEventListener` で直接付ける（`WeakSet` で二重を防ぐ。属性の JSON が変わったら、付けたリスナーは最新の JSON を読み直して実行する）。イベントでは `detail` を `isJsonValue` で検査し、通らなければ `null` として文を実行する。
  - `browser.ts`: `beforeNodeMorphed(previous, next)` で `runtime.keepsChildren(previous, next)` なら、`next` の属性を `previous` に写し（`next` にない属性は消す。`data-hs-pending` は送信中なら残す）、`false` を返す。両方が `data-hs-owns-children` を持ち `id` が一致しないときは、`previous.replaceWith(next の複製)` で置き換えて `false` を返す。

- [ ] **Step 1: 失敗するテストを書く**
  - `src/sanitize.test.ts`: `<star-rating value="3" onclick="x()" style="color:red" data-hs-stream="/s" data-hs-on-custom="[]"></star-rating>` が、`star-rating` と `value` と `data-hs-on-custom` を残し、`onclick`、`style`、`data-hs-stream` を取り除く。`<div is="x-y">` は customized built-in として通らない（`is` 属性が消える）。普通の `<script>` と `<template>` は今までどおり消える。（Review Focus 1）
  - `src/signal-runtime.test.ts`:
    - `binds declared attributes on custom elements only`: カスタム要素の `value` は書かれ、`<div>` に手で置いた `data-hs-attr='{"value":...}'` は書かれない。カスタム要素でも `onrate` と `style` は書かれない。（Review Focus 2）
    - `runs statements for a non-bubbling custom event with its detail`: `new CustomEvent("rate", { detail: 4, bubbles: false })` を要素に `dispatchEvent` すると Signal が 4 になる。（Review Focus 3）
    - `uses null for a detail that is not JSON`: `detail: () => 1` で `null` が書かれる。（Review Focus 4）
    - `attaches listeners to custom elements added later`: 描画のあとに追加した要素のイベントも動く。同じ要素で二重に実行されない。
    - `keeps children only for matching owned elements`: `keepsChildren` が、両方に印があり同じタグ名・同じ `id` のときだけ `true`。
  - `src/signal-runtime.test.ts` か `src/browser` の結合（jsdom と実際の Idiomorph）: 中身を自分で描いたカスタム要素を含むビューを、属性が違う新しい HTML で morph すると、属性は新しくなり中身は残る。`id` が違えば中身は作り直される。（Review Focus 5）
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** test と既存の test:browser、check、build。
- [ ] **Step 5:** コミットして push する（`Run custom element bindings and keep their children`）。

### Task 3: 星の評価の例

**Files:**

- Create: `examples/rating/server.tsx`、`examples/rating/rating.js`、`browser-tests/rating.spec.ts`
- Modify: `package.json`（`example:rating`）、`playwright.config.ts`（rating のプロジェクトと webServer、ほかと被らないポート）

**Interfaces:**

- Consumes: Task 1〜2 の公開 API。
- 例の中身: `rating.js` は `customElements.define("star-rating", ...)`。light DOM に `max` 個のボタンを描き、押すと `rate`（`detail` は 1 からの数値、`bubbles: false`）を出す。`value` 属性の変化を `attributeChangedCallback` で受けて、押された状態を描き直す。`server.tsx` は Counter と同じセッションの作りで、評価の一覧をメモリに持ち、平均と件数を表示する Live View の中に `<rating.Element id="rating" ...>` を置く。`const vote = signals({ score: 0 }, { name: "vote" })`、押したら `[v.score.set(d), save.call({ score: d })]`。「クリア」ボタンは `v.score.set(0)` だけ。スクリプトは `links["rating.js"].$path()` で読み込む。

- [ ] **Step 1: 失敗するテストを書く**（`browser-tests/rating.spec.ts`）
  - `rates with the custom element and reflects the signal back`: 3 番目の星を押すと、要素の `value` 属性が `3` になり、3 つの星が押された状態になる。「クリア」で `value` が `0` になり、星が戻る。
  - `keeps the element and its children across Live View updates`: 星の要素の中の最初のボタンに印（`data-test-marker`）を JS で付けておき、別のコンテキストで評価を保存する。平均の表示が更新されても、要素が同じノードのまま（`evaluate` で保持した参照が `isConnected`）で、印も残っている。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 例を書く。
- [ ] **Step 4:** test:browser 全体、check、test。
- [ ] **Step 5:** コミットして push する（`Add a star rating example built on a custom element`）。

### Task 4: ドキュメント

**Files:**

- Modify: `site/content/{en,ja}/reference.html`（カスタム要素の節: 宣言、`Element`、`bindElement`、`on`、`ownsChildren`、一覧では `id` を付けること、検査できないこと、スクリプトの読み込み方）、`site/content/{en,ja}/limits.html`（「設計上の制約」の JS ライブラリの項目を、カスタム要素で包む方法に書き換える）、`README.md`（サンプルの表に rating）、`docs/architecture.md`（カスタム要素の節とランタイムの増分）、`AGENTS.md`（Thesis の一覧に「カスタム要素のタグ名・属性名・イベント名」）

- [ ] **Step 1:** `dist/runtime.js` の minify 後と `gzip -9` 後を、この計画を追加したコミット（`Plan custom elements`）と HEAD で測る（scratchpad の一時的な `git worktree`、終わったら消す）。
- [ ] **Step 2:** 書く。英語と日本語で内容を揃える。
- [ ] **Step 3:** site build、format:fix、check、test、build、test:browser。
- [ ] **Step 4:** コミットして push する（`Document custom elements`）。
