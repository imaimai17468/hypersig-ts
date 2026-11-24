# フォームの制約属性 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Action の入力スキーマの JSON Schema 変換から入力欄の制約属性を作る `action.control(name)` を足し、例のアプリの手書きの制約属性を置き換える。

**Architecture:** `src/action.ts` の `registerAction` が、入力スキーマが `StandardJSONSchemaV1` も満たすときだけ `control` を型に出す。最初の呼び出しで `jsonSchema.input({ target: "draft-2020-12", libraryOptions })` を呼んで結果を覚え、最上位の `properties` と `required` から属性を作る。`createHypersig` は `jsonSchema.libraryOptions` を受け取って渡す。

**Tech Stack:** TypeScript 7、Hono、Standard Schema 1.1.0、Valibot 1.5.0、`@valibot/to-json-schema` 1.8.0（devDependency）、vitest、Playwright

**Spec:** `docs/superpowers/specs/2026-11-24-form-constraints-design.md`

## Global Constraints

- ライブラリ本体の `dependencies` は増やさない。`@valibot/to-json-schema@1.8.0` は devDependency に入れる（バージョン固定、`bun install` で lockfile も更新）。
- 対応する属性は `required`（`type: "boolean"` を除く）、`minLength`、`maxLength`、`pattern`（`^` で始まり `$` で終わるものだけ）、`min`（`minimum`）、`max`（`maximum`）だけ。`type` は出さない。
- 変換の失敗は Action 名を含めた例外にし、`libraryOptions` で飛ばせることを書く。
- 各タスクの終わりに `bun run format:fix`、`bun run check`、`bun run test`、`bun run build` を通す。例を変えたら `bun run test:browser` と `mise exec -- node site/build.ts` も通す。通ったら `git push origin main`。

## Review Focus

- 最上位が object でない、または `properties` がない JSON Schema。`control()` は `name` だけを返すべき（Task 1）。
- 任意の項目（`required` に含まれない）。`required` を付けないべき（Task 1）。
- `^...$` でない `pattern`。出さないべき（Task 1）。
- 変換が例外を投げるスキーマ。Action 名を含む例外になるべき（Task 1）。
- `control()` を何度呼んでも変換は一度だけ（Task 1）。

---

### Task 1: `action.control()`

**Files:**

- Modify: `src/action.ts`、`src/hono.ts`（`HypersigOptions` に `jsonSchema?: { libraryOptions?: Record<string, unknown> }`）、`src/index.ts`（必要な型の export）、`package.json` / `bun.lock`（devDependency）
- Test: `src/index.test.ts`

**Interfaces:**

- Produces: `registerAction` の戻り値に、入力スキーマが `StandardJSONSchemaV1` を満たすときだけ

  ```ts
  control<Name extends FormFieldName<Wire>>(name: Name): FieldControl<Name>;
  export interface FieldControl<Name extends string> { name: Name; required?: true; minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number }
  ```

  `FieldControl` は `src/index.ts` から型として export する。

- [ ] **Step 1: 失敗するテストを書く**（Valibot と `toStandardJsonSchema` でスキーマを作り、`createHypersig({ ..., jsonSchema: { libraryOptions: { errorMode: "ignore" } } })` で登録する）
  - `derives control attributes from the input schema`: `v.object({ title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)), code: v.pipe(v.string(), v.regex(/^[0-9]+$/)), loose: v.pipe(v.string(), v.regex(/[0-9]/)), count: v.pipe(v.number(), v.minValue(1), v.maxValue(5)), note: v.optional(v.string()), done: v.boolean() })` で、`control("title")` が `{ name: "title", required: true, minLength: 1, maxLength: 200 }`、`control("code")` が `{ name: "code", required: true, pattern: "^[0-9]+$" }`、`control("loose")` が `{ name: "loose", required: true }`、`control("count")` が `{ name: "count", required: true, min: 1, max: 5 }`、`control("note")` が `{ name: "note" }`、`control("done")` が `{ name: "done" }`。
  - `converts the schema once`: `jsonSchema.input` を数える偽のスキーマで、`control()` を 2 回呼んでも 1 回。
  - `reads only object schemas`: `jsonSchema.input` が `{ type: "string" }` を返す偽のスキーマで、`control("x")` が `{ name: "x" }`。
  - `names the action when conversion fails`: `libraryOptions` なしで `v.trim()` を含むスキーマの `control("title")` が、Action 名と `libraryOptions` を含むメッセージの例外を投げる。
  - 型: `// @ts-expect-error The schema has no field named "titel".` で `control("titel")`。`// @ts-expect-error A schema without JSON Schema conversion has no control().` で、普通の `v.object(...)`（包まない）を入力にした Action の `control`。
- [ ] **Step 2:** FAIL を確かめる。
- [ ] **Step 3:** 実装する。devDependency を足す。
- [ ] **Step 4:** PASS と check、build を確かめる。
- [ ] **Step 5:** コミットして push する（`Derive form control attributes from input schemas`）。

### Task 2: 例のアプリとドキュメント

**Files:**

- Modify: `examples/todomvc/server.tsx`、`examples/shared-memo/server.tsx`、`site/content/{en,ja}/reference.html`、`README.md`（機能の一覧に 1 行）、`docs/architecture.md`（Action の節に 1 段落）
- Test: `browser-tests/todomvc.spec.ts`、`browser-tests/memo.spec.ts`

**Interfaces:**

- Consumes: Task 1 の `control()` と `jsonSchema.libraryOptions`。
- 置き換え: 両方の例で `createHypersig` に `jsonSchema: { libraryOptions: { errorMode: "ignore" } }` を渡し、`control()` を使う Action の入力スキーマを `toStandardJsonSchema(v.object(...))` で包む。TodoMVC の追加と編集のタイトル入力、共有メモの本文の `textarea` から、手で書いた `required` / `maxLength` を消して `{...action.control(...)}` にする（`draft()` を併用している箇所は、`draft()` が返す `name` と重複しないようにする）。

- [ ] **Step 1: 失敗するテストを書く**: TodoMVC の追加欄が `required` と `maxlength="200"` と `minlength="1"` を持つ。共有メモの本文が `required` と `maxlength="1000"` を持つ（今の手書きと同じ値なので、属性名の確認として書き、置き換え後も通ることを確かめる。`minlength` は今はないので、これが置き換えの証拠になる）。
- [ ] **Step 2:** `bun run test:browser` で、`minlength` の確認が FAIL することを確かめる。
- [ ] **Step 3:** 置き換えとドキュメントを書く。reference には、`control()` が型に現れる条件、対応する属性、`libraryOptions`、送信前の文言はブラウザ標準であることを書く。英語と日本語で内容を揃える。
- [ ] **Step 4:** test:browser、site build、check、test、build を確かめる。
- [ ] **Step 5:** コミットして push する（`Use schema-derived controls in the examples`）。
