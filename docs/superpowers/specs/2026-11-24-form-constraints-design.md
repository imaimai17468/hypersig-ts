# フォームの制約属性をスキーマから作る設計

## 目的

Action の入力スキーマと入力欄の制約属性に、同じ規則を手で二重に書いている。TodoMVC はスキーマに `v.maxLength(200)` を書き、入力欄にも `maxLength={200}` を書く。片方だけ変えると、ブラウザは通すがサーバーが 422 を返す。型でも検出できない。規則を 1 回だけ書き、入力欄の制約属性はスキーマから作る。

## 合格の基準

- TodoMVC と共有メモの入力欄から、手で書いた `required`、`minLength`、`maxLength` がなくなり、スキーマから作った属性で同じ表示と検査になる。
- JS がなくても、ブラウザが送信前に規則違反を止める（今と同じ）。
- 入力スキーマが JSON Schema に変換できないとき、`control()` は型に現れない。

## 目的にしないこと

- 送信前にブラウザが出すエラーの文言を、スキーマの文言に揃えること。JSON Schema に文言はなく、ライブラリの内部に依存する必要がある。
- ブラウザのランタイムで検査を動かすこと。ブラウザ標準の制約検査に任せる。
- 入力欄の `type` を変えること（`format: "email"` から `type="email"` を作るなど）。`type` はアプリが決める。

## 検討した方式

| 方式                                                                           | 判断                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| A. Standard Schema の JSON Schema 変換（`StandardJSONSchemaV1`）から属性を作る | **採用**。ライブラリを選ばず、標準だけに依存する               |
| B. A に加え、ライブラリごとの読み取りで文言も揃える                            | 見送り。ライブラリの内部構造に依存する。A を使ってから判断する |
| C. hypersig.ts 独自の規則の書き方を作る                                        | 不採用。Valibot や Zod を作り直すことになる                    |

## 設計

### API

```tsx
<input {...add.control("todoTitle")} />
// → name="todoTitle" required minLength={1} maxLength={200}
```

- `action.control(name)` は、`field(name)` と同じく入力スキーマの最上位の項目名を型で検査し、`name` と制約属性を返す。戻り値の型は `{ name: Name; required?: true; minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number }`。
- `control` は、入力スキーマが `StandardJSONSchemaV1` も満たすときだけ型に現れる。満たさないスキーマで呼ぶとコンパイルエラーになる。`field()` と `draft()` は今のまま使える。
- `createHypersig({ jsonSchema: { libraryOptions } })` で、変換に渡す `libraryOptions` を指定できる。例のアプリは Valibot の `{ errorMode: "ignore" }` を渡し、`v.trim()` のような変換を飛ばす。

### 変換と対応

- 変換は、その Action で最初に `control()` を呼んだときに一度だけ行い、結果を覚える。`jsonSchema.input({ target: "draft-2020-12", libraryOptions })` を使う。入力側の型で変換するのは、ブラウザが送るのは変換前の値だからである。
- 変換が例外を投げたら、Action 名を含めたメッセージで例外を投げ直す。`libraryOptions` で変換できない部分を飛ばす方法があることも書く。描画時の例外になるが、黙って属性を落とすよりよい。
- 最上位が `type: "object"` で `properties` を持つときだけ読む。項目ごとの対応は次のとおり。
  - `required` に含まれる → `required: true`。ただし `type: "boolean"` の項目は除く。checkbox の `required` は「チェック必須」の意味になり、`false` も正しい値だからである。
  - `minLength` / `maxLength` → `minLength` / `maxLength`。
  - `pattern` → `pattern`。ただし `^` で始まり `$` で終わるものだけ。HTML の `pattern` は暗黙に全体一致になるので、それ以外は意味が変わるため出さない。
  - `minimum` / `maximum` → `min` / `max`。`exclusiveMinimum` などは出さない。
  - それ以外（`format`、`enum` など）は出さない。サーバーの検査に任せる。

### 例のアプリ

- `@valibot/to-json-schema` を devDependency に足し、例の入力スキーマを `toStandardJsonSchema(v.object(...))` で包む。ライブラリ本体の依存は増えない。
- TodoMVC の追加と編集のタイトル、共有メモの本文で、手で書いた制約属性を `control()` に置き換える。共有メモの `maxLength` 定数は、スキーマの中だけで使う。

## 決まっていること

- 方式 A。文言の統一とブラウザでの検査は範囲外。
- `control()` は JSON Schema に変換できるスキーマでだけ型に現れる。
- 変換の失敗は例外にする。

## 実装する人に任せること

- `control` を型の上で条件付きにする具体的な書き方。
- 変換結果を覚える場所。
