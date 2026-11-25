# Redis の Pub/Sub アダプターと複数台での計測の設計

## 目的

ページ登録を暗号化トークンにしたことで、同じ鍵を持つインスタンスならどれでも SSE を受けられるようになった。ただ、あるインスタンスで発行した変更をほかのインスタンスに届ける Pub/Sub は、メモリ版（1 プロセスだけ）しか同梱していない。複数台構成の残り半分として、Redis の Pub/Sub で変更を届けるアダプターを用意し、複数のプロセスで実際に配信できることと、その遅延と負荷を測る。

## 合格の基準

- `createRedisPubSub()` を使った 2 つ以上のプロセスで、あるプロセスの Action が発行した変更が、ほかのプロセスに接続しているブラウザに届く（ブラウザテストか、実プロセスを使う結合テスト）。
- Redis の接続が切れたあと戻ったとき、購読中の View が購読を張り直し、最新の値を読み直す（既存の `onDisconnect` の経路）。
- 特定の Redis クライアントに依存しない。node-redis、ioredis、`Bun.RedisClient` のつなぎ方をドキュメントに載せ、少なくとも node-redis と `Bun.RedisClient` は実際の Redis で確かめる。
- 複数台の計測結果（インスタンス数、接続数、発行から全接続への配信までの p50 / p95、CPU とメモリ）を `bench/README.md` に載せ、1 プロセスのメモリ版と比べる。

## 目的にしないこと

- Redis Cluster、Sentinel の専用対応（クライアント側で対応できる範囲に任せる）。
- 配送の保証。Redis の Pub/Sub は届けるのが一度きりで、切断中の通知は失われる。保証が要るアプリは、今の Outbox の例と `reconcileIntervalMs` を使う（ドキュメントに書く）。
- Workers での Redis（TCP が使えないため）。Workers は今の Durable Object の構成を使う。

## 設計

- 入口 `hypersig-ts/redis` を足す。依存は増やさない。
- `createRedisPubSub<Event>({ publish, subscribe, channelPrefix? })` が `PubSub<Event>` を返す。
  - `publish(channel: string, message: string): Promise<unknown>` と `subscribe(channel: string, onMessage: () => void): Promise<() => unknown>` はアプリが渡す。クライアントの違いは、この 2 つの関数で吸収する。
  - チャンネル名は `channelPrefix`（既定は `"hypersig:"`）と `topicKey(event)` をつないだもの。メッセージの中身は使わない（購読者は通知を受けたら現在の値を読み直すので、中身が要らない）。
  - 同じ Topic の購読は、プロセスの中で `shareTopicSubscriptions` によって 1 本にまとめる。
  - 返すオブジェクトに `disconnected()` を足す。アプリは、クライアントの切断のイベント（`error`、`end` など）から呼ぶ。購読中のすべての `onDisconnect` を呼び、ランタイムが購読を張り直して最新の値を読み直す。
  - `publish` の完了は、Redis が受け付けた時点。
- カウンターのサンプルは、`REDIS_URL` があればこのアダプターを使う（なければ今のメモリ版）。計測とブラウザテストで使う。
- 計測 `bench/multi-instance.ts`：ローカルの `redis-server` を空いたポートで起動し、カウンターを 2〜3 プロセス立て、SSE の接続を各プロセスに振り分ける（例：100、300、1000 接続）。あるプロセスで発行してから、全プロセスの全接続に届くまでの時間を測る。同じ接続数の 1 プロセス・メモリ版とも比べる。結果は `bench/results/` の JSONL と `bench/README.md` の表に載せる。

## ドキュメント

- サイトの deploy（英語と日本語）の「複数のインスタンスで動かす」に、Redis のアダプターと 3 つのクライアントのつなぎ方を載せる。届けるのが一度きりであることと、取りこぼしへの備え（`reconcileIntervalMs`、Outbox）を書く。
- reference に `hypersig-ts/redis` の API を載せる。
- CHANGELOG の Unreleased に足す。

## テスト

- 単体：偽のクライアント（2 つの関数をメモリで実装）で、チャンネル名、購読の共有と解除、`disconnected()` が `onDisconnect` に届くこと。
- 結合：実際の `redis-server` を空いたポートで起動し（見つからなければテストを飛ばし、そのことを出力する）、node-redis で 2 つのランタイムをつなぎ、片方の発行がもう片方の View に届く。`Bun.RedisClient` でも確かめる（Bun で動く小さなスクリプトでよい）。
- ブラウザ：カウンターを `REDIS_URL` つきで 2 プロセス立て、プロセス A のページの操作が、プロセス B に接続したタブに届く。
