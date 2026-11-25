# hypersig.ts

[English](README.md)

hypersig.ts は、サーバーが描いた画面を、保存されたデータといつも同じに保つ TypeScript の Web フレームワークです。

- データを保存して変更を知らせると、その変更に関わる部分（Live View）だけをサーバーが描き直し、開いているすべてのタブに SSE で届けます。
- ブラウザに送るのは HTML と小さなランタイムだけで、アプリのコードは送りません。ハイドレーションもありません。
- Action の名前、フォームの項目名、Live View のキーなど、ブラウザが読む名前は型から作るので、打ち間違いは型エラーになります。

アプリは Hono で書き、Node、Bun、Cloudflare Workers で動かせます。[Void](https://void.cloud/) を使う場合は、同じ Hono アプリをミドルウェアから組み込めます（[Void のサンプル](examples/void/README.md)）。

| パッケージ            | 内容                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `hypersig-ts`         | Hono のアダプター                                                           |
| `hypersig-ts/core`    | 描画と通信を自分で組み合わせるための中核                                    |
| `hypersig-ts/element` | カスタム要素の宣言と、ブラウザ側の実装（Hono にも React にも依存しない）    |
| `hypersig-ts/react`   | React の部品をカスタム要素として載せる（`react` と `react-dom` ^19 が必要） |
| `hypersig-ts/redis`   | Redis の Pub/Sub でプロセスの間に発行を届ける（クライアントはアプリが渡す） |

[日本語ドキュメント](https://imaimai17468.github.io/hypersig-ts/ja/) · [English documentation](https://imaimai17468.github.io/hypersig-ts/) · [htmx からの移行](https://imaimai17468.github.io/hypersig-ts/ja/from-htmx/)

> **安定性:** 0.x の間は、マイナーバージョンでも互換性のない変更が入ることがあります。[CHANGELOG](CHANGELOG.md) を確認してください。

## インストール

```sh
npm install hypersig-ts hono
```

ESM のみで、Node `^22.22.2 || ^24.15.0 || >=26.0.0` または Bun で動きます。

## クイックスタート

開いているすべてのタブで値が更新されるカウンターです。入力の検証には [Standard Schema](https://standardschema.dev/) に対応したライブラリを使います。この例では Valibot（`npm install valibot`）を使います。

```tsx
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  errorOutlet,
  topic,
} from "hypersig-ts";
import * as v from "valibot";

const counterChanged = topic("counter", () => "main");
let count = 0;

const hypersig = createHypersig({
  origin: "http://localhost:3000",
  pubsub: createMemoryPubSub<ReturnType<typeof counterChanged>>(),
  // 実際のセッションの読み取りに置き換え、セッションごとに別の id を返します。
  authenticate: () => ({ sessionId: "demo" }),
});

const increment = hypersig.action("increment", {
  input: v.object({}),
  output: v.number(),
  authorize: () => true,
  async execute() {
    count += 1;
    await hypersig.publish(counterChanged());
    return count;
  },
});

const counter = hypersig.live({
  name: "counter",
  subscribe: () => [counterChanged()],
  authorize: () => true,
  load: () => count,
  render: (value) => (
    <p>
      <output>{value}</output>
      <button type="button" {...increment.bind({})}>
        Increment
      </button>
    </p>
  ),
});

const app = new Hono();
app.route("/", hypersig.routes);
app.get("/runtime.js", async (c) =>
  c.body(
    await readFile(new URL(import.meta.resolve("hypersig-ts/runtime.js"))),
    {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    }
  )
);
app.get("/", (c) =>
  hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Counter</title>
        {page.runtime("/runtime.js")}
      </head>
      <body>
        {page.view(counter, {})}
        <p role="status" {...connectionStatusOutlet()}></p>
        <p role="alert" {...errorOutlet()}></p>
      </body>
    </html>
  ))
);

export default app;
```

`export default app` で Bun が配信します。Node では `@hono/node-server` の `serve()` に `app` を渡します。すべての Action はリクエストの `Origin` ヘッダーを `origin` と照合するので、`origin` にはブラウザが使う公開オリジンを設定します。あるタブで **Increment** を押すと、すべてのタブの値が更新されます。セッション、フォーム、Signal、配備については[はじめる](https://imaimai17468.github.io/hypersig-ts/ja/start/)と [API リファレンス](https://imaimai17468.github.io/hypersig-ts/ja/reference/)を参照してください。

## リポジトリのセットアップ

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

| サンプル                                    | 起動コマンド                                                               | 見どころ                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [TodoMVC](examples/todomvc/server.tsx)      | `mise exec -- bun run example:todomvc`                                     | 押した操作がすぐ処理中として表示され、値は確定してから変わる                                                                           |
| [共有メモ](examples/shared-memo/server.tsx) | `mise exec -- bun run example:memo`                                        | 編集元の版と下書きの復元を、手書きの JavaScript なしで書く                                                                             |
| [レビュー](examples/rating/server.tsx)      | `mise exec -- bun run example:rating`                                      | カスタム要素の属性とイベントを型で書き、Live View の更新で子を残す                                                                     |
| [並べ替え](examples/sortable/server.tsx)    | `mise exec -- bun run example:sortable`                                    | React と dnd-kit の部品をカスタム要素として載せ、並べ替えを保存する                                                                    |
| [部品](examples/widgets/server.tsx)         | `mise exec -- bun run example:widgets`                                     | コンボボックス、タブ、開閉パネル、文字数カウンター、トーストを Signal の文だけで書き、お気に入りボタンで自分の操作を未確定のまま見せる |
| [Void](examples/void/README.md)             | `cd examples/void && mise exec -- bun install && mise exec -- bun run dev` | 同じ Hono アプリを Void のミドルウェアから組み込み、Workers にも配備する                                                               |

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

## ライセンス

[ISC](LICENSE)

[開発ルール](AGENTS.md) · [設計の詳細](docs/architecture.md) · [性能計測と再現手順](bench/README.md)
