# hypersig.ts

TypeScript 製のフロントエンドフレームワークを開発するリポジトリです。

[日本語ドキュメント](https://imaimai17468.github.io/hypersig-ts/ja/) · [English documentation](https://imaimai17468.github.io/hypersig-ts/)

## セットアップ

```sh
mise install
mise exec -- bun install --frozen-lockfile
```

mise をシェルで有効にしていない場合は、各コマンドの前に `mise exec --` を付けてください。

## 開発コマンド

| コマンド              | 内容                                 |
| --------------------- | ------------------------------------ |
| `bun run check`       | フォーマット、lint、型をまとめて検査 |
| `bun run format:fix`  | フォーマットを修正                   |
| `bun run typecheck`   | TypeScript の型を検査                |
| `bun run test`        | Vitest と jsdom でテストを実行       |
| `bun run test:outbox` | 共有メモの SQLite Outbox を検証      |
| `bun run test:watch`  | ファイル変更時にテストを再実行       |
| `bun run build`       | ESM と型定義を `dist/` に出力        |

Hono アダプターを含む公開 API は `hypersig.ts` からエクスポートします。`hypersig.ts/core` では、レンダラーと通信を差し替えられる実行モデルを公開します。ESM の相対インポートには、ビルド後に解決できるよう `.js` 拡張子を使います。

## 開発ルール

`bun run check` は、危険な型操作、未処理の Promise、循環インポート、テストに残った `.only` などを検出します。ルールは `vite.config.ts` の `lint` に定義しています。

共通の開発方針と作業別ルールへのリンクは [AGENTS.md](AGENTS.md) にあります。Claude Code は [CLAUDE.md](CLAUDE.md) から共通方針を読み込み、編集するファイルに応じて [.claude/rules/](.claude/rules/) のルールを適用します。

## Counter 実証

```sh
mise exec -- bun run example:counter
```

`http://127.0.0.1:3000` を 2 つのタブで開き、片方で **Increment main** を押すと、両方の共有カウンターに反映されます。別セッションで試す場合は、片方をプライベートウィンドウで開いてください。独立カウンターは別の Topic を購読しています。

`http://127.0.0.1:3000/nested` では、親の View から子の Counter を表示・非表示にできます。子の購読は表示中だけ有効です。**Move counter** で親だけを再描画し、子の購読と DOM を保ったまま移動できます。

`http://127.0.0.1:3000/order` は、注文明細と合計を同じスナップショットから一つの Live View で更新する実証です。`ORDER_PRICE_DELAY_MS=120` を指定すると、集計を待つ間も二つの表示が同じ版に揃うことを確認できます。

サンプルの [server.tsx](examples/counter/server.tsx) に、Hono JSX の SSR、型付き Action、Live View、Topic の定義があります。サンプルの値とセッションはメモリに置いているため、サーバー再起動でリセットされます。利用側は `app.route("/", hypersig.routes)` でルートをマウントする前に Action を登録し、ビルド出力の `dist/runtime.js` を同一オリジンで配信します。

```sh
mise exec -- node node_modules/@playwright/test/cli.js install chromium
mise exec -- bun run test:browser
```

調査結果、API の選択、実測値、実証の範囲は [Counter 実証の設計](docs/architecture.md) にまとめています。

## TodoMVC 実証

```sh
mise exec -- bun run example:todomvc
```

`http://127.0.0.1:3000` を複数のタブやブラウザで開くと、一つのリストを共有できます。追加・編集・完了・削除に加え、全件の完了と再開、完了済みの一括削除、All / Active / Completed の絞り込みを試せます。全セッションが同じリストにアクセスでき、サーバー再起動でリセットされるローカル実証です。Counter と同時に起動する場合は、どちらかに `PORT=3001` を設定してください。

画面と Action は [TodoMVC の server.tsx](examples/todomvc/server.tsx) にあります。入力欄のリセットには `action.form({ resetOnSuccess: true })` を使います。HTTP 成功後にフォームを初期値へ戻し、送信してから入力・変更した値は保持します。

## 共有メモの検証

```sh
mise exec -- bun run example:memo
```

`http://127.0.0.1:3000` を2つのタブで開きます。両方で本文を書き換え、片方だけ保存すると、もう片方でも共有中のメモが SSE で更新され、編集中の下書きは残ります。古い版から保存するとサーバーが HTTP 409 を返します。**最新版を読み込む**を押すと下書きと編集元の版が入れ替わり、そこから再編集できます。下書きの内容を残したい場合は、読み込む前にコピーしてください。

共有中のメモだけが Live View です。自分の保存に成功すると、フォームの編集元がサーバーから返った版に進み、そのまま追記できます。別のタブによる更新や通信失敗では編集元と下書きを維持します。競合時は理由と復旧手順をフォーム内に表示します。JavaScript を無効にしても通常の HTML フォームで保存でき、入力エラーや競合時にはサーバーが下書き付きの HTML を返します。

デモの SQLite は既定でメモリ上に置きます。`MEMO_DB=/path/to/memo.sqlite` を指定すると、メモと配送待ち通知を再起動後も保持できます。`HYPERSIG_TRACE=1` を指定すると、サーバー側で Topic 発行、購読による無効化、描画の診断イベントを確認できます。[実装](examples/shared-memo/server.tsx)

サーバー再起動後の下書き復旧を試すには、SQLite ファイルに加えて同じ `MEMO_SESSION_SECRET`（32文字以上）を再起動前後で使います。二つのタブで片方だけ保存し、もう片方に未保存の下書きを残した状態でサーバーを再起動すると、公開中の最新版と元の版に基づく下書きを同時に確認できます。

復元された下書きには通知が表示されます。公開版が進んでいれば、本文を見比べたうえで **表示中の版から編集を続ける** を選べます。編集元の版だけが切り替わり、下書きの本文は残ります。公開するには保存が必要で、表示後にさらに別の変更が入った場合はサーバーが競合を返します。

保存の応答が届かなかった場合は、同じ入力のまま **保存** を押し直せます。最初の保存が確定済みなら、操作 ID でその結果を確認します。

`action.form({ reportSuccess: true })` を使うと、成功レスポンスの取得後にフォームから `hypersig:action-success` が発火します。`detail.data` にサーバーで出力検証済みの値が入ります。リスナーは `resetOnSuccess` によるフォームのリセットより先に実行されます。共有メモでは編集元の更新に使い、公開した本文は SSE で反映します。

通知の復旧、HTML フォームとの連携、接続間の描画共有については [設計と利用条件](docs/architecture.md#通知の診断と復旧) にまとめています。

## Phase 4 の性能計測

`mise exec -- bun run bench:phase4` で、更新境界の粒度を変えて SSR、SSE、DOM 反映時間、同時接続時のメモリを比較できます。[再現手順と計測結果](bench/README.md) に既定の条件と生データを記録しています。

## Void 統合

[Void サンプル](examples/void/README.md) で、Hono の型付きルート、開発時の SSR 再読み込み、Node 向けビルドと SSE を試せます。Void の依存関係はサンプル側でインストールします。

[Workers サンプル](examples/void/worker/README.md) では、同じカウンターを SQLite-backed Durable Object に載せ、共有状態と再起動後の SSE 再同期を確認できます。
