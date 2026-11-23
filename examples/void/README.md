# Void 統合実証

Void 1.11.0、Vite 8.3.8、Node 26.13.0 / Bun 1.3.1 を使う。依存関係とロックファイルはサンプルに置いている。[Void の Hono 統合](https://void.cloud/integrations/hono)

## 開発

リポジトリルートで [通常のセットアップ](../../README.md#セットアップ) を済ませてから実行する。

```sh
cd examples/void
mise exec -- bun install --frozen-lockfile
mise exec -- bun run dev
```

`http://127.0.0.1:5173` でカウンターを開く。別セッションでも Main のカウンターは同期し、Other は別 Topic を購読する。サーバー側の `app.tsx` を保存すると、Vite の開発 WebSocket 経由でページを再取得し SSE を張り直す。サンプルのカウントはメモリに置いているため、サーバーモジュールの再読み込みで初期化される。既定のセッション署名キーも再生成される。固定キーで試す場合は `SESSION_SECRET` を設定する。[Vite の開発時更新 API](https://vite.dev/guide/api-environment-plugins#the-hotupdate-hook)

Void のミドルウェアはカウンター画面、Action、SSE の元の Request を Hono アプリに渡す。`/health` は Void 自身のファイルルートとして処理する。画面リンクは Hono の `hc<typeof app>().$path()` から生成し、リクエスト時には URL の値を Valibot で検証する。[Hono の型付きパス](https://hono.dev/docs/guides/rpc#path)

## ビルドと起動

```sh
mise exec -- bun run typecheck
mise exec -- bun run build
mise exec -- bun run start
```

既定の起動先は `http://127.0.0.1:3000`。`PORT` でポートを指定できる。TLS 終端やリバースプロキシを使う場合は、`PUBLIC_ORIGIN` にブラウザから見える公開オリジンを設定する。Action の Origin はこの値と照合される。

起動エントリは `dist/ssr/index.js`。サーバー成果物と `dist/client/assets/hypersig-runtime.js` を一緒に置き、サンプルの本番依存関係を Node から解決できる状態で実行する。Void の Node 出力が配信する `/assets/*` に合わせ、ビルドがブラウザランタイムを配置する。[Void の Node.js ターゲット](https://void.cloud/integrations/nodejs-bun-deno)

```sh
mise exec -- bun run test
```

Playwright で開発サーバーと本番ビルドの両方を試す。ルートで Chromium のインストールを済ませておく。

## 統合先の評価

- **単一の Node プロセス**で、Void の SSR、静的アセット配信、Action、SSE を Chromium から検証した。アプリの CLI 操作には Vite、Void、Bun の既存コマンドを使う。
- **Cloudflare Workers**では、異なる入口 Worker を一つの SQLite-backed Durable Object に接続し、状態の確定、配信、再起動後の復元をローカルで確認した。[Workers サンプル](worker/README.md)
