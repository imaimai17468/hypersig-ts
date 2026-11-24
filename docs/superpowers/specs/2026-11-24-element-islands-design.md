# カスタム要素をブラウザ側でも型で書き、アイランドを載せる設計

## 目的

hypersig.ts のブラウザで動くのは、ランタイムが解釈する Signal の文と式だけで、アプリのコンポーネントはブラウザに届かない。ドラッグ＆ドロップ、エディタ、グラフ、日付ピッカーのように任意の JavaScript が要る部品は、`customElement()` で宣言したカスタム要素に包むしかない。今は次の 2 つが欠けている。

- 要素の JavaScript が型で守られていない。星評価のサンプル（`examples/rating/rating.js`）は、タグ名 `"star-rating"`、属性名 `"value"`、イベント名 `"rate"` を手で書いている。サーバー側の宣言は TS の型の中にしかなく、ブラウザ側と突き合わせる手段がない。AGENTS.md の Thesis（ブラウザが扱う文字列は型から作る）が、ここだけ破れている。
- React などの既存の部品を載せる公式の手段がない。完成品（並べ替え、エディタ、表、グラフ）を Web Components に書き直すのはアプリの負担が大きすぎる。

一つの宣言をサーバーとブラウザの両方から import し、ブラウザ側の実装も型で縛る。そのうえで、ライブラリに依存しない土台と、その上の React アダプターを用意する。

## 合格の基準

- 星評価のサンプルが、タグ名・属性名・イベント名を一度も手で書かずに動く（宣言から作る）。
- 宣言にない属性やイベントをブラウザ側の実装で使うと型エラーになる。`emit` の `detail` の型が宣言と違っても型エラーになる。
- React の部品を、数行でカスタム要素として登録できる。
- Live View の更新で JSON の属性が変わると、アイランドの部品が新しい値で描き直される。部品の内部の状態（フォーカス、スクロール位置、ドラッグ中の状態）は残る。
- React を使うサンプルが、ブラウザテストで並べ替えと保存を確かめられる。
- `hypersig.ts/element`（ブラウザ用の入口）は Hono を読み込まない。React を使わないアプリの依存に React が入らない。

## 目的にしないこと

- アイランドの SSR（React の部品をサーバーで描くこと）。サーバーはカスタム要素の殻と、アプリが置いた仮の子（読み込み中の表示など）だけを描く。
- React 以外（Svelte、Vue など）のアダプター。土台はそれらを載せられる形にするが、作るのは React だけ。
- アプリのブラウザ用 JavaScript のビルド設定をライブラリが持つこと。ビルドはアプリが選ぶ（サンプルは `bun build`）。
- Signal の文と式を増やすこと（キーボードのイベント、文字列の操作など）。別の設計で扱う。
- Shadow DOM。子は今と同じく light DOM に描く。

## やってはいけないこと

- ランタイム（`dist/runtime.js`）がアプリの要素の JavaScript を読み込んだり実行したりすること。要素の JavaScript はアプリが読み込む。
- タグ名、属性名、イベント名をアプリが文字列で二度書くこと。
- サーバーから届いた HTML に含まれる値で、要素の JavaScript が任意のコードを実行できるようになること（JSON の属性は `JSON.parse` するだけ）。

## 検討した方式

| 方式                                                      | 判断                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| a. ライブラリに依存しない土台 + その上の React アダプター | **採用**（利用者が選んだ）。素の JS で書いた要素も同じ型の境界で縛れる。React 用は土台の上の薄い層で済む              |
| b. React 専用のアダプターだけ                             | 不採用。素の JS の要素の穴が残り、ほかのライブラリを使うときに作り直しになる                                          |
| JSX をブラウザでも動かす（クライアントコンポーネント）    | 不採用。「アプリのコードはブラウザに送らない」原則と、ハイドレーションなし・小さいランタイム・厳しい CSP の前提を崩す |

## 設計

### 宣言を実行時の値にする

属性名と型、イベント名を値として持たせ、型はその値から推論する。

```ts
// examples/rating/elements.ts（サーバーとブラウザの両方が import する）
import { customElement, event } from "hypersig.ts/element";

export const rating = customElement("star-rating", {
  attributes: { value: "number", max: "number" },
  events: { rate: event<number>() },
  ownsChildren: true,
});
```

- 属性の型は `"string"`、`"number"`、`"boolean"`、`"json"` の 4 つ。`"json"` の値の型は `json<T extends JsonValue>()` で指定する（`attributes: { items: json<Item[]>() }`）。`"json"` と書いたときは `JsonValue`。
- イベントは `event<Detail extends JsonValue>()` で、`detail` の型だけを持つ（実行時は名前だけを使う）。
- 属性名とイベント名の検査は今の規則をそのまま使う（`on*`、`style`、`id`、`data-hs-*` を拒否、`click`、`input`、`change`、`submit` を拒否、タグ名の規則）。型で検査できるものは型で、残りは `customElement()` を呼んだときに例外にする。
- これまでの `customElement<Spec>(tag, { ownsChildren })` の書き方はなくす。`Spec` を明示するとタグのリテラルを推論できない、という今の制約もなくなる。

### 入口と分け方

- `hypersig.ts/element`（新しい入口、ブラウザでもサーバーでも読める）：`customElement`、`event`、`json`、`defineElement`、宣言の型。Hono も DOM の外の依存も読み込まない。`defineElement` は DOM の API を使うが、import しただけでは DOM に触れない。
- `hypersig.ts`（今の入口）：宣言に対するサーバー側の操作。`rating.Element`（今の `Element`）と `rating.on(...)`（今の `on`）、`scope.bindElement(rating, ...)` は今と同じ書き方で使えるようにする。Hono の JSX に依存する部分はこちらに置く。宣言の値と、サーバー側の操作をどう結び付けるか（宣言にメソッドを生やすか、`hypersig.ts` 側の関数に宣言を渡すか）は実装で決める。どちらでも `hypersig.ts/element` が Hono を読み込まないことを守る。
- `hypersig.ts/react`（新しい入口）：React アダプター。`react` と `react-dom` は optional の peerDependency。
- `customElement`、`event`、`json` は `hypersig.ts/element` から export し、`hypersig.ts` からも同じものを再 export する。古い `customElement<Spec>(tag, options)` は残さず、サンプル、テスト、ドキュメントを書き直す（未公開の 1.0.0 なので互換は保たない）。
- `hypersig.ts/element` は DOM のない環境（サーバー）で import しても壊れない。`HTMLElement` を継承するクラスは `defineElement` を呼んだときに作る。`package.json` の `build` の最後にある Node での import の確認に、`hypersig.ts/element` を足す。
- React のファイル（`src/react.tsx`、サンプルのブラウザ用ファイル、その型テスト）は、ファイルごとの `/** @jsxImportSource react */` で React の JSX を使う。リポジトリ全体の `jsxImportSource: "hono/jsx"` は変えない。

### `ownsChildren` の要素の `id`

今の morph は、タグ、`data-hs-owns-children`、`id` が一致したときだけ子を自分で描く要素を残す（`src/signal-runtime.ts` の `keepsChildren`）。`id` がないと Live View の更新のたびに要素が作り直され、`unmount` → `mount` で部品の内部の状態が消える。そこで `ownsChildren: true` の宣言の `Element` は `id` を必須の props にする（型で強制する）。`id` の値はアプリが決める（一覧なら行ごとに一意にする）。

### 属性の値の形式

- `string`、`number`、`boolean` は今の規則のまま（`boolean` は空の属性か属性なし。`aria-*`、`data-*` などは `"true"` / `"false"`。規則は `src/protocol.ts` の `rendersBooleanAsText` を共有する）。
- `json` は `JSON.stringify` した文字列を属性に書く。サーバー側の `Element` の props、`bindElement`（Signal の値）、ランタイムの書き込みのどれも同じ形式にする。ランタイムは値が変わらない属性を書かない今の動きを、JSON の属性でも同じ文字列かどうかで判定する。
- ブラウザ側の読み取り（`defineElement` が `props` を作るとき）は、宣言の型で変換する。`number` が数にならない、`json` が JSON として読めない、のように変換できない属性は、その属性がないものとして扱う。属性がないときの値は、宣言に既定値を持たせず `undefined` として `props` に渡す（`props` の各項目は省略可能な型になる）。

### ライブラリに依存しない土台

```ts
defineElement(rating, {
  mount(host, props, emit) {
    // host: HTMLElement、props: { value?: number; max?: number }
    // emit("rate", 3) の名前と detail は宣言で検査する
    return {
      update(props) {
        /* 属性が変わったとき */
      },
      unmount() {
        /* 要素が外されたとき */
      },
    };
  },
});
```

- `defineElement` は宣言のタグ名で `customElements.define` を呼ぶ。同じタグが定義済みなら例外にする。
- `observedAttributes` は宣言の属性名から作る。
- `connectedCallback` で `mount` を呼び、`attributeChangedCallback` では同じタスクの中の変更をまとめて、マイクロタスクで一度だけ `update` を呼ぶ（Live View の morph で複数の属性が同時に変わるため）。`disconnectedCallback` で `unmount` を呼ぶ。切り離してから同じ要素を挿し直したら、もう一度 `mount` する。
- `emit(name, detail)` は `bubbles: false` の `CustomEvent` を発火する。ランタイムの `data-hs-on-custom` のリスナーがそれを受ける。
- `ownsChildren: true` の宣言では、`mount` は `host` の子を自由に描ける。SSR で置いた仮の子は `mount` が消してよい。`ownsChildren: false` の宣言で子を描くと Live View の更新で消える、という今の注意をドキュメントに残す。

### React アダプター

```ts
import { reactElement } from "hypersig.ts/react";
reactElement(sortableList, SortableList);
// SortableList: (props: { items?: Item[]; emit: Emit<...> }) => ReactNode
```

- `reactElement(declaration, Component)` は `defineElement` の上に作る。`mount` で `createRoot(host)` を作り、`update` で同じ root に描き直し、`unmount` で `root.unmount()` する。描き直しは同じ root への `render` なので、部品の内部の状態は残る。
- 部品の props は、宣言の属性の型と `emit` を合わせたもの。部品の型が合わなければ型エラーにする。
- `ownsChildren: false` の宣言を渡すと型エラーにする（React が子を描くので）。

### JSON の属性と Live View

- Live View の `render` の中で `<list.Element items={todos} />` のように書くと、サーバーが JSON の属性を描く。Topic の更新で Live View が描き直されると属性が変わり、morph が残した要素の `attributeChangedCallback` → `update` に届く。
- `ownsChildren` の要素で「`data-hs-element-attr` に書かれた属性はサーバーの HTML から写さない」という今の規則は、Signal で束縛した属性にだけ当てはまる。サーバーが固定の値として描いた JSON の属性は、今のほかの属性と同じく写す。
- JSON の属性の大きさに上限は設けないが、ドキュメントで「一覧の行数が多いときは Live View ごと更新されるので、更新境界を小さくする」ことを、既存の性能の説明と合わせて書く。

### サンプル

- **星評価（書き直し）**：`examples/rating/elements.ts` に宣言を置き、`rating.js` を `rating.ts` にして `defineElement` で書く。ブラウザ用のファイルは `bun build` で作って配る。タグ名・属性名・イベント名の手書きをなくす。
- **並べ替えできる一覧（新規、React）**：`examples/sortable/`。React と dnd-kit（`@dnd-kit/core`、`@dnd-kit/sortable`）で作った並べ替えできる一覧を `reactElement` で登録する。Live View が一覧を JSON の属性で渡す。並べ替えたら `emit("reorder", keys)` → Action で保存 → Topic を発行 → ほかのタブの Live View が新しい順で描き直す。キーボードでの並べ替え（dnd-kit の KeyboardSensor）も使えるようにする。依存の版は、使う時点で公開から 2 週間以上たった版に固定する。
- 並べ替えた直後の表示（利用者が選んだ）：手を離した位置を、処理中として薄く表示したまま残す。確定した並びが Live View の JSON の属性で届いたら、そちらに置き換えて処理中の表示を消す。保存が失敗したら、サーバーの並び（今の属性の値）に戻す。確定前の並びを見せるのは、利用者が自分で動かした結果を処理中として示すためで、ほかの人の変更やサーバーが決める値を先に見せるものではない。`docs/architecture.md`「確定してから表示する」に、この区別を書き足す。
- 失敗の伝え方：フレームワークに API を足さない。Action の `call` の `onError` で Signal（たとえば失敗の回数）を書き換え、その Signal を `bindElement` で部品の属性に渡す。部品は属性が変わったら手元の並びを捨てる。
- ドラッグ中に別のタブの更新が届いたとき：部品の中で、ドロップするまで新しい `items` の反映を待つ。フレームワークの `update` は今までどおり属性が変わるたびに呼ぶ。
- ルートの `package.json` に `example:sortable` を足し、`playwright.config.ts` にプロジェクトを足す。

### ドキュメント

- `docs/architecture.md` の「カスタム要素」の節を、宣言の値、入口の分け方、`defineElement`、JSON の属性、React アダプターに書き換える。「宣言と要素の JavaScript の突き合わせはしない」という記述は、`defineElement` を使う場合には型で突き合わせる、に直す。`defineElement` を使わずに素の `customElements.define` で書いた要素は今までどおり突き合わせない、と書く。
- サイトの英語版と日本語版（reference、concepts、limits）に、アイランドの書き方と、できないこと（SSR しない、Shadow DOM を使わない）を書く。
- `README.md` のサンプルの表に並べ替えのサンプルを足す。
- ランタイムの大きさの表に、JSON の属性の対応で増えた分を足す（`docs/architecture.md`「ランタイムの大きさ」と同じ測り方）。

## テスト

- 型のテスト：`ownsChildren: true` の宣言の `Element` に `id` を渡さないと型エラー。宣言から推論した `props` と `emit` の型。宣言にないイベント名や違う型の `detail` を `emit` すると型エラー。React の部品の props が宣言と合わないと型エラー。`ownsChildren: false` の宣言を `reactElement` に渡すと型エラー。
- `defineElement`（jsdom）：`mount` → 属性の変更で `update`（同じタスクの複数の変更が一度にまとまる）→ 切り離しで `unmount` → 挿し直しで再 `mount`。変換できない属性は `undefined`。同じタグの二重定義は例外。
- JSON の属性：サーバーの `Element` と `bindElement` の出力が同じ形式。ランタイムが同じ JSON 文字列を書き直さない。
- morph：`ownsChildren` の要素で、サーバーが描いた JSON の属性は写り、Signal で束縛した属性は写らない（今の規則の延長）。
- ブラウザテスト：星評価のサンプルが今のテストのまま通る。並べ替えのサンプルで、マウスとキーボードで並べ替えて保存し、別のタブに新しい順で届く。並べ替えの途中で別のタブの更新が届いても、ドラッグ中の状態が壊れない。

## 実装に任せること

- 宣言の値とサーバー側の操作（`Element`、`on`）の結び付け方。
- `json<T>()` と `event<T>()` の実行時の表現（目印のオブジェクトなど）。
- `attributeChangedCallback` の変更をまとめる方法の細部。
- サンプルの見た目、dnd-kit の設定の細部、ブラウザ用ファイルのビルドスクリプト。
