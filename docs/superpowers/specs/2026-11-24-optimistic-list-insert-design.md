> この機能は 2026-11-24 に取り除いた。確定していない行が確定したデータと並び、アプリのサーバーがブラウザの作った key を受け入れる必要があったため。画面は操作にすぐ処理中として反応し、データはサーバーが確定してから表示する原則に戻した。

# 一覧への楽観的な追加と削除の設計

## 目的

Signal を入れたあとも、一覧への項目の追加はサーバーの応答を待つ。Signal が更新できるのはページにある要素だけで、ブラウザは新しい行を描かないからである。サイトの「性能と制約」ページにも、設計上の制約として書いている。Rust 版 hypersig で Topcoat との違いとして挙げていた「一覧への追加がその場で見える」を、TS 版の仕組みに合う形で実現する。

## 合格の基準

- TodoMVC の追加と削除が、Action の応答を待たずに画面に出る。
- Action が失敗したら、追加した行は消え、削除した行は戻る。
- 応答を遅らせた場合と失敗させた場合を、ブラウザテストで確かめる。
- アプリのコードに、テンプレートや挿入先を指す文字列を手で書く箇所がない（`AGENTS.md` の Thesis）。

## 目的にしないこと

- ブラウザ側で一覧全体を描くこと（Rust 版の `each` / `each_keyed`）。確定した一覧は今までどおり Live View が HTML で描く。
- 仮の行を並べ替えたり、編集したり、別の操作の対象にしたりすること。
- 削除のための新しい API。削除は今の Signal で書ける。

## やってはいけないこと

- 一覧の持ち主が 2 つになること。確定した一覧は Live View だけが持つ。
- 仮の行が、確定した行と見分けられないまま残り続けること。
- テンプレートの HTML を、受信した断片から取り込むこと。DOMPurify は断片の `<template>` を禁止しており、その方針を変えない。

## 検討した方式

| 方式                                              | 内容                                                                                                                                              | 判断                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A. 追加する行だけをブラウザで仮に描く             | サーバーが新しい行の見た目を `<template>` として描き、追加時にブラウザが複製して一覧に入れる。確定した行は Live View の更新で届き、仮の行は消える | **採用**。一覧の持ち主は Live View のままで、ランタイムの増分も小さい |
| B. 一覧を Signal の配列で持ち、ブラウザが全部描く | Rust 版と同じ                                                                                                                                     | 不採用。Live View が HTML で一覧を送る仕組みと持ち主がぶつかる        |
| C. 削除の書き方だけを整える                       | 追加は今のまま                                                                                                                                    | 不採用。目的を満たさない                                              |

## 設計

### テンプレートの定義と配置

```tsx
const newTodo = insertTemplate({ title: "" }, { name: "new-todo" });

// Live View の外（ページの本体）に置く
<template {...newTodo.template()}>
  <TodoPreview title={newTodo.item.title} />
</template>

// Live View の中の一覧に、挿入先の印を付ける
<ul {...newTodo.slot()}>{todos.map(...)}</ul>
```

- `insertTemplate(initial, options)` は、Signal グループと同じく `name-番号` の ID を振る。`name` は `Identifier` で検査する。
- `item` は `initial` の各項目に対応する `Expr` を持つ。パスは `["$item", field]` で、先頭が `$` なのでアプリは書けない。
- `template()` は `data-hs-template` を返す。テンプレートの中の束縛（`bindText` など）は `item` の値を読む。サーバーは `initial` で評価して描く。
- `slot()` は `data-hs-insert` を返す。挿入先の要素の最後の子として、複製した行を入れる。
- テンプレートは Live View の外に置く。ランタイムは、Live View の中にある `data-hs-template` を無視する。初期 HTML はアプリが描いたもので、DOMPurify を通らないので、テンプレートを取り込んでも安全である。挿入先の印は Live View の中にあってよい。`data-*` 属性なので、断片の中でも DOMPurify を通る。

### 追加の文と、確定した行との対応

- `newTodo.insert({ title: e.newTitle }, e.newKey)` は文を返す。値には値か `Expr` を書け、型は `initial` の型で検査する。第 2 引数は、この仮の行と確定した行を結ぶキー（`Expr<string>`）。
- ワイヤ形式は `["insert", templateId, Record<string, ExprNode>, ExprNode]`。最後がキー。
- 実行すると、ランタイムは値とキーを評価してテンプレートを複製する。複製の根の要素には、評価した値（`data-hs-item`、JSON）、キー（`data-hs-item-key`）、`data-hs-pending-item` を付け、ページにあるすべての挿入先に入れる。複製の中の束縛は、`["$item", field]` を最も近い `data-hs-item` の値から読む。
- **キーはブラウザが作り、Action の入力で送る**（設計者の判断）。アプリは `uuid()` でキーを作り、同じ値を Action の入力に入れる。サーバーはそのキーで項目を作り、確定した行に `{...newTodo.confirms(todo.key)}` を付ける。これは `data-hs-confirms`（JSON `[templateId, key]`）を返す。
- **確定した行が届いたら、仮の行をすぐに消す。** Live View の morph のあと、ランタイムは、その Live View の中にある仮の行のうち、同じテンプレート ID とキーの `data-hs-confirms` を持つ要素が同じ Live View にあるものを取り除く。送信中でも消す。応答より先に確定した行が届いた場合に、2 行が並ぶのを防ぐため。

### Action との結び付け

- 楽観的な書き込みと同じく、同じハンドラの中で `call` より前に実行した `insert` は、その `call` が受け持つ。
- 成功: `data-hs-pending-item` を外す。仮の行は、対応する確定した行が届いた時点で消える（上の規則）。成功した時点で確定した行がすでにあれば、すぐに消える。
- 失敗: 仮の行を取り除く。
- 送信中と、成功してから確定した行が届くまでは、Live View の morph が仮の行を消さないようにする。Idiomorph の `beforeNodeRemoved` で、`data-hs-item-key` を持つ仮の行の削除を断る。仮の行を取り除くのは、上の対応の規則と失敗のときだけにする。
- `call` を伴わない `insert` は、対応する確定した行が届くまで残る。
- **挿入先は、その項目が実際に入る一覧にだけ置く**（設計者の判断。アプリの責任として API ドキュメントに書く）。確定した行が届かない一覧に挿入先を置くと、仮の行が残り続ける。TodoMVC では、サーバーが描画時にフィルタを知っているので、Completed のページには挿入先を描かない。
- 仮の行は、確定した行と同じ見た目でも `data-hs-item-key` で見分けられる。

### フォームから送るときの文

TodoMVC の追加はフォームから送る。`form()` に `onSubmit` を足す。送信の直前に、ボタンの `on.click` と同じ楽観的なスコープで文を実行する。

```tsx
<form {...add.form({
  resetOnSuccess: true,
  onSubmit: [e.newKey.set(uuid()), newTodo.insert({ title: e.newTitle }, e.newKey)],
})}>
  <input type="hidden" name={add.field("todoKey")} {...e.bindValue(e.newKey)} />
  <input name={add.field("todoTitle")} {...e.bindValue(e.newTitle)} />
```

- `onSubmit` で実行した `set` / `insert` は、そのフォームの送信が受け持つ。失敗したら書き込みは戻り、仮の行は消える。
- ランタイムは `onSubmit` を実行したあと、束縛を同期的に反映してから送信の本文（`FormData`）を作る。キーを入れた hidden の入力欄の値が、送信に間に合うようにするため。
- TodoMVC の `add-todo` は、入力スキーマに `todoKey`（UUID の形式）を足し、サーバーはそのキーで項目を作る。同じキーの項目がすでにあれば、`ActionError(409)` を返す。
- JS がないときは、今までどおりネイティブの送信になる。

### 削除（新しい API なし）

TodoMVC の行の Signal に `removed: false` を足し、`<li>` に `bindShow(r.removed.not())` を付ける。削除ボタンは `on.click([r.removed.set(true), remove.call({ todoKey: todo.key })])` にする。失敗すれば `removed` が自動で `false` に戻り、行が戻る。成功すれば、Live View の更新で行そのものが消える。

### セキュリティ

- テンプレートは初期 HTML の、Live View の外にあるものだけを使う。断片の中の `<template>` は今までどおり DOMPurify が取り除く。
- クライアントが作ったキーは、サーバーが形式を検査し、重複を拒否する。
- `insert` の値は `JsonValue` として評価し、`data-hs-item` に JSON で入れる。表示は束縛を通るので、出力先は `textContent` と、許可した属性に限られる。
- 知らないテンプレート ID の `insert` は無視する。

## 決まっていること

- 方式 A。確定した一覧は Live View が持つ。
- 削除は今の Signal で書く。
- フォームに `onSubmit` を足す。
- 仮の行と確定した行は、ブラウザが作って Action で送るキーで対応させる。
- 挿入先は、項目が実際に入る一覧にだけ置く（アプリの責任）。

## 実装する人に任せること

- `["$item", field]` を、要素ごとの読み取りで解決する具体的な方法。
- 仮の行を取り除く時点の判定を、Live View ごとの morph の記録で行う方法。
- 仮の行の見た目（TodoMVC では `data-hs-pending-item` に CSS で薄い表示を付ける程度でよい）。
