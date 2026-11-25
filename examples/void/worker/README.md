# Workers と Durable Object の実証

Void サンプルと同じカウンター画面、型付き Action、Live View を Cloudflare Workers で動かす。入口の Worker は静的ランタイムを配信し、SSR・Action・SSE のリクエストを同じ名前の `CounterRoom` Durable Object に転送する。オブジェクトが SQLite のカウンター、Pub/Sub、SSE の接続を所有する。現在は全デモ利用者が一つのオブジェクトを共有する。[Cloudflare の Durable Object 設計ガイド](https://developers.cloudflare.com/durable-objects/best-practices/architecture-guidance/)

増分は SQLite の一文で確定し、ストレージの同期完了後に Topic を発行する。カウンター値と署名付きセッションはプロセスをまたいで復旧できる。ページ登録は暗号化したトークンとして `data-hs-stream` の URL に入っており、オブジェクトのメモリには置かない。`PAGE_KEY` シークレットを固定しておけば、再起動後も古いストリームは `ready` と現在値から続き、別の入口からの Increment も届く。トークンは SSR から 12 時間で期限が切れる。接続中のストリームは期限を過ぎても続き、期限後に再接続した場合だけ `reset` が返る。[SQLite ストレージの同期](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync)

## ローカルで実行

リポジトリルートのセットアップ後、`examples/void` で実行する。

```sh
cd examples/void
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build:worker
if [ ! -e worker/.dev.vars ]; then
  (umask 077 && printf 'SESSION_SECRET=%s\nPAGE_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > worker/.dev.vars)
fi
mise exec -- npm exec --yes --package=wrangler@4.166.0 -- wrangler dev --config worker/wrangler.toml --ip 127.0.0.1 --port 8787
```

`http://127.0.0.1:8787` を別ブラウザセッションで開く。片方の Increment が両方に反映される。ローカルの SQLite は Wrangler の永続化ディレクトリに残る。公開環境では `PUBLIC_ORIGIN` に実際の HTTPS オリジンを設定し、同じ `SESSION_SECRET` と `PAGE_KEY` を Worker のシークレットとして保持する。`PAGE_KEY` は 32 バイトの鍵を base64 にした値で、`openssl rand -base64 32` で作れる。鍵を入れ替えるときは 2 回に分けて配備する。まず `pageKeys` の旧い鍵の後ろに新しい鍵を足して配備する。この段階の新しい鍵は復号にだけ使われる。次に新しい鍵を先頭に移して配備し、旧い鍵で作ったトークンの期限（12 時間）が過ぎてから旧い鍵を外す。このサンプルはシークレット一つだけを渡す。8 時間の署名付きセッションはデモ利用者の識別に使い、個別アカウントの認可は導入していない。[Worker のシークレット](https://developers.cloudflare.com/workers/configuration/secrets/)

## 検証

```sh
mise exec -- bun run test:worker
mise exec -- npm exec --yes --package=wrangler@4.166.0 -- wrangler deploy --dry-run --config worker/wrangler.toml --outdir dist/worker-check
```

Miniflare は別々の入口 Worker を同じ Durable Object に接続する。クロスエントリの SSE 配信、同時 Increment、別セッション・期限切れ・改変 Cookie・異なる Origin の拒否を検証する。エミュレータを再起動し、古いストリームが `reset` ではなく現在値から続くこと、別の入口の Increment が届くこと、SQLite からの値の復元も確認する。Wrangler の試験はローカル起動とデプロイの dry-run が範囲となる。
