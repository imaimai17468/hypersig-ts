# ブラウザ側 Signal の設計

## 目的

hypersig.ts の画面更新は、今はすべてサーバーを往復する。ブラウザだけで決まる UI の状態を書く手段がないため、例のアプリは手書きの JavaScript と手書きのセレクタで補っている。共有メモの `examples/shared-memo/editor.ts`（約 70 行）は、`#memo-editor`、`[name=baseRevision]`、`#draft-version`、`data-revision` を手で書き、Live View の DOM を `MutationObserver` で読む。これは `AGENTS.md` の Thesis（ブラウザが扱う文字列は型から作る）に反する。TodoMVC の完了切り替えは、応答が届くまで画面が変わらない。

ブラウザ側の Signal を足し、次の 3 つを型から書けるようにする。

1. ブラウザだけで決まる UI の状態（表示の切り替え、入力値、編集元の版など）
2. Live View が描画した値を Signal として受け取ること
3. Action を送るのと同時に画面を先に変え、失敗したら戻す楽観的更新

楽観的な書き込みは、データをサーバーが確定してから表示する原則の例外である（2026-11-24 に原則として明記）。TodoMVC は現在、楽観的な書き込みを使わず、処理中の表示で操作に反応する。

暗黙の楽観的な書き戻し（`call` より前の書き込みを失敗時に自動で戻す仕組み）は 2026-11-24 に取り除き、アプリが `onError` で明示的に戻す形にした。ブラウザだけの書き込みまで戻り、応答と更新の順序による競合を抱え、使う例もなかったため。

Rust 版 hypersig の思想（サーバーが状態を持つ、ハイドレーションしない、ブラウザが扱う文字列は型から作る）は共有する。Rust 版の API や属性の一覧は写さず、TypeScript で書きやすい形を選ぶ。

## 合格の基準

- `examples/shared-memo/editor.ts` を削除し、同じ振る舞いを Signal で書ける。既存の `browser-tests/memo.spec.ts` が変更なしか、セレクタの差し替えだけで通る。
- TodoMVC の完了切り替えが、Action の応答を待たずに画面に出る。Action が失敗したら元の表示に戻る。ブラウザテストで、応答を遅らせた場合と失敗させた場合を確かめる。
- アプリのコードに、Signal の名前、式、ランタイムやスクリプトが要素を探すためのセレクタを文字列で書く箇所がない。HTML 同士の ID 参照（`id` と `for`、`aria-describedby`、`popovertarget`）はこの基準の対象外とする（設計者の判断）。`AGENTS.md` の Thesis の一覧にも含まれていない。

## 目的にしないこと

- Rust 版の属性を全部移すこと。ブラウザ側でのリスト描画（`each` / `list`）、`computed`、クライアント側の画面遷移、JavaScript ライブラリを包むカスタム要素は今回の範囲外。必要になった時点で、この設計の上に足す。
- ブラウザでアプリのコードを実行すること。式はデータとして送り、ランタイムが評価する。`eval` や `new Function` は使わない。

## やってはいけないこと

- 動いても失敗とみなすもの:
  - Signal の値や式を通して、任意の属性（`href`、`src`、`on*`、`style`）や HTML を書けること
  - ハイドレーションが必要になること。ページを表示するためにコンポーネントを再実行したり、アプリのコードをダウンロードしたりすること
  - Live View が送る確定済みの値と、ブラウザの値のどちらが表示されるかが決まらないこと

## 制約

- サーバー側の API は、`action.bind()` と同じく JSX に展開する属性のオブジェクトを返す。Hono JSX 以外のレンダラーでも使える。
- 値は `JsonValue`（`src/action.ts`）に限る。`Date` や `bigint` は型エラーにする。
- 受信した HTML 断片は DOMPurify を通る。`data-*` 属性は通過するので、Signal の属性は `data-hs-*` に置く。
- CSP の `script-src 'self'` と `eval` 禁止のまま動く。
- ブラウザのランタイムの増分を計測して報告する。目安は gzip で 4 KB 以下。超える場合は理由を書く。

## 検討した方式

| 方式                                                           | 内容                                                                                                      | 判断                                                                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 型付きの式をデータとして HTML に入れる                      | Signal と式を TS のビルダーで組み立て、JSON の構文木として `data-hs-*` 属性に入れる。ランタイムが評価する | **採用**。アプリのコードを送らず、CSP を緩めず、名前・式・Action 呼び出しをすべて型から作れる。引き換えに演算子が使えず（`a.add(1)`）、書ける式は用意した範囲に限られる |
| B. 型付きのクライアント island                                 | ブラウザ向けの TS モジュールを書き、型付きの props で読み込む                                             | 不採用。アプリごとにブラウザ向けのビルドが要り、アプリのコードを送る。モジュールの中で DOM を触るセレクタは手書きに戻る                                                 |
| C. A を基本にし、重いライブラリだけ B 相当のカスタム要素で包む | Rust 版と同じ構成                                                                                         | 今回は A だけを作る。逃げ道は A の上に後から足せる                                                                                                                      |

## 設計

### ワイヤ形式を一か所で定義する

Rust 版は、ワイヤ形式を Rust とブラウザのランタイムで二重に定義し、fixture で整合を検査していた。hypersig.ts はサーバーもブラウザも TypeScript なので、式・文・属性の JSON の型を `src/protocol.ts` で一度だけ定義し、サーバー側のビルダーとブラウザ側の評価器の両方がそれを読む。

### Signal の定義

```ts
const editor = signals(
  { base: 0, published: 0, operation: "" },
  { name: "memo-editor" }
);
```

- 初期値から型を推論する。値は `JsonValue`。
- `name` は省略できる。Live View と同じく、Signal のグループごとに `name-番号` の ID を振るので、別の定義の ID は重ならない。`name` のリテラルは `Identifier` 型（`src/identifier.ts`）で検査する。
- ID は `signals()` を呼んだ時点で振る。属性を作る関数はランタイムやページに触れないので、Live View のように描画時に振ることはできない。ページ登録はプロセスの中に閉じているので、初期 HTML と Live View の更新で ID は一致する。
- 行ごとに状態を持つ場合は、キー付きのグループを使う。

```ts
const rows = signalFamily({ completed: false }, { name: "todo-row" });
const row = rows.at(todo.key); // row.completed は Signal<boolean>
```

`at()` に渡すキーはアプリのデータで、別の場所の文字列と照合する参照ではないので、Thesis の対象ではない。

### 式と文

- `Signal<T>` は `Expr<T>` でもある。`Expr<T>` のメソッドは `T` で変わる。
  - 共通: `eq`、`ne`
  - `number`: `add`、`sub`、`mul`、`gt`、`ge`、`lt`、`le`
  - `boolean`: `not`、`and`、`or`、`choose(whenTrue, whenFalse)`（`then` にすると `Expr` が thenable になるため、この名前にした）
  - `string`: `concat`
  - 組み込み: `uuid()`（`crypto.randomUUID()`）、`lit(value)`
- 文: `signal.set(expr)`、`signal.toggle()`（`boolean` のみ）、`ref.focus()`、`action.call(input, options)`。文の配列は順に実行する。
- どれも `src/protocol.ts` の構文木を返す。型に合わない組み合わせ（`number` と `string` の `add` など）は型エラーにする。

### 値の入ったハンドルから束縛を作る

属性を作る関数はページやリクエストに触れないので、`signals()` の定義だけでは、そのリクエストの初期値を知らない。サーバーが初期 HTML に評価済みの値を書けるよう、値を渡したハンドルから束縛を作る（設計者の判断）。

```tsx
const e = editor.with({ base: draft.revision, operation: operationId });
<form {...save.form({ draft: true })} {...e.init()}>
  <span {...e.bindText(e.base)} /> {/* children に評価済みの文字列が入る */}
  <p {...e.bindShow(e.published.gt(e.base))}>新しい版があります</p>
</form>;
```

- `with(values)` に渡さなかった項目は `signals()` の初期値を使う。
- `e.init()` は `data-hs-signals` を返す。`with` で渡した項目は確定した値の組 `[path, value]` で、渡さなかった項目は既定値の組 `[path, value, 0]` で書く。ランタイムは既定値の組を、ストアにそのパスの値がないときだけ適用する。
- `bindText` は属性と一緒に `children` を返し、評価した文字列を中身にする。`bindShow` は評価が `false` なら `hidden` を返す。`bindAttr` と `bindValue` も評価した値を属性として返す。JS なしでも、Live View の更新 HTML でも、正しい値が出る。
- キー付きのグループも同じく `rows.at(todo.key).with({ completed: todo.completed })` とする。
- 実装前に、Hono JSX で `children` を含むオブジェクトを展開したときの挙動を確かめる。展開で中身を入れられない場合は、`bindText` だけ `<e.Text value={expr} />` のようなコンポーネントにする。

### 表示への束縛

ハンドルのメソッドが属性のオブジェクトを返し、JSX に展開する。

| API                                                       | 属性               | ブラウザでの動き                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindText(expr)`                                          | `data-hs-text`     | `textContent` を書き換える                                                                                                                                                                |
| `bindShow(expr)`                                          | `data-hs-show`     | `false` のとき `hidden` を付ける                                                                                                                                                          |
| `bindAttr({ disabled: expr, "aria-pressed": expr, ... })` | `data-hs-attr`     | 許可した属性だけを書き換える。許可するのは `disabled`、`checked`、`aria-*` の一部、`data-*`。`href`、`src`、`on*`、`style` はキーの型に含めない                                           |
| `bindValue(signal)`                                       | `data-hs-bind`     | `[path, kind]` を持ち、`kind` は初期値から決めた `"string"`、`"number"`、`"boolean"`。入力欄の値と Signal を双方向に結ぶ。`hidden` の入力にも使えるので、送信する値を Signal で決められる |
| `on.click(stmts)` など                                    | `data-hs-on-click` | イベントで文を実行する。最初は `click`、`input`、`change`                                                                                                                                 |
| `ref()` → `{...draftRef.attr()}`                          | `data-hs-ref`      | `focus()` の対象にする                                                                                                                                                                    |

サーバーは初期値で式を評価し、初期 HTML に結果を書く。ランタイムを読み込む前から正しく表示される。

### 初期値と Live View との役割分担

- `{...editor.with({ base: draft.revision }).init()}` は、`data-hs-signals` に値を入れる。ランタイムは読み込み時に、ページにあるすべての `data-hs-signals` をストアに入れる。
- **`with` で渡した項目は、サーバーが確定した値として扱う。** Live View の中にある `data-hs-signals` の確定した値は、その Live View の更新が届いて morph したあと、断片から読み直してストアを上書きする。
- **`with` で渡さなかった項目は既定値として扱う。** 既定値の組 `[path, value, 0]` は、ストアにそのパスの値がないときだけ書く。読み込み時も Live View の更新時も同じで、ブラウザだけで決まる値を上書きしない。
- Live View の外にしかない Signal は、ブラウザだけの状態として扱う。最初に読み込んだあとは、サーバーから上書きされない。
- 共有メモの「公開中の版」は、`publishedMemo` の描画で `{...editor.with({ published: memo.revision }).init()}` を出す。保存のたびに Live View が更新され、`editor.published` が新しい版になる。`MutationObserver` は要らない。

### ページを読み込んだときの順序

設計者の判断として、次の順に処理する。

1. 下書きを復元する（今の `restoreDrafts`）。入力欄の `value` が復元した値になる。
2. ページのすべての `data-hs-signals` をストアに入れる。
3. `bindValue` の入力欄を読む。入力欄の `value` が `defaultValue` と違う場合（復元した場合や、ブラウザがフォームの値を残した場合）は、入力欄の値でストアを上書きする。利用者の入力を優先するため。
4. すべての束縛を評価して DOM に反映する。

`bindValue` の型の変換も設計者の判断で決める。

- `string` の Signal は、テキスト系の入力欄と `hidden` に結べる。
- `number` の Signal は、`Number()` で変換する。結果が有限の数でなければストアを変えない。共有メモの `baseRevision` は `number` の Signal にし、hidden の入力欄に結ぶ。入力スキーマの変換前の型が `string` でも、送信されるのは入力欄の文字列なので問題はない。
- `boolean` の Signal は、checkbox の `checked` に結ぶ。
- ランタイムが入力欄に値を書くときは `value` だけを変え、`defaultValue` は変えない。今の `editor.ts` と同じく、保存成功後に変わった編集元の版も、下書きの一部として退避の対象になる。

### 楽観的更新

```tsx
<button {...on.click([
  row.completed.toggle(),
  toggle.call({ todoKey: todo.key, completed: row.completed }),
])}>
```

- `action.call(input, options)` は文を返す。`input` の各項目には値か `Expr` を書ける。型は入力スキーマの変換前の型で検査し、`bind` と同じく JSON に限る。
- 同じハンドラの中で `call` より前に書いた `set` / `toggle` は、送信と同時に画面に出る。
- **自動で戻す。** ランタイムは `call` の前に書き換えたパスの元の値を覚えておく。Action が失敗し、その後にサーバーからそのパスの値が届いていなければ、元の値に戻す。
- **送信中は上書きを保留する。** `call` が終わるまでに Live View からそのパスの値が届いたら、適用を保留し、終わった時点で最新の値を適用する。別の変更で Live View が更新されたときに、楽観的な表示が一瞬戻るのを防ぐ。
- `options.onSuccess(output => stmts)` と `options.onError(stmts)` を書ける。`output` は出力スキーマの型の `Expr`。
- 保留した値は、Action が成功した時点で最新のものを適用する（設計者の判断）。そのため、次の順序のときだけ、楽観的な表示が一瞬戻る。(1) 送信中に、commit 前の値を持つ Live View の更新が届く。(2) Action の応答が届く。(3) commit 後の Live View の更新が届く。これを防ぐには、Action の応答と Live View の版を突き合わせる仕組みがプロトコルに要るので、今回は入れない。既知の制約として API ドキュメントに書く。テストは (1) がない順序と、(3) が応答より先に届く順序で確かめる。

### フォームから送る Action

共有メモの保存は、JS なしでも動くネイティブのフォームから送る。`form()` にも同じオプションを足す（設計者の判断）。

```tsx
<form {...save.form({
  draft: true,
  onSuccess: (output) => [e.base.set(output.revision), e.operation.set(uuid())],
})}>
```

- `onSuccess` と `onError` は `data-hs-on-success` / `data-hs-on-error` 属性になる。今の `reportSuccess` と `hypersig:action-success` イベントは残す。
- JS がないときは、今と同じく `formResponse` を通るネイティブの送信になり、これらの属性は使わない。

### Action の送信中の状態

ランタイムが持つ組み込みの Signal として、`action.pending()` を用意する（設計者の判断）。その Action のフォームかボタンが送信中なら `true` になる。共有メモは「表示中の版から編集を続ける」に `bindAttr({ disabled: save.pending() })` を付け、送信中は押せなくする。今の `editor.ts` が送信中のクリックを無視している振る舞いを、これで置き換える。

今の `editor.ts` は、そのボタンを押したときにエラー表示も消す。これは移さない（設計者の判断）。次の送信でランタイムがエラー表示を消すので、残るのはボタンを押してから次に送信するまでの間だけになる。振る舞いの差として報告する。

### 下書きの復元との接続

共有メモは、下書きを復元したときに案内を出し、保存に成功したら消す。ランタイムが持つ組み込みの Signal として `action.draftRestored()` を用意する。`form({ draft: true })` のフォームを復元したときに `true` になり、そのフォームの Action が成功したら `false` に戻る。アプリは `e.bindShow(save.draftRestored())` のように読む。組み込みの Signal は、`pending()` と同じくアプリが名前を書かない形にする。

### セキュリティ

- 評価器は、`src/protocol.ts` で定義した演算子だけを実行する。知らない演算子を含む属性は無視する。
- 文字列を出す先は `textContent` と、許可した属性だけ。
- `data-hs-signals` は JSON として読み、`JsonValue` でなければ無視する。
- Action の呼び出しは、今と同じく Action のパスと同一オリジンを検査してから送る。

## 決まっていること

- 方式 A を採用する。
- 範囲は目的 1〜3。合格の基準は上の 3 つ。
- Live View が送る値が優先される。Live View の外の Signal はブラウザだけが持つ。
- 楽観的更新は自動で戻し、送信中はサーバーの値の適用を保留する。

## 実装する人に任せること

- サーバー側とブラウザ側のモジュールの分け方。ただし `.claude/rules/library.md` に従い、公開する API は `src/index.ts` から出す。
- 構文木の具体的な JSON の形。短くて検査しやすい形を選ぶ。
- `bindAttr` で許可する `aria-*` と `data-*` の具体的な一覧。
- ストアの変更を、値を読む束縛だけに伝える仕組み。依存の追跡をするか、パスごとの購読にするか。
- 組み込みの Signal の内部的な名前の付け方。アプリが文字列で触れない形にする。
