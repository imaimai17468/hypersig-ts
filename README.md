# hypersig.ts

hypersig.ts は、サーバーで確定したデータに画面を同期する TypeScript の Web フレームワークです。初回の表示も更新時の HTML もサーバーで生成し、ハイドレーションはしません。

- アプリが保存後に変更を通知すると、その通知を受け取るよう指定した表示（Live View）だけを描画し、開いているブラウザに SSE で送ります。再接続時はサーバーの現在の状態を読み直します。
- ブラウザだけで決まる状態は Signal で書きます。式はデータとして HTML の属性に入り、ブラウザのランタイムが評価します。アプリのコードはブラウザに送りません。
- 画面は操作にすぐ反応し（処理中の表示、ブラウザだけで決まる Signal）、データはサーバーが確定してから表示します。
- ブラウザが扱う文字列（Action 名、フォームの項目名、変更通知、Live View のキー、Signal の名前と式、カスタム要素のタグ名・属性名・イベント名、ページへのリンク）は型から作るので、打ち間違いは型エラーになります。
- 入力欄の `required` や `maxlength` などの制約属性は、入力スキーマの JSON Schema 変換から `action.control()` で作れます。

Hono アプリには `hypersig-ts` のアダプターを使います。同じ Hono アプリを Void に組み込むこともできます。描画と通信を自分で組み合わせる場合は `hypersig-ts/core` を使います。

カスタム要素の宣言と、ブラウザ側の実装 `defineElement` は `hypersig-ts/element` にあり、Hono にも React にも依存しません。React の部品を要素として載せる `reactElement` は `hypersig-ts/react` にあり、`react` と `react-dom`（^19）が必要です。

[日本語ドキュメント](https://imaimai17468.github.io/hypersig-ts/ja/) · [English documentation](https://imaimai17468.github.io/hypersig-ts/)

## セットアップ

mise を使って、リポジトリが指定する Bun と Node を用意します。

```sh
mise install
mise exec -- bun install --frozen-lockfile
```

## サンプルを動かす

```sh
mise exec -- bun run example:counter
```

`http://127.0.0.1:3000` を2つのタブで開き、片方で **Increment main** を押すと、両方のカウンターが更新されます。[Counter の実装](examples/counter/server.tsx)

| サンプル                                    | 起動コマンド                            | 見どころ                                                                             |
| ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| [TodoMVC](examples/todomvc/server.tsx)      | `mise exec -- bun run example:todomvc`  | 押した操作がすぐ処理中として表示され、値は確定してから変わる                         |
| [共有メモ](examples/shared-memo/server.tsx) | `mise exec -- bun run example:memo`     | 編集元の版と下書きの復元を、手書きの JavaScript なしで書く                           |
| [星評価](examples/rating/server.tsx)        | `mise exec -- bun run example:rating`   | カスタム要素の属性とイベントを型で書き、Live View の更新で子を残す                   |
| [並べ替え](examples/sortable/server.tsx)    | `mise exec -- bun run example:sortable` | React と dnd-kit の部品をカスタム要素として載せ、並べ替えを保存する                  |
| [部品](examples/widgets/server.tsx)         | `mise exec -- bun run example:widgets`  | コンボボックス、タブ、開閉パネル、文字数カウンター、トーストを Signal の文だけで書く |

Counter と同時に起動する場合は、どちらかに `PORT=3001` を設定します。[Void での起動手順](examples/void/README.md) · [Workers への配備例](examples/void/worker/README.md)

## 開発コマンド

mise をシェルで有効にしていない場合は、コマンドの前に `mise exec --` を付けます。

| コマンド               | 内容                                                 |
| ---------------------- | ---------------------------------------------------- |
| `bun run format:fix`   | フォーマットを修正                                   |
| `bun run check`        | フォーマット、lint、型を検査                         |
| `bun run test`         | Vitest と jsdom でテストを実行                       |
| `bun run test:browser` | サンプルを起動し、Playwright で操作して確かめる      |
| `bun run test:outbox`  | 共有メモの SQLite Outbox を検証                      |
| `bun run build`        | ESM、型定義、ブラウザ用 JavaScript を `dist/` に出力 |

ブラウザテストを初めて動かすときは、`mise exec -- node node_modules/@playwright/test/cli.js install chromium` で Chromium を入れます。

[開発ルール](AGENTS.md) · [設計の詳細](docs/architecture.md) · [性能計測と再現手順](bench/README.md)
