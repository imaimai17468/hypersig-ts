# カスタム要素の型付きブラウザ実装とアイランド 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** カスタム要素の宣言を実行時の値にしてサーバーとブラウザで共有し、`defineElement` と React アダプターでブラウザ側の実装も型で縛る。

**Architecture:** Hono に依存しない `src/element.ts` が宣言（タグ、属性の型、イベント、`on`）を持ち、新しい入口 `hypersig.ts/element` から出す。サーバーの描画は `hypersig.ts` の `CustomTag` コンポーネントが宣言を受け取って行う。ブラウザ側は `defineElement` が宣言から `observedAttributes` と `props` の変換を作り、`hypersig.ts/react` の `reactElement` がその上で React の root を管理する。JSON の属性は、宣言の型が `json` の属性だけを JSON で書き、ランタイムにはその名前の一覧を `data-hs-element-json` で伝える。

**Tech Stack:** TypeScript 7、Hono JSX（サーバー）、Web Components、React 19 と react-dom（任意の依存）、dnd-kit（サンプルのみ）、Vitest + jsdom、Playwright、`bun build`

**Spec:** `docs/superpowers/specs/2026-11-24-element-islands-design.md`

## Global Constraints

- `hypersig.ts/element` は Hono も React も import しない。DOM のない Node で import しても例外を出さない（`HTMLElement` を参照するクラスは `defineElement` の呼び出し時に作る）。
- `react` と `react-dom` は optional の peerDependency。`hypersig.ts` と `hypersig.ts/element` は React を import しない。
- 属性の型は `"string"`、`"number"`、`"boolean"`、`"json"` の 4 つ。`json<T extends JsonValue>()`、`event<Detail extends JsonValue>()`。
- 属性名・イベント名・タグ名の規則は今の `src/protocol.ts` / `src/identifier.ts` の規則をそのまま使う。
- `ownsChildren: true` の宣言を描くときは `id` が必須（型）。
- 新しい属性名 `data-hs-element-json` は `src/protocol.ts` の `customElementAttributes.elementJson` で一度だけ定義する。
- 旧 `customElement<Spec>(tag, options)` は残さない。
- 依存の版は、追加する時点で公開から 2 週間以上たった版に固定する（`^` を付けない）。
- 仕上げに `bun run format:fix`、`bun run check`、`bun run test`、`bun run build`。ブラウザに関わるタスクは `bun run test:browser`。

## Review Focus

1. **JSON の値が文字列や `null` のとき**：`formatText` は文字列をそのまま、`null` を空文字列にするので、JSON の属性に使うと読み戻せない。JSON の属性は常に `JSON.stringify` で書き、`"abc"` が `"\"abc\""`、`null` が `"null"` になること（Task 1 にテストを置く）。
2. **同じタスクの中での複数の属性の変更**：Live View の morph が `items` と `failures` を同時に変えたとき、`update` が 1 回だけ、両方の新しい値で呼ばれること（Task 2 にテストを置く）。
3. **切り離してすぐ挿し直す**：`disconnectedCallback` → `connectedCallback` が同じタスクで起きたとき（DOM の並べ替え）、`unmount` と `mount` が順に呼ばれ、二重に mount されないこと（Task 2 にテストを置く）。
4. **サーバーでの import**：サンプルの `elements.ts` をサーバーが import しても、`defineElement` を呼ばない限り DOM に触れないこと（Task 1 で `build` の import 確認を足す）。
5. **ドラッグ中に別のタブの更新が届く**：ドロップまで新しい並びを反映せず、ドロップ後に確定した並びに置き換わること（Task 4 のブラウザテスト）。

---

### Task 1: 宣言を値にし、サーバーの描画と JSON の属性を対応させる

**Files:**

- Create: `src/element.ts`（宣言。Hono を import しない）
- Create: `src/custom-tag.tsx`（`CustomTag` コンポーネント。Hono JSX）
- Delete: `src/element.tsx`（中身を上の 2 つに分ける）
- Modify: `src/protocol.ts`（`customElementAttributes.elementJson`）
- Modify: `src/signal.ts`（`bindElement` が宣言を受け取り、JSON の属性を JSON で書く）
- Modify: `src/signal-runtime.ts`（`renderElementAttributes` が `data-hs-element-json` の名前を JSON で書く）
- Modify: `src/sanitize.ts`（必要なら `data-hs-element-json` を残す）
- Modify: `src/index.ts`（`customElement`、`event`、`json`、`CustomTag` と型を export）
- Modify: `package.json`（`exports["./element"]`、`build` の import 確認に `hypersig.ts/element`）
- Modify: `examples/rating/server.tsx`（新しい宣言と `CustomTag`。宣言は `examples/rating/elements.ts` に移す）
- Modify: `site/content/{ja,en}/reference.html` のコード例（文章の書き直しは Task 5）
- Test: `src/element.test.ts`、`src/signal-runtime.test.ts`、`src/index.test.ts`

**Interfaces:**

- Produces（`src/element.ts`、`hypersig.ts/element` と `hypersig.ts` から export）:
  - `type AttributeKind = "string" | "number" | "boolean" | "json"`
  - `json<T extends JsonValue = JsonValue>(): JsonAttribute<T>`、`event<Detail extends JsonValue = null>(): EventSpec<Detail>`
  - `customElement<const Tag extends string, const Attributes extends Record<string, AttributeKind | JsonAttribute<JsonValue>>, const Events extends Record<string, EventSpec<JsonValue>>, const Owns extends boolean = false>(tag: CheckedTag<Tag, Attributes, Events>, options?: { attributes?: Attributes; events?: Events; ownsChildren?: Owns }): CustomElement<Tag, Attributes, Events, Owns>`
  - `CustomElement` は `tag`、`ownsChildren`、`attributes`（名前 → kind の実行時の表）、`events`（名前の一覧）と、今と同じ `on(event, handler)` / `on(handlers)` を持つ。
  - `type AttributeValues<E>`（kind から値の型：`string` / `number` / `boolean` / `T`）、`type EventDetail<E, Name>`
- Produces（`src/custom-tag.tsx`、`hypersig.ts` から export）:
  - `CustomTag<E>(props: { of: E } & TagProps<E>)`：`TagProps` は今の `ElementProps` に相当し、宣言の属性を固定値で受け取る。`E` が `ownsChildren: true` なら `id: string` が必須。
- Produces（`src/signal.ts`）: `scope.bindElement(declaration, values)`（引数の型は新しい `CustomElement`）

- [ ] **Step 1: テストを書く**
      `src/element.test.ts` を新しい API に書き換え、次を足す。
  - `customElement("star-rating", { attributes: { value: "number" }, events: { rate: event<number>() }, ownsChildren: true })` の `tag`、`attributes`、`events` の実行時の値。
  - `<CustomTag of={rating} id="r" value={3} />` が `<star-rating value="3" id="r" data-hs-owns-children="">` を描く。`id` を省くと型エラー（`// @ts-expect-error ownsChildren elements need an id`）。
  - JSON の属性：`list = customElement("todo-list", { attributes: { items: json<string[]>(), label: json<string>(), empty: json<null>() } })` を `CustomTag` で描くと `items="[&quot;a&quot;]"`、`label="&quot;abc&quot;"`、`empty="null"`（Review Focus 1）。`bindElement(list, { items: e.items })` も同じ文字列を描き、`data-hs-element-json` に `["items"]` を書く。
  - 宣言にない属性やイベント、規則に反する名前は、今と同じ型エラーと実行時の例外。
    `src/signal-runtime.test.ts`：`data-hs-element-json` に名前のある束縛は、ランタイムが `JSON.stringify` した値を書く。同じ文字列なら書き直さない（`attributeChangedCallback` が呼ばれない）。
    `src/index.test.ts`：`hypersig.ts/element` の公開する名前の一覧。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/element.test.ts src/signal-runtime.test.ts`
      Expected: FAIL（新しい API が未実装）

- [ ] **Step 3: 実装する**
      `src/element.ts` は今の `on` の直列化（`serializeHandlers`）と名前の検査を持つ。`src/custom-tag.tsx` は今の `renderBooleanProps` と JSON の属性の書き分けを持つ。JSON の属性の書き方（常に `JSON.stringify`）は `src/protocol.ts` に関数として置き、`CustomTag`、`bindElement`、ランタイムで共有する。

- [ ] **Step 4: サーバーで import できることを確かめる**
      `package.json` の `build` の最後の `node -e` に `await import("hypersig.ts/element")` を足す。
      Run: `bun run build`
      Expected: 成功

- [ ] **Step 5: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run test:browser`
      Expected: PASS（星評価のブラウザテストは今の `rating.js` のまま通る）

- [ ] **Step 6: Commit**
      `git commit -m "Declare custom elements as values shared by server and browser"`

### Task 2: `defineElement` と星評価の書き直し

**Files:**

- Create: `src/define-element.ts`（`hypersig.ts/element` から export）
- Modify: `src/element.ts`（`defineElement` の再 export）
- Delete: `examples/rating/rating.js`
- Create: `examples/rating/rating.ts`（`defineElement` で書く）
- Modify: `examples/rating/server.tsx`（`bun build` した `rating.js` を配る）、`package.json`（`example:rating` でブラウザ用ファイルを作る）、`playwright.config.ts`（webServer のコマンドで同じビルドを通す）
- Test: `src/define-element.test.ts`

**Interfaces:**

- Consumes: Task 1 の `CustomElement`、`AttributeValues`、`EventDetail`、属性の kind の表
- Produces:
  - `defineElement<E extends CustomElement<...>>(declaration: E, implementation: { mount(host: HTMLElement, props: Partial<AttributeValues<E>>, emit: Emit<E>): { update(props: Partial<AttributeValues<E>>): void; unmount(): void } }): void`
  - `type Emit<E> = <Name extends EventName<E>>(name: Name, detail: EventDetail<E, Name>) => void`

- [ ] **Step 1: テストを書く**（`src/define-element.test.ts`、jsdom）
  - `defineElement` を呼ぶと宣言のタグが登録され、二度目は `Custom element "<tag>" is already defined` を投げる。
  - 挿入で `mount` が宣言の型に変換した `props` で呼ばれる（`value="3"` → `3`、`flag=""` → `true`、属性なし → `undefined`、`value="x"` → `undefined`、壊れた JSON → `undefined`）。
  - 同じタスクで 2 つの属性を変えると、マイクロタスクのあとに `update` が 1 回、両方の新しい値で呼ばれる（Review Focus 2）。
  - 切り離しで `unmount`、挿し直しで `mount`。同じタスクで切り離して挿し直すと `unmount` → `mount` の順で 1 回ずつ（Review Focus 3）。
  - `emit("rate", 2)` が `bubbles: false`、`detail: 2` の `CustomEvent` を発火する。
  - 型テスト：宣言にないイベント名、違う型の `detail` は型エラー。
  - `import("../src/element.js")` を DOM のない環境で読んでも例外にならないことは Task 1 の build の確認で担保する。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/define-element.test.ts`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      クラスは `defineElement` の中で `class extends HTMLElement` として作る。`observedAttributes` は宣言の属性名。変換は kind の表で行う。

- [ ] **Step 4: 星評価を書き直す**
      `rating.ts` は `defineElement(rating, { mount(host, props, emit) { … } })` で、タグ名・属性名・イベント名を書かない。ビルドは `bun build examples/rating/rating.ts --target=browser --outfile=examples/rating/dist/rating.js`（出力先は git に入れない）。

- [ ] **Step 5: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run build && bun run test:browser`
      Expected: PASS（`browser-tests/rating.spec.ts` は変更なしで通る）

- [ ] **Step 6: Commit**
      `git commit -m "Implement custom elements in the browser from their declaration"`

### Task 3: React アダプター

**Files:**

- Create: `src/react.tsx`（`/** @jsxImportSource react */`）
- Modify: `package.json`（`exports["./react"]`、`peerDependencies` に `react` と `react-dom`、`peerDependenciesMeta` で optional、devDependencies に `react`、`react-dom`、`@types/react`、`@types/react-dom`）、`tsconfig.json` の `types` は変えない
- Test: `src/react.test.tsx`

**Interfaces:**

- Consumes: Task 2 の `defineElement`、`Emit`、`AttributeValues`
- Produces: `reactElement<E extends CustomElement<string, any, any, true>>(declaration: E, Component: ComponentType<Partial<AttributeValues<E>> & { emit: Emit<E> }>): void`（`any` は使わず、`ownsChildren: true` を型で要求する形にする）

- [ ] **Step 1: テストを書く**（jsdom、React 19）
  - 挿入で部品が描かれ、`items` の属性を変えると同じ root で描き直される（部品の `useState` の値が残る）。
  - 切り離しで `root.unmount()`（部品の effect の cleanup が走る）。
  - `emit` で発火したイベントを要素のリスナーが受ける。
  - 型テスト：`ownsChildren: false` の宣言は型エラー、部品の props が宣言と合わないと型エラー。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/react.test.tsx`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      `mount` で `createRoot(host)` → `root.render(<Component {...props} emit={emit} />)`、`update` で同じ `render`、`unmount` で `root.unmount()`。React の描画の終わりを待つ必要があるテストは `act` を使う。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run build`
      Expected: PASS。`build` の import 確認で `hypersig.ts` と `hypersig.ts/element` が React を読まないこと（`dist/index.js` と `dist/element.js` に `react` の import がないことを grep で確かめる）。

- [ ] **Step 5: Commit**
      `git commit -m "Mount React components as typed custom elements"`

### Task 4: 並べ替えできる一覧のサンプル

**Files:**

- Create: `examples/sortable/elements.ts`（`sortableList` の宣言：`attributes: { items: json<Item[]>(), failures: "number" }`、`events: { reorder: event<string[]>() }`、`ownsChildren: true`）
- Create: `examples/sortable/list.tsx`（React + dnd-kit の部品、`reactElement` で登録。`/** @jsxImportSource react */`）
- Create: `examples/sortable/server.tsx`（Live View、Action `reorder-items`、Topic、`CustomTag`）
- Create: `examples/sortable/style.css`
- Modify: `package.json`（devDependencies に `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`example:sortable`）、`playwright.config.ts`（`sortable` プロジェクト、ポート 3225）、`README.md` のサンプルの表
- Test: `browser-tests/sortable.spec.ts`

**Interfaces:**

- Consumes: Task 1 の `customElement`、`json`、`event`、`CustomTag`、`bindElement`。Task 3 の `reactElement`。

- [ ] **Step 1: ブラウザテストを書く**
  - マウスで 1 行目を 3 行目へドラッグすると、ドロップ直後に新しい順が薄く表示され（`data-pending` などサンプルが決める印）、確定後に印が消える。別のタブにも新しい順で届く。
  - キーボード（Space で持ち上げ、矢印で移動、Space で置く）でも同じ。
  - Action を失敗させる（サンプルに失敗させる仕掛けを置く。例：特定の並びを拒否する）と、サーバーの並びに戻る。
  - ドラッグ中に別のタブで並べ替えが確定しても、ドラッグは続き、ドロップ後に確定した並びになる（Review Focus 5）。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test:browser --project sortable`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      部品は `items` を元に手元の並びを持ち、ドラッグ中は新しい `items` を保留する。ドロップで `emit("reorder", keys)`、処理中の印を付ける。`items` が変わったら手元の並びを捨てて印を消す。`failures` が変わったら手元の並びを捨てる。サーバー側は `sortableList.on("reorder", (keys) => [reorder.call({ keys }, { onError: [failures.set(failures.add(1))] })])` の形で書く（実際の `call` の書き方は今の API に合わせる）。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run build && bun run test:browser`（2 回以上）
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Add a sortable list example built from a React island"`

### Task 5: ドキュメント

**Files:**

- Modify: `docs/architecture.md`（「カスタム要素」の節、「確定してから表示する」への区別の追記、「ランタイムの大きさ」の表に JSON の属性の増分）
- Modify: `site/content/{ja,en}/reference.html`、`concepts.html`、`limits.html`
- Modify: `README.md`（入口の説明に `hypersig.ts/element` と `hypersig.ts/react`）

- [ ] **Step 1: 書く**
      設計書の「ドキュメント」の節のとおり。`defineElement` を使えば型で突き合わせ、素の `customElements.define` の要素は突き合わせない。アイランドは SSR せず、Shadow DOM を使わない。`ownsChildren` の要素には `id` が要る。JSON の属性を使うときは更新境界を小さくする。英語版と日本語版で同じ内容にする。ランタイムの大きさは今の表と同じ測り方（`bun build src/browser.ts --target=browser --minify`、gzip -9）で、この計画の最初のコミットの親と現在を比べる。

- [ ] **Step 2: 確かめる**
      Run: `bun run format:fix && bun run check`
      Expected: PASS

- [ ] **Step 3: Commit**
      `git commit -m "Document typed custom elements and React islands"`
