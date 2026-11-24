# Signal の命令の追加 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** キー操作、フォーカスの出入り、キー付き ref、文字列・数・配列の式、名前付きタイマー、束縛できる属性を足し、5 つの部品をカスタム要素なしで書けるようにする。

**Architecture:** 新しい式と文は `src/protocol.ts` の `ExprNode` / `StmtNode` に足し、`src/evaluate.ts`（サーバーとブラウザで共通）と `src/signal-runtime.ts` が解釈する。アプリ向けの書き方は `src/signal.ts`（`Expr` のメソッド、`on`、`refs`、`timer`）が作る。新しいイベントはランタイムが document で委譲して受ける。

**Tech Stack:** TypeScript 7、Hono JSX、Vitest + jsdom（偽のタイマー）、Playwright、Bun

**Spec:** `docs/superpowers/specs/2026-11-24-signal-primitives-design.md`

## Global Constraints

- 属性名、イベント名は `src/protocol.ts` で一度だけ定義する（`eventAttributes`、`signalAttributes`）。
- 新しい式はサーバーとブラウザの `evaluate` で同じ結果になり、例外を投げない。
- `eval` / `new Function` を使わない。CSP は `script-src 'self'` のまま。
- 名前（`timer`、`refs`）は `Identifier` で検査し、ID は `assignId` で振る。
- 子を自分で描くカスタム要素の中（`isOwnedChild`）の新しいハンドラーは無視する。
- `keydown`、`focusEnter`、`focusLeave` は、その要素で送信が進行中なら文を実行しない。タイマーの文は送信中でも実行する。
- ランタイムの増分は gzip -9 で 4 KB 以下（基準は `93a68e5`）。超えたら `focusEnter`、`lower()` の順に削る。
- `any` と lint の無効化コメントを使わない。
- 仕上げに `bun run format:fix`、`bun run check`、`bun run test`、`bun run build`。ブラウザに関わるタスクは `bun run test:browser`。

## Review Focus

1. **修飾キーの完全一致**：`Enter` の対応表が `Shift+Enter` や `Control+Enter` で走らないこと、`Shift+Tab` が `Tab` で走らないこと（Task 3 にテスト）。
2. **`focusLeave` とマウス**：中の `tabindex="-1"` の要素をマウスで押したときに走らないこと（Task 3 の jsdom テストと Task 5 のブラウザテスト）。
3. **タイマーと Live View の更新**：予約した要素が morph で作り直されても文が走ること（Task 4 にテスト）。
4. **`mod` の負の数**：`(-1).mod(3)` が `2` になること（Task 1 にテスト）。
5. **型の合わない値**：`length()` に数が届く、`at()` に配列でない値が届くなど、ストアの値が想定と違っても例外にならず決まった値になること（Task 1 にテスト）。

---

### Task 1: 文字列・数・配列の式

**Files:**

- Modify: `src/protocol.ts`（`ExprNode` に `["length", E]`、`["trim", E]`、`["lower", E]`、`["includes", E, E]`、`["clamp", E, E, E]`、`["mod", E, E]`、`["at", E, E, E]`）
- Modify: `src/evaluate.ts`、`src/signal.ts`（`StringMethods`、`NumberMethods`、新しい `ArrayMethods`）
- Test: `src/evaluate.test.ts`、`src/signal.test.ts`

**Interfaces:**

- Produces: `Expr<string>` に `length(): Expr<number>`、`trim(): Expr<string>`、`lower(): Expr<string>`、`includes(other: string | Expr<string>): Expr<boolean>`。`Expr<number>` に `clamp(min: number | Expr<number>, max: number | Expr<number>): Expr<number>`、`mod(n: number | Expr<number>): Expr<number>`。`Expr<readonly T[]>` に `at(index: number | Expr<number>, fallback: T | Expr<T>): Expr<T>`、`length(): Expr<number>`。

- [ ] **Step 1: テストを書く**（`src/evaluate.test.ts`）
  - `length`：`"héllo"` → 5、`""` → 0、配列 `["a","b"]` → 2、数や `null` → 0。
  - `trim`：`"  a b "` → `"a b"`。文字列でない値 → `""`。
  - `lower`：`"ÀB"` → `"àb"`。
  - `includes`：`"Hello"` と `"ell"` → `true`、`""` を含む → `true`、文字列でない値 → `false`。
  - `clamp`：`5` を `0..3` → 3、`-1` → 0、`min > max` のときは `min`。数でない値 → `min`。
  - `mod`：`4 mod 3` → 1、`-1 mod 3` → 2（Review Focus 4）、`n = 0` → 0、数でない値 → 0。
  - `at`：`["a","b"]` の 1 → `"b"`、3 → fallback、`-1` → fallback、整数でない番号 → fallback、配列でない値 → fallback（Review Focus 5）。
    `src/signal.test.ts`：各メソッドの生成するノードと型（`Expr<number>` に `trim` がないこと、`at` の fallback の型が配列の要素型と合わないと型エラー）。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/evaluate.test.ts src/signal.test.ts`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      `ExprBase` に配列用のメソッドを足すため、`Expr<T>` の条件に `[T] extends [readonly JsonValue[]] ? ArrayMethods<...> : unknown` を足す。`length()` は文字列と配列で同じノードを使う。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test`
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Add string, number and array expressions to signals"`

### Task 2: 束縛できる属性とキー付き ref

**Files:**

- Modify: `src/protocol.ts`（`bindableAttributes` に `aria-activedescendant`、`aria-selected`、`aria-controls`、`aria-label`、`tabindex`、`hidden`。`booleanAttributes` に `hidden`。`StmtNode` の `focus` をキー付きにも使える形に）
- Modify: `src/signal.ts`（`refs()`）、`src/signal-runtime.ts`（キー付きの `focus`）、`src/index.ts`（`refs` を export）
- Test: `src/signal.test.ts`、`src/signal-runtime.test.ts`

**Interfaces:**

- Produces: `refs<const Name extends string = never>(options?: { name?: ... }): { attr(key: string): { [signalAttributes.ref]: string }; focus(key: string | Expr<string>): StmtNode }`。
- `StmtNode` に `["focus-key", refId: string, key: ExprNode]`（名前は実装で決めてよいが、既存の `["focus", id]` は変えない）。

- [ ] **Step 1: テストを書く**
  - `bindAttr({ hidden: e.closed })` が真で空の属性、偽で属性なし（SSR とランタイムの両方）。`tabindex` と `aria-activedescendant` は文字列、`aria-selected` は `"true"` / `"false"`。
  - `refs({ name: "tab" })` の `attr("b")` を付けた要素に、`focus(e.key)`（`e.key` が `"b"`）でフォーカスが移る。見つからないキーでは何もしない。キーに `.` や空白を含んでも、別の要素と取り違えない。
  - `refs` の名前の検査（`Identifier`）。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/signal.test.ts src/signal-runtime.test.ts`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      `data-hs-ref` の値は ID とキーを、キーにどんな文字が来ても区切りを取り違えない形で合わせる（たとえば JSON の配列の文字列）。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test`
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Bind roving focus attributes and focus keyed refs"`

### Task 3: キー操作とフォーカスの出入り

**Files:**

- Modify: `src/protocol.ts`（`eventAttributes` に `keydown: "data-hs-on-keydown"`、`focusEnter: "data-hs-on-focus-enter"`、`focusLeave: "data-hs-on-focus-leave"`）
- Modify: `src/signal.ts`（`on.keydown`、`on.focusEnter`、`on.focusLeave`、型 `KeyName` / `KeyCombination`）、`src/signal-runtime.ts`（委譲）、`src/index.ts`（型の export）
- Test: `src/signal.test.ts`、`src/signal-runtime.test.ts`

**Interfaces:**

- Produces: `on.keydown(map: { readonly [Key in KeyCombination]?: Statements })`、`on.focusEnter(stmts: Statements)`、`on.focusLeave(stmts: Statements)`。`type KeyCombination = KeyName | \`${Modifier}+${KeyName}\`...`（修飾キーの並び順は `Control`、`Alt`、`Shift`、`Meta` の順に固定する）。

- [ ] **Step 1: テストを書く**（jsdom）
  - 対応表のキーで文が走り、`defaultPrevented` が真。`Tab` / `Shift+Tab` は既定の動作を止めない。
  - 修飾キーの完全一致（Review Focus 1）。
  - 内側の対応表にないキーは外側の対応表が受ける。内側にあれば外側は走らない。
  - `isComposing` の `keydown` は無視。
  - 送信中の要素では走らない。子を自分で描くカスタム要素の中の対応表は無視。
  - `focusEnter`：外から入ると走り、中での移動では走らない。`focusLeave`：外へ出ると走り、中での移動（中の `tabindex="-1"` の要素へ移る場合を含む、Review Focus 2）では走らない。`relatedTarget` が `null` のとき、`document.hasFocus()` が偽なら走らない、真なら走る。
  - 型テスト：知らないキーの名前、`Shift+Control+Enter`（並び順違い）は型エラー。`on.keydown({ ["Shift+" + x]: [] })` のように型を通った不正な名前は実行時に例外。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/signal.test.ts src/signal-runtime.test.ts`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      `keydown` と `focusin` / `focusout` を、今の `click` などと同じ場所で document に委譲する。対応表は `[キー, 文の一覧][]` の JSON で、形の正しくない組は無視する。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test`
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Handle keys and focus moving in and out of elements"`

### Task 4: 名前付きタイマー

**Files:**

- Modify: `src/protocol.ts`（`StmtNode` に `["after", timerId, ms, StmtNode[]]`、`["cancel", timerId]`）
- Modify: `src/signal.ts`（`timer()`）、`src/signal-runtime.ts`（予約の表と実行）、`src/index.ts`（`timer` を export）
- Test: `src/signal.test.ts`、`src/signal-runtime.test.ts`

**Interfaces:**

- Produces: `timer<const Name extends string = never>(options?: { name?: ... }): { after(ms: number, stmts: Statements): StmtNode; cancel(): StmtNode }`。`ms` が 0 以上の整数でなければ `after` を呼んだときに `RangeError`。

- [ ] **Step 1: テストを書く**（`vi.useFakeTimers()`）
  - `after(3000, [...])` が 3000 ms 後に一度走る。2999 ms では走らない。
  - 同じタイマーの `after` を 1000 ms 後にもう一度実行すると、そこから 3000 ms 後に一度だけ走る。
  - `cancel` で走らない。別のタイマーは互いに干渉しない。
  - 予約した要素が Live View の morph で作り直されても文は走る（Review Focus 3）。そのとき文の中の `call` は送らない（`fetch` が呼ばれない）。要素がページにあれば `call` を送る。
  - 予約した要素が送信中でも文は走る。
  - `on.input([t.after(500, [save.call(...)])])` で、続けて入力すると最後の入力から 500 ms 後に一度だけ送り、`bindValue` のストアへの書き込みは入力のたびにすぐ行われる。
  - `after(-1, ...)` と `after(1.5, ...)` は `RangeError`。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test src/signal.test.ts src/signal-runtime.test.ts`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      予約はランタイムの `Map<timerId, { handle, control }>`。時間が来たら、`control` がまだページにあればそれを送信元に `run` し、なければ `call` を除いた文を `run` する。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run build`
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Schedule signal statements with named timers"`

### Task 5: 部品のサンプル

**Files:**

- Create: `examples/widgets/server.tsx`、`examples/widgets/style.css`
- Modify: `package.json`（`example:widgets`）、`playwright.config.ts`（`widgets` プロジェクト、ポート 3226）、`README.md`（サンプルの表）
- Test: `browser-tests/widgets.spec.ts`

**Interfaces:**

- Consumes: Task 1〜4 の API。既存の `signals`、`bindAttr`、`bindShow`、`bindText`、`bindValue`、Action、Live View、Topic。

- [ ] **Step 1: ブラウザテストを書く**
  - コンボボックス（select-only）：Enter / Space / ArrowDown で開く、矢印で候補を移る（`aria-activedescendant` と `aria-selected` が変わる）、Home / End、Enter で決めて閉じる、Escape で閉じる、候補をマウスで押して決まる（Review Focus 2）、外をクリックすると閉じる。決めた値は Action で保存され、ほかのタブの Live View に届く。
  - タブ：左右の矢印で移動して自動で切り替わる、端で一周する、Home / End、`tabindex` が選んだタブだけ 0。
  - 開閉パネル：ボタンで開く、フォーカスが外へ出ると閉じる、Escape で閉じてボタンにフォーカスが戻る。
  - 文字数カウンター：入力に合わせて残りの文字数が変わる。前後の空白だけなら送信ボタンが無効。絞り込み：入力に合わせて行が隠れる（大文字小文字を区別しない）。
  - トースト：保存の成功で出て、3 秒後に消える（`page.clock` で時間を進める）。デバウンス：続けて入力すると、止まってから一度だけ下書きの保存が送られる。
  - CSP の違反がないこと（`securitypolicyviolation` を数える）。

- [ ] **Step 2: 失敗を確かめる**
      Run: `bun run test:browser --project widgets`
      Expected: FAIL

- [ ] **Step 3: 実装する**
      既存のサンプル（`examples/todomvc/server.tsx`）と同じ構成（セッションの Cookie、CSP、ランタイムの配信、`page()`、出力先）。フレームワークの属性名やイベント名を手で書かない。候補とタブの `id` はアプリの文字列でよい。

- [ ] **Step 4: テストを通す**
      Run: `bun run format:fix && bun run check && bun run test && bun run build && bun run test:browser`（2 回）
      Expected: PASS

- [ ] **Step 5: Commit**
      `git commit -m "Add widget examples built only from signal primitives"`

### Task 6: ドキュメントと大きさ

**Files:**

- Modify: `docs/architecture.md`（「ブラウザ側の Signal」、「ランタイムの大きさ」）
- Modify: `site/content/{ja,en}/reference.html`、`concepts.html`

- [ ] **Step 1: 大きさを測る**
      `bun build src/browser.ts --target=browser --minify` と gzip -9 で、`93a68e5` と現在を比べる（古い版は `/private/tmp/claude-501/` の一時的なワークツリーで作り、終わったら消す）。増分が 4 KB を超えたら、Global Constraints の順に削ってから先へ進み、そのことを報告する。

- [ ] **Step 2: 書く**
      設計書の「ドキュメント」の節のとおり。型で検査できない部分（実行時に検査するキーの名前、`ms`、`length()` が UTF-16 の長さ、タイマーの文の `call` が送られない条件、並行して送られうること、`focusLeave` とマウスのための `tabindex="-1"`）を書く。英語版と日本語版で同じ内容にする。

- [ ] **Step 3: 確かめる**
      Run: `bun run format:fix && bun run check`
      Expected: PASS

- [ ] **Step 4: Commit**
      `git commit -m "Document the new signal primitives"`
