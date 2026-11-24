# Signal の命令を増やして普段の UI を書けるようにする設計

## 目的

ブラウザで動くのは、ランタイムが解釈する Signal の文と式だけである（`src/protocol.ts` の `ExprNode` / `StmtNode`）。今のイベントは `click`、`input`、`change` とフォームの `submit`、カスタム要素のイベントだけで、式は比較・算術の一部・論理・`concat`・`if`・`get`、文は `set`・`toggle`・`focus`・`call` しかない。束縛できる属性も 8 種と `data-*` に限られる。そのため、次の普段の部品がカスタム要素なしでは書けない。

| 目標の部品                                                              | 足りないもの                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 選択式のコンボボックス（矢印キーで選び、Enter で決め、Escape で閉じる） | キー操作、`aria-activedescendant` / `aria-selected` の束縛、番号の計算 |
| タブ（矢印キーで移動）                                                  | キー操作、`tabindex` の束縛、計算した相手へのフォーカス                |
| メニューや開閉パネル（フォーカスが外れたら閉じる）                      | フォーカスの出入り                                                     |
| 文字数カウンター、入力中の簡易チェック、手元での絞り込み                | 文字列の長さ、`trim`、小文字化、`includes`                             |
| トーストの自動消去、入力のデバウンス                                    | タイマー                                                               |

基本の命令だけを足し、5 つの部品はその組み合わせで書く（利用者が選んだ方式）。部品ごとの補助関数（`combobox()` など）は作らず、サンプルを書き方の手本にする。

## 合格の基準

- 5 つの部品を、カスタム要素も手書きの JavaScript も使わずに書いたサンプルが、ブラウザテストでキーボードとマウスの両方で動く。
- 部品のサンプルで、アプリがフレームワークの属性名やイベント名を手で書かない（AGENTS.md の Thesis）。キーの名前は型で検査する。
- ランタイムの増分が gzip -9 で 4 KB 以下（`docs/architecture.md`「ランタイムの大きさ」と同じ測り方で、この設計を書いた時点の `main` と比べる）。超えたときは、`focusEnter`、`lower()` の順に削って収める。
- CSP は今と同じ `script-src 'self'` のまま動く（`eval` を使わない）。
- サーバーは今と同じく、リクエストごとの値で式を評価して初期 HTML に結果を書く（新しい式もサーバーで評価できる）。

## 目的にしないこと

- 部品の補助関数（`combobox()`、`tabs()` など）。
- ブラウザ側で配列を加工して一覧を描き直すこと（並べ替え、絞り込んだ結果の再描画、追加）。一覧は Live View が描く。手元での絞り込みは行ごとの `bindShow` で書く。
- 入力しながら候補をサーバーから取ってくるコンボボックス（検索の Live View）。選択式（候補が決まっている）だけを目標にする。
- ポインター（ドラッグ）やスクロールのイベント。必要ならアイランドで書く。
- 任意の JavaScript を名前で呼ぶ仕組み。

## やってはいけないこと

- 文や式の中に、ブラウザで任意のコードを実行できる経路を作ること。
- キーの名前やイベント名を、型で検査できない文字列のまま受け付けること（型で検査できない部分は実行時に検査し、ドキュメントに書く）。
- 既存の文や式の意味を変えること。

## 検討した方式

| 方式                                      | 判断                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. 基本の命令だけを足し、組み合わせで書く | **採用**（利用者が選んだ）。ランタイムの増分が小さく、命令ごとにテストできる                  |
| 2. 1 の上に部品の補助関数を用意する       | 不採用。公開 API が大きくなり、部品の構造の自由度が下がる。サンプルを書いたあとで再検討できる |
| 3. ブラウザに登録した関数を名前で呼ぶ     | 不採用。「アプリのコードはブラウザに送らない」原則と Thesis が崩れる                          |

## 設計

### キー操作：`on.keydown`

```ts
<div role="listbox" {...on.keydown({
  ArrowDown: [s.active.set(s.active.add(1).clamp(0, last))],
  ArrowUp: [s.active.set(s.active.sub(1).clamp(0, last))],
  Enter: [s.value.set(s.keys.at(s.active)), s.open.set(false)],
  Escape: [s.open.set(false)],
})} />
```

- キーの対応表を受け取り、`data-hs-on-keydown` に書く（属性名は `src/protocol.ts` の `eventAttributes` で一度だけ定義）。
- キーの名前は `KeyboardEvent.key` の値。型 `KeyName` は名前付きのキー（`Enter`、`Escape`、`Tab`、`" "`（スペース）、`ArrowUp`、`ArrowDown`、`ArrowLeft`、`ArrowRight`、`Home`、`End`、`PageUp`、`PageDown`、`Backspace`、`Delete`）と、1 文字のキーを受け付ける。修飾キーは `Shift+`、`Control+`、`Alt+`、`Meta+` を前に付ける（`"Shift+Tab"`）。修飾キーの並び順は型で 1 通りに決める。型で検査できない部分は、`on.keydown` を呼んだときに実行時に検査して例外にする。
- 対応表にあるキーを押したら、その文を実行し、既定の動作を止める（矢印キーのスクロールなど）。`Tab` と `Shift+Tab` だけは既定の動作を止めない（フォーカスの移動を妨げないため）。
- 対応表は `[キー, 文の一覧][]` の JSON として書く。ランタイムは今の `data-hs-on-custom` と同じく、形が正しくない組や文を無視する。
- ランタイムは `keydown` を document で委譲して受け、押した要素からいちばん近い `data-hs-on-keydown` を探す。その対応表にキーがなければ、さらに外側の対応表を探す（入れ子の部品が外側のキーを使えるようにする）。
- 修飾キーは、対応表のキーが求める修飾キーと、押された修飾キーが完全に一致したときだけ当てはまる（`Enter` は `Shift+Enter` に当てはまらない）。
- ただし、スペース以外の 1 文字のキーでは Shift を照合に使わない（どの文字に Shift が要るかはキー配列で変わるため）。`"?"` や `"A"` は Shift の有無に関わらず当てはまり、`"Shift+?"` のように Shift と 1 文字のキーを組み合わせた名前は型エラーと実行時の例外にする（文字そのものを書く）。名前付きのキーと、Control、Alt、Meta は完全に一致させる。
- IME で変換中（`isComposing`）の `keydown` と、`keyCode` が 229 の `keydown`（Safari が変換を確定する Enter）は無視する。
- 対応表を持つ要素で Action の送信が進行中なら、`click` と同じく文を実行しない（Enter の二重送信を防ぐ）。
- 子を自分で描くカスタム要素の中（`isOwnedChild`）の対応表は、今のほかのイベントと同じく無視する。

### フォーカスの出入り：`on.focusEnter` / `on.focusLeave`

- `on.focusEnter(文)`：フォーカスが要素の外から要素の中（要素自身を含む）に入ったときに走る。中での移動では走らない。
- `on.focusLeave(文)`：フォーカスが要素の中から外へ出たときに走る。中での移動では走らない。ウィンドウやタブが切り替わってページがフォーカスを失ったときは走らない（戻ったときに閉じていると困るため）。
- ランタイムは `focusin` / `focusout` を document で委譲し、`relatedTarget` と `document.hasFocus()` で判定する。`relatedTarget` が `null`（フォーカスがどこにもなくなった）のときは、ページがフォーカスを持っていれば外へ出たものとして扱う。
- マウスで中の要素を押すとフォーカスが一度 `body` に移るので、中で押される要素にはフォーカスできるようにしておく必要がある（コンボボックスの候補には `tabindex="-1"` を付ける）。サンプルとドキュメントでこの書き方を示す。
- 要素で Action の送信が進行中なら、`click` と同じく文を実行しない。

### 計算した相手へのフォーカス：`refs()`

今の `ref()` は 1 つの要素に固定の ID を付ける。タブのように「選んだ番号の要素」にフォーカスするため、キー付きの ref を足す。

```ts
const tabRefs = refs({ name: "tab" });
<button {...tabRefs.attr(key)} />;
tabRefs.focus(s.keys.at(s.active)); // 文
```

- `attr(key)` は今の `data-hs-ref` に `ID` と `key` を合わせた値を書く。`focus(keyExpr)` は式を評価して、その要素にフォーカスする。見つからなければ何もしない。
- ID の振り方は今の `ref()` と同じ（`assignId`）。

### 文字列と数と配列の式

| 式                        | 型                                          | 意味                                                                                |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `str.length()`            | `Expr<string>` → `Expr<number>`             | UTF-16 の長さ（`String.prototype.length`）。ドキュメントに書く                      |
| `str.trim()`              | `Expr<string>` → `Expr<string>`             | 前後の空白を除く                                                                    |
| `str.lower()`             | `Expr<string>` → `Expr<string>`             | `toLowerCase()`（ロケールに依らない）                                               |
| `str.includes(other)`     | `Expr<string>` → `Expr<boolean>`            | 部分文字列を含むか                                                                  |
| `num.clamp(min, max)`     | `Expr<number>` → `Expr<number>`             | 範囲内に収める                                                                      |
| `num.mod(n)`              | `Expr<number>` → `Expr<number>`             | 0 以上 n 未満の余り（端で一周させる）。`n` が 0 なら 0                              |
| `arr.at(index, fallback)` | `Expr<readonly T[]>` → `Expr<T>`            | 番号の要素。範囲外なら `fallback`（型を `T` のままにして `set` に渡せるようにする） |
| `arr.length()`            | `Expr<readonly unknown[]>` → `Expr<number>` | 要素の数                                                                            |

- どの式もサーバーとブラウザの両方の `evaluate`（`src/evaluate.ts`）で同じ結果になる。
- 型が合わない値（文字列の式に数が届くなど、ストアの値が想定と違うとき）は、今の式と同じ規則で扱う（`evaluate.ts` の既存の変換の方針に合わせ、例外にしない）。

### タイマー：`timer()`

```ts
const toastTimer = timer({ name: "toast" }); // モジュールの最上位で定義する
onSuccess: [
  toast.visible.set(true),
  toastTimer.after(3000, [toast.visible.set(false)]),
];

const draftTimer = timer({ name: "draft" });
on.input([draftTimer.after(500, [saveDraft.call({ body: e.body })])]); // デバウンス
```

- `timer({ name })` は名前付きのタイマーを作る。ID は Signal のグループと同じく `assignId` で振り、名前は `Identifier` で検査する。モジュールの最上位で定義すれば、描画をまたいで同じ ID になる。
- `t.after(ms, 文)` は文。そのタイマーの予約を取り消してから、`ms` ミリ秒後に文を実行するよう予約し直す。続けて呼ぶと、最後の呼び出しから数え直す。これがデバウンスになるので、`on.input` にデバウンスの設定は足さない。
- `t.cancel()` は文。予約を取り消す。
- 予約はページに 1 つずつ（タイマーの ID ごと）で、Live View の更新で要素が消えても取り消さない（トーストを出した要素が更新で作り直されても、トーストが消えないまま残ることを防ぐ）。
- 予約した文の中の `call` は、予約した要素がまだページにあればその要素を送信元にする（処理中の表示が付く）。ページから外れていれば `call` は送らず、ほかの文だけを実行する。この規則はドキュメントに書く。
- 時間が来たときは、予約した要素で送信が進行中でも文を実行する（デバウンスした保存が入力を取りこぼさないため）。同じ Action が並行して送られうることは、ドキュメントに書く。
- `ms` は 0 以上の整数。型は `number` で、実行時に検査する。

### 束縛できる属性

`bindableAttributes` に `aria-activedescendant`、`aria-selected`、`aria-controls`、`aria-label`、`tabindex`、`hidden` を足す。`hidden` は `disabled` / `checked` と同じく真偽値の属性（空の属性か属性なし）。`aria-selected` は今の `aria-*` の規則どおり `"true"` / `"false"` の文字列。

### サンプル

`examples/widgets/` に 5 つの部品を並べたページを作る。

- 選択式のコンボボックス（WAI-ARIA APG の select-only combobox の動き）。選んだ値は Action で保存し、Live View が確定した値を描く。
- タブ（APG の tabs、自動で切り替わる型）。roving tabindex。
- 開閉パネル（ボタンで開き、フォーカスが外れたら閉じ、Escape で閉じてボタンにフォーカスを戻す）。
- 文字数カウンターと、入力中の簡易チェック（`trim` した長さが 0 なら送信ボタンを無効にする）、手元での絞り込み（`lower` と `includes` で行の `bindShow`）。
- トースト（Action の `onSuccess` で出して、3 秒後に `timer` の `after` で消す）と、入力のデバウンス（入力が止まってから下書きを Action で保存する）。
- コンボボックスの `aria-activedescendant` と `aria-controls`、候補の `id` は、これまでのサンプル（TodoMVC の `edit-${todo.key}`）と同じくアプリが決める文字列で書く。Thesis が対象にするのはフレームワークが読む名前で、アプリの要素の `id` は含まない。

ルートの `package.json` に `example:widgets` を足し、`playwright.config.ts` にプロジェクトを足し、`README.md` のサンプルの表に足す。

### ドキュメント

- `docs/architecture.md`「ブラウザ側の Signal」に、新しいイベント、式、文、タイマーの規則、束縛できる属性を足す。「ランタイムの大きさ」に増分の行を足す。
- サイトの英語版と日本語版（reference、concepts）に、新しい API と型で検査できない部分（実行時に検査するキーの名前、`ms` の値、`length()` が UTF-16 の長さであること）を書く。

## テスト

- `on.keydown`：対応表のキーで文が走り既定の動作が止まる。`Tab` は止めない。修飾キーの完全一致。内側にないキーは外側の対応表が受ける。IME 変換中は無視。型テストで、知らないキーの名前と、修飾キーの並び順の違いは型エラー。実行時の検査で、型を通った不正な名前は例外。
- `focusEnter` / `focusLeave`：中での移動では走らない。外への移動で走る。ページがフォーカスを失ったときは走らない。
- `refs()`：計算したキーの要素にフォーカスし、見つからなければ何もしない。
- 式：表のそれぞれをサーバーの `evaluate` とブラウザのランタイムで同じ結果になることを確かめる（範囲外の `at`、`mod` の負の数と 0、空文字列の `length`）。
- タイマー：`after` が時間後に走る。同じタイマーの再実行で数え直す。`cancel` で取り消す。予約した要素が Live View の更新で消えても文は走り、そのときの `call` は送られない。入力の `after` でのデバウンスは入力が止まってから一度だけ走り、ストアへの書き込みはすぐ行われる。時間は Vitest の偽のタイマーで進める。
- 送信中の扱い：`keydown`、`focusEnter`、`focusLeave` は要素の送信中に走らない。タイマーの文は送信中でも走る。
- 束縛できる属性：`hidden` の真偽値、`tabindex` と `aria-activedescendant` の文字列、`aria-selected` の `"true"` / `"false"`。
- ブラウザテスト：サンプルの 5 つの部品をキーボードとマウスで操作する。

## 実装に任せること

- `KeyName` の型の細部（1 文字のキーの検査方法、修飾キーの並び順）。
- `focusLeave` の判定の細部。
- サンプルの見た目と構成。
