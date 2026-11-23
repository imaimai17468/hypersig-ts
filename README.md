# hypersig-ts

TypeScript 製のフロントエンドフレームワークを開発するリポジトリです。

[日本語ドキュメント](https://imaimai17468.github.io/hypersig-ts/ja/) · [English documentation](https://imaimai17468.github.io/hypersig-ts/)

## セットアップ

```sh
mise install
mise exec -- bun install --frozen-lockfile
```

mise をシェルで有効にしていない場合は、各コマンドの前に `mise exec --` を付けてください。

## 開発コマンド

| コマンド             | 内容                                 |
| -------------------- | ------------------------------------ |
| `bun run check`      | フォーマット、lint、型をまとめて検査 |
| `bun run format:fix` | フォーマットを修正                   |
| `bun run typecheck`  | TypeScript の型を検査                |
| `bun run test`       | Vitest と jsdom でテストを実行       |
| `bun run test:watch` | ファイル変更時にテストを再実行       |
| `bun run build`      | ESM と型定義を `dist/` に出力        |

Hono アダプターを含む公開 API は `src/index.ts` からエクスポートします。`hypersig-ts/core` では、レンダラーと通信を差し替えられる実行モデルを公開します。ESM の相対インポートには、ビルド後に解決できるよう `.js` 拡張子を使います。

## 開発ルール

`bun run check` は、危険な型操作、未処理の Promise、循環インポート、テストに残った `.only` などを検出します。ルールは `vite.config.ts` の `lint` に定義しています。

共通の開発方針と作業別ルールへのリンクは [AGENTS.md](AGENTS.md) にあります。Claude Code は [CLAUDE.md](CLAUDE.md) から共通方針を読み込み、編集するファイルに応じて [.claude/rules/](.claude/rules/) のルールを適用します。

## Counter 実証

```sh
mise exec -- bun run example:counter
```

`http://127.0.0.1:3000` を 2 つのタブで開き、片方で **Increment main** を押すと、両方の共有カウンターに反映されます。別セッションで試す場合は、片方をプライベートウィンドウで開いてください。独立カウンターは別の Topic を購読しています。

`http://127.0.0.1:3000/nested` では、親の View から子の Counter を表示・非表示にできます。子の購読は表示中だけ有効です。**Move counter** で親だけを再描画し、子の購読と DOM を保ったまま移動できます。

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

## Phase 4 の性能計測

`mise exec -- bun run bench:phase4` で、更新境界の粒度を変えて SSR、SSE、DOM 反映時間、同時接続時のメモリを比較できます。[再現手順と計測結果](bench/README.md) に既定の条件と生データを記録しています。

## Void 統合

[Void サンプル](examples/void/README.md) で、Hono の型付きルート、開発時の SSR 再読み込み、Node 向けビルドと SSE を試せます。Void の依存関係はサンプル側でインストールします。

[Workers サンプル](examples/void/worker/README.md) では、同じカウンターを SQLite-backed Durable Object に載せ、共有状態と再起動後の SSE 再同期を確認できます。
