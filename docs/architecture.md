# Counter 実証の設計

## 既存技術の調査

| 技術                                  | 確認した設計と今回の判断                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust 版 hypersig                      | サーバーで生成した初期 HTML、Hydration を省く構成、型から Action やパッチ対象を生成する考え方を引き継いだ。ブラウザ側の Signal、式評価、パッチ処理は、サーバー上の Topic と HTML Fragment に置き換えた。[設計背景](https://imaimai17468.github.io/hypersig/learn/why/)、[Rust 版のブラウザ起動処理](https://github.com/imaimai17468/hypersig/blob/b71ce66091d569244a002018d8809bc0c6a3604f/runtime/src/index.ts)   |
| Hono 4.13.19                          | Fetch API ベースのルーティング、非同期 JSX の HTML 出力、SSE の書き込みと切断通知を利用する。サンプルの HTTP ホストは Bun。サーバーライブラリは Hono と Web API を使う。[Web 標準](https://hono.dev/docs/concepts/web-standard)、[JSX](https://hono.dev/docs/guides/jsx)、[Streaming](https://hono.dev/docs/helpers/streaming)                                                                                     |
| Void                                  | Cloudflare Workers 向けのルーティング、データアクセス、既存フレームワークとの統合がある。Hono のルートが統合点の候補になる。Counter は Hono 単体で検証し、Void での配備検証は後続とした。[概要](https://void.cloud/guide/)、[Server Routing](https://void.cloud/guide/server-routing)                                                                                                                              |
| Datastar                              | SSE 経由の要素パッチは今回に近い。フルランタイムは HTML 属性内の式、Signal パッチ、Fetch Action を備える。今回は、サーバーで決めた購読と汎用の DOM morphing を組み合わせる範囲に絞った。[開始ガイド](https://data-star.dev/guide/getting_started)、[SSE リファレンス](https://data-star.dev/reference/sse_events)                                                                                                  |
| htmx                                  | 宣言的なリクエストと HTML スワップを提供し、SSE と Idiomorph は拡張で使える。今回は Action の HTTP 成否と購読の更新を分けるため、ネイティブの Fetch と EventSource に Idiomorph を組み合わせた。[SSE 拡張](https://htmx.org/extensions/sse/)、[Idiomorph 拡張](https://htmx.org/extensions/idiomorph/)                                                                                                             |
| Idiomorph 0.8.0 / DOMPurify 3.4.18    | 型定義付き ESM を同梱する。Idiomorph は ID に基づくノード再利用とフォーカス復元を提供する。DOMPurify は受信 HTML を HTML プロファイルで無害化し、DOM Fragment を返す。自前実装の範囲を通信、更新先の選択、バージョン比較に絞れた。実際のバンドル量と Chromium での動作は下記のとおり。[Idiomorph リリース](https://github.com/bigskysoftware/idiomorph/releases)、[DOMPurify](https://github.com/cure53/DOMPurify) |
| Standard Schema 1.1.0 / Valibot 1.5.0 | ライブラリは Standard Schema の型と検証契約を使い、サンプルが Valibot を選ぶ。入力スキーマの変換前の型を `bind` に、変換後の型を `authorize` と `execute` に使う。成功レスポンスの型と検証は出力スキーマが担う。[Standard Schema](https://standardschema.dev/)、[Valibot](https://valibot.dev/guides/introduction/)                                                                                                |

## API の選択

| 境界          | 比較と決定                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live View     | `page.view(View, props)` で SSR に埋め込み、そのページが許可したインスタンスを同時に記録する。専用 JSX ファクトリや JSX コンテキスト経由で暗黙に登録する案に比べ、登録先を呼び出しで確認できる。通常の Hono JSX コンポーネントからも呼べる。                                          |
| Action        | `action.bind(input)` は標準の `button` に展開する属性を返す。手書き URL と異なり、登録済みの Action と JSON 入力型を共有できる。`action.form()` は標準の `form` 用。フォームのコントロールは実行時に入力スキーマで検証し、同名フィールドは配列にまとめる。                            |
| Topic / 購読  | `topic(name, key)` が型付きの Topic を生成し、アプリの Topic 型が `publish` と `subscribe` に共通する。各 View が明示的に購読を定義し、Action やバックグラウンド処理はコミット後に Topic を発行する。購読を Action ごとに列挙する方法や、データ読み込みを暗黙に追跡する方法を避けた。 |
| HTML Fragment | ページ内で一意な View のキー、単調増加するバージョン、HTML 本文を `html-update` に載せる。固定の境界要素の子に対して morphing を行う。属性やテキスト専用の差分形式は、計測して必要になった時点で検討する。                                                                            |
| SSE           | EventSource の再試行と、購読開始時の最新 HTML の再描画を使う。境界ごとに先に購読し、その後スナップショットを読み取る。描画中の変更は次のパスに積む。トップレベル View は並行して描画し、SSE の書き込みは接続ごとに直列化する。                                                        |

## 状態とライフサイクル

アプリは DB やメモリ上の業務状態を所有する。`publish` の完了はアダプターが通知を受理したことを表し、ブラウザへの配信完了を待たない。SSE 処理は同一 View の未処理通知をまとめる。Action の HTTP 応答は処理結果を返し、ブラウザの自動画面更新は SSE 経由で行う。再接続も同じ経路でスナップショットを適用する。

SSR で認可した View の集合（名前、キー、JSON の props）は、AES-GCM で暗号化したページトークンとして `data-hs-stream` の URL に入れ、サーバーはページごとの状態を持たない。ブラウザは表示中のキーだけを提示でき、サーバーはページのセッションと View の認可を照合する。セッションには認証済みのセッションごとに一意の `sessionId` を使う。View と Topic の対応は SSR 時に確定するため、購読先が変わる権限やテナントの切り替えではセッション ID を更新する。接続中は更新時と約 15 秒のアイドル間隔で認証と View の認可を再確認する。認可を失った View の表示を消去して購読を解除する。アプリ側ではデータアクセス時にも所有者やテナントの境界を守る。

DOM からトップレベルの View を外すと、ランタイムはそのキーを除いた EventSource に切り替える。同じ境界が戻ると最新 HTML を取得する。ページ登録は 1 ページあたり最大 32 View。ページ数の上限や、使われなかった登録の退避はない。トークンは SSR から数えて既定 12 時間（`pageLifetimeMs`）で期限が切れる。接続中のストリームは期限を過ぎても続き、期限後に接続し直した場合だけ `reset` でページを再取得する。トークンは `pageKeys` の先頭の鍵で暗号化し、すべての鍵で復号を試す。鍵を入れ替えるときは新しい鍵を先頭に足し、旧い鍵を期限（12 時間）ぶん残してから外す。トークンごとの nonce は 96 ビットの乱数なので、1 つの鍵で安全に作れるトークンは約 2^32 個まで。その数に届くよりずっと前に、利用の多いサービスでは少なくとも年に 1 回、鍵を入れ替える。`pageKeys` を省くと起動ごとの乱数の鍵になり、再起動後や別プロセスに届いたトークンは `reset` と `page-token-invalid` の診断になる。トークンは `pageContext` を AES-GCM の追加認証データとして暗号化し、同じ `pageContext` のランタイムでだけ開く。`createHypersig` は既定で正規化した `origin` を使うので、`pageKeys` とセッションを共有する別アプリやステージングと本番の間でトークンを使い回せない。別の `pageContext` のトークンも `reset` と `page-token-invalid` の診断になる。複数のオリジンで同じページを配信するときは、全インスタンスに同じ `pageContext` を明示する。SSR のまま表示する近道は、ブラウザが `pristine` として示した未変更の View にだけ使う。

トークンはデプロイをまたいで期限まで有効なので、デプロイ後の新しいサーバーは古いトークンを開く。トークンの params は、新しいコードの `authorize`・`subscribe`・`load`・`key` に新しい params の型として渡る。View の params の形を変えるときは、View の `name` を変えて古いトークンを `reset` にするか、古いトークンを作った鍵を `pageKeys` から外して `reset` させる。テンプレートだけの変更は、その View の次の更新から表示に出る。版が変わっていない `pristine` の View は、次に変わるまで旧テンプレートの HTML のまま残る。開いたままのページの古い `runtime.js` も新しいサーバーと通信するので、ブラウザランタイムはデプロイをまたいで互換に保つか、古いトークンを作った鍵を外して `reset` させる。

トークンが名指しする View が登録されていない場合や、`key()` が例外を投げたり無効・重複したキーを返したりした場合は、`expired` を返す前に `page-rebuild-failed` の診断で失敗した View の名前を渡す。`page-token-invalid` は任意のクライアントが壊れた文字列を送るだけで起きるので、1 件ごとに警報を出さない。

Action は設定済みの公開 Origin と一致する POST を受け付け、標準スキーマで検証してから個々の認可を通す。SSR ではユーザー入力を JSX のテキストや属性値としてエスケープする。HTML や URL を生成するコードはアプリで管理し、ユーザー入力を raw HTML、スクリプト、CSS として注入しない。SSE Fragment には DOMPurify を適用する。View 内のフォームでは `counterId` のように DOM プロパティと衝突しないフィールド名を使う。初期 SSR と Fragment の両方を同一オリジンから配信し、Counter は CSP を設定する。

`PubSub` は差し替え可能。ページ登録はトークンに入っているので、複数インスタンス構成でも接続先の固定は要らない。全インスタンスに同じ `pageKeys` を渡し、インスタンス間で Topic を届ける `PubSub`（メモリ版ではなく外部の配送基盤を使うもの）を使う。本番でコミット後の通知に配送保証が必要な場合は、アプリのトランザクションと連動する Outbox などを検討する。

## Counter の計測

Bun 1.3.1、Node 26.13.0、Chromium 159、macOS arm64 のローカル実行。Playwright で二つの独立したブラウザセッションを開き、各初期スナップショットの完了後に 1 回クリックした。

| 測定対象     | 観測値                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ブラウザ JS  | minify 後 44,844 B、gzip -9 で 16,874 B。Idiomorph と DOMPurify を external にして計った通信・更新処理は 3,505 B、gzip -9 で 1,646 B。初期値は HTML に含まれ、対話にはこのバンドル 1 本を使う。 |
| サーバー描画 | 初期表示は各 View を各セッションで SSR 1 回、接続時の同期描画 1 回。以降、Increment 1 回につき変更された View の描画 2 回、無関係な View の描画 0 回。                                          |
| 通信         | 確立済みの SSE 2 本と Action の POST 1 本。各セッションへ `html-update` 1 件、404 B。HTTP ヘッダーと転送時のフレーミングは計測外。                                                              |
| DOM          | カウンター境界内の変更を確認。境界外に MutationObserver の変更記録がなく、見出し、独立カウンター、入力要素は同じノードを維持した。フォーカス、入力値、キャレット位置も維持した。                |
| 反映時間     | クリックイベントから両ブラウザの DOM 反映まで 12 ms（ローカルの 1 試行）。                                                                                                                      |

上記は Counter 実証時点の計測値。実ネットワークや多数接続での負荷・メモリ計測、Void 統合は後続フェーズとなる。

## TodoMVC での購読検証

TodoMVC では、タスクの一覧と件数・一括操作を独立した Live View として登録する。一覧はフィルターに応じてアクティブまたは完了済みの Topic を購読し、All は両方を購読する。件数・一括操作は件数用 Topic を購読する。Action は共通の更新関数を呼び、更新関数が確定状態の前後を比較して変化した Topic を公開する。このため、アクティブな項目の名前変更で完了済み一覧や件数を再描画する必要がない。

項目の編集 UI は HTML の Popover を使う。他のタブから更新が届いても、同じ項目の入力欄を morphing で維持する。追加フォームは `form({ resetOnSuccess: true })` を指定し、HTTP 成功後にだけリセットする。失敗時の入力と、送信後に新たに入力した値は残る。これらの処理に使うブラウザ JS はフレームワーク共通のランタイムに含まれる。

Playwright は二つの Cookie セッションに All / Active / Completed の三画面を開き、追加、編集、完了、再開、一括削除の反映を確認する。アクティブな項目の編集時は、完了済み画面への SSE 更新が 0 件であることも確認する。

## Phase 3 の整合性と購読ライフサイクル

`hypersig.live({...})` はアプリのセッション型と Topic 型を使って Live View を定義する。親の `render(data, params, context)` から `context.view(Child, props)` を呼ぶと、子を宣言的に配置できる。`name` は必須で、ランタイム内で一意にする。キーは `name` そのもので、同じ定義を同じ親の下に複数置くときだけ `key(params)` を後ろに `.` で続ける。定義は `hypersig.live()` を呼んだ時点でランタイムに登録され、名前が重なると例外になる。単体の `live()` は公開していない。トップレベルの `page.view` の `params` は JSON にできる値（`JsonValue`）に型で制限する。入れ子は最大 4 階層。SSR では子の HTML も生成する。SSE 更新では親が子の境界を配信し、サーバーが子を購読してから最新 HTML を配信する。親が子を描画しなくなると子孫まで購読を解除する。この経路では EventSource を開き直さない。子の DOM 境界は同じキーで維持する。`revision()` を定義すると、同じキー・View 定義・revision・Topic 集合の子は購読と描画済みの HTML を維持する。子自身の Topic が発行されると再描画する。revision か Topic が変わる場合は新しい props で購読と描画をやり直す。入れ子の表示・非表示は親の描画で管理する。

ページ登録ごとに有効な SSE 接続は一つ。接続切り替えで旧ストリームを中止し、非同期描画の完了後も旧ストリームからの送信を抑止する。新しい接続は購読を張ってから読み直し、ページ内のバージョンを引き継ぐ。配信直前にセッションと対象・祖先 View の認可を再確認する。セッションが失効した場合はランタイムが Live View の内容を消去して接続を止める。接続断の再試行中は直前の表示を維持する。

再描画が失敗した View は直前の HTML を維持し、`data-hs-view-error` と `hypersig:view-error` で失敗を通知する。同じ View が次の該当通知か再接続で正常に描画されると、失敗マーカーは消える。ほかの View への更新は継続する。詳細な例外はサーバーログに記録する。

## Phase 4 の性能計測

[性能計測](../bench/README.md) で、同じ画面の固定一覧を更新境界に含める場合と外に置く場合を比較した。更新境界を値だけに絞ることで、同時接続が増えたときの再描画・転送・DOM morphing の負荷を抑えられた。

## Phase 5 のフレームワーク統合

[Void サンプル](../examples/void/README.md) は、対象パスの Request をミドルウェアから Hono に渡し、SSR・Action・SSE を一つの Node プロセスで処理する。リンクは Hono の型付きルータから生成する。開発時の再読み込みには Vite の開発接続を使用し、本番ビルドでは hypersig のブラウザランタイムを静的アセットとして配信する。コアを使用するアプリは任意のホストで Hono の Fetch ハンドラを利用できる。

## Workers の共有状態

[Workers サンプル](../examples/void/worker/README.md) では、共有リソースへの SSR・Action・SSE を同じ Durable Object に送る。SQLite がカウンター値を所有し、ページ登録は暗号化トークンとして URL に入れ、購読はオブジェクト内で管理する。`PAGE_KEY` シークレットを固定すると、オブジェクトが再起動しても古いストリームは現在値と `ready` から続き、別の入口からの更新も届く。旧い鍵で作ったトークンの期限が切れる前にその鍵を外した場合と、期限後に再接続した場合は、`reset` でページを取得し直す。

## レンダラーと配信の境界

`hypersig.ts/core` は `createLiveRuntime()`、Live View と Topic の型、インメモリ Pub/Sub を公開する。ページ登録、セッションに紐づく購読、再接続、更新順序、親子の照合はここが所有する。アダプターは `LiveRenderer` で境界の生成とマークアップの直列化を提供し、`LiveConnection` で更新メッセージの送信と切断を実装する。マークアップのエスケープと安全な描画はレンダラーの責務になる。

メインのエントリの `createHypersig()` は、Hono JSX と SSE をこの境界に接続する。Action の HTTP ルーティングとスキーマ検証も Hono アダプターから利用する。ブラウザでは既存の SSE イベントと DOM morphing を使う。文字列レンダラーとインメモリ接続のテストで、Hono を通さずに同じページ登録と更新処理を動かしている。

子の `revision(params, user)` は、Topic が扱う業務データ以外で、親から渡す描画入力が変わったことを表す。表示形式やロケールのような値を含める。指定を省いた子は親の再描画に合わせて最新の props を読み直す。revision が一定でも、Topic を受け取っている子は再描画される。View 内の通常の TSX は、その View が更新されたときに描画し直す。

## 通知の診断と復旧

`createLiveRuntime` と `createHypersig` の `onDiagnostic` で、型付き Topic の発行結果、購読が無効化した View のキー、再描画の理由と成否を観測できる。発行成功は Pub/Sub が通知を受理した時点、描画成功は Fragment の生成が終わった時点を表す。描画の診断にはブラウザでの適用完了を含めない。診断先には View キーと Topic キーが渡るため、ログへのアクセスもアプリ側で管理する。

`reconcileIntervalMs` を設定すると、稼働中の接続が一定間隔で認可を通し、表示中の View の最新値を読み直す。HTML と子境界が同じなら再同期による送信を省く。描画に失敗した View も次の周期で回復できる。間隔は通常の通知に加えて状態の読み取りと描画が発生する頻度を決める。通知頻度と読み取りの負荷に応じて、必要なアプリで有効にする。共有メモは30秒で確認する。

通常の `live` に `snapshotRevision: { read, from }` を設定できる。`read(params, user)` は現在の版だけを読み、`from(data)` は実際に描画するスナップショットの版を取り出す。定期再同期で版が等しければ `load` と描画を省き、照合に失敗した場合は通常の読み直しを行う。子のいないトップレベル View では、最初の SSE 接続でも購読を張ってから SSR 時の版と照合する。版が同じなら SSR をそのまま表示し、照合中に届いた Topic はその後に処理する。再接続時は通常の読み直しを行う。版は、その View の表示や子境界の構成に影響するデータと同じトランザクションで更新する。親から子への入力の変化は既存の `revision(params, user)` で扱う。

共有メモの SQLite では、本文の確定と Outbox 行の記録を一つのトランザクションで実行する。送信処理は Pub/Sub が受理した行だけを消し、失敗した行は次回に再試行する。購読側はイベントを受けるたびに現在値を読むため、同じ通知を再送しても値を重複して変更しない。SQLite ファイルを指定すると、通知失敗後のプロセス再起動でも未処理行から続行できる。各 DB や配信基盤に合わせて、このトランザクションと送信処理をアプリが所有する。

外部 Pub/Sub アダプターは、既存の購読で配送を継続できなくなった時点で `subscribe(topic, listener, onDisconnect)` の第3引数を呼べる。ランタイムはその View の購読を張り直して最新スナップショットを取得する。再購読に失敗した場合は約1秒後に試し直す。切断と購読エラーは `onDiagnostic` に届く。接続維持中の無通知の欠落は、定期再同期でカバーする。

外部アダプターを `shareTopicSubscriptions(upstream)` で包むと、一つのアダプター内で同じ Topic の外部購読を共有できる。最後の購読者が離れたときに外部購読を解除する。外部側の切断は購読中の View に伝え、最初の再購読で外部購読を張り直す。各 View の認可と SSE 配信は接続ごとに実行する。

ページ登録は暗号化トークンに入っており、同じ `pageKeys` を持つランタイムならどれでも SSE を受けられる。分散配備では、全インスタンスに同じ鍵と、インスタンス間で届く `PubSub` を渡す。各入口の SSR・Action・SSE を共有リソースの担当にルーティングする構成は、状態の置き場所を一か所にしたいときに選べる。Workers 実証は、同じ Durable Object を二つの入口から使い、再起動後も古いストリームが現在値から続き、別入口の更新が届くことを確かめる。Outbox、永続ストア、外部の配送基盤の配置は配備先で決める。

## HTML フォームと一時的な操作状態

Action に `formResponse(result, request, user)` を定義すると、HTML を明示的に受け付ける通常のフォーム送信を同じ Action に通せる。検証が失敗した場合は送信された `FormData` と問題の一覧が渡る。アプリは表示すべき入力だけを復元し、422 の HTML を返せる。成功時は検証済みの出力を受け取り、303 で GET に戻せる。`ActionError` に指定する文言は利用者に表示する内容を想定している。意図しない例外は通常のサーバーエラー処理に渡す。

共有メモは通常の Action 入力に操作 ID を含める。同じセッション・同じ操作 ID・同じ入力の再送には、確定済みの結果を返す。SQLite は業務更新、操作結果、Outbox を同じトランザクションで記録する。送信結果が不明なときはフォームが操作 ID を保持し、結果を確認するか、利用者が最新版を明示的に編集元に選んだときに新しい ID に切り替える。この操作履歴は共有メモのストアが所有する。

入力欄の制約属性は `action.control(name)` が作る。入力スキーマが Standard JSON Schema も実装しているときだけ型に現れ、最初の呼び出しで JSON Schema に変換した結果の最上位の `properties` と `required` から `required`、`minLength`、`maxLength`、`pattern`、`min`、`max` を返す。導き出した属性でブラウザがサーバーより厳しくなってはならないので、`required` は空文字列をはじくスキーマ（`minLength` が 1 以上、`""` に一致しない `pattern` がある、`""` を含まない `enum`）にだけ付け、`pattern` は `^` と `$` で囲まれ、最上位に `|` がなく、`v` フラグで解釈できるものだけを返す。変換できない部分は `createHypersig` の `jsonSchema.libraryOptions` で飛ばし（Valibot の `v.trim()` なら `{ ignoreActions: ["trim"] }`。`errorMode: "ignore"` は正規表現のフラグを落とすので使わない）、失敗したときは Action 名を含む例外にする。送信前の文言はブラウザ標準で、スキーマのメッセージはサーバーの検証後に表示される。

標準ランタイムからの送信には JSON を返す。フォーム内の要素に `{...action.fieldError("fieldName")}` を展開すると、スキーマの検証結果をテキストで反映できる。Action の失敗メッセージと接続状態の表示先は `errorOutlet()` と `connectionStatusOutlet()` で示す。属性名は `src/protocol.ts` の `outletAttributes` で一度だけ定義し、ランタイムもそこから読む。`data-hs-pending` は送信処理中のフォームまたはボタンに付く。保存前の入力や送信中表示はブラウザが管理する。公開内容の反映は Live View と SSE が担う。共有メモの公開ガイドはブラウザの標準 prefetch に対応する。利用者ごとのページ登録を含む HTML は `no-store` で返す。

トークンが期限切れ、改ざん、鍵の不一致、消えた View 名などで受け付けられない場合、SSE の `reset` を受けて現在の URL を再取得する。復旧時に残す非機密の下書きは、Live View 外のフォームを `action.form({ draft: true })` で作り、対象のテキスト系フィールドに `{...action.draft("fieldName")}` を展開する。フォームのキーは Action 名、フィールドのキーは入力スキーマの項目名になるので、どちらも手書きしない。編集元の版のような hidden 値も同じ方法で指定できる。アダプターの `draftScope(user)` はログインセッション固有の非秘密値を返す。認証資格情報とは別にし、同じセッションが再起動をまたぐ場合は同じ値を返す。ランタイムは reset の直前に対象の入力だけをタブの `sessionStorage` に2分の有効期限付きで退避する。次のランタイム起動時にその記録を削除し、有効期限内で URL・スコープ・フォームキーが一致する場合に一度だけ復元する。ストレージへの書き込みに失敗した場合は再読み込みを保留し、フォームの内容をその場に残す。

復元したフォームに `data-hs-draft-restored` が付くため、アプリは復元を案内できる。共有メモでは、公開中の本文と下書きを見比べた利用者が、明示操作で表示中の版を編集元に選べる。本文の保存はその後の Action で行い、サーバーが送信された編集元の版を照合する。

## ブラウザ側の Signal

ブラウザだけで決まる状態、Live View が描画した値、Action 送信中の表示を、サーバーが送る式から扱う。アプリは `signals()` / `signalFamily()` で型付きのグループを定義し、`with(values)` で値を入れたハンドルから `init()`、`bindText`、`bindShow`、`bindAttr`、`bindValue` の属性を作る。式と文は `src/protocol.ts` の JSON の構文木で、ブラウザのランタイムが評価する。`eval` と `new Function` は使わないので、CSP の `script-src 'self'` のまま動く。サーバーはリクエストごとの値で式を評価して初期 HTML に結果を書くため、ランタイムを読み込む前から表示が正しい。

### Live View との役割分担

`init()` は `with()` に渡した項目を確定した値の組 `[path, value]` で、渡さなかった項目を既定値の組 `[path, value, 0]` で書く。ランタイムは既定値の組を、ストアにそのパスの値がないときだけ適用する。読み込み時と Live View の更新時で同じ規則を使うので、ブラウザだけで決まる値を Live View が上書きすることはない。確定した値の組は Live View の更新が届いて morph したあとに読み直し、ストアを上書きする。ただし、フォーカス中の `bindValue` の入力欄が持つパスは書かない。利用者が入力している内容を優先し、ブラウザが blur したあとの次の更新で反映する。空の number 入力はストアを変えない（欄を消して 0 にならないようにする）。文、入力欄、スナップショットは `$` で始まる組み込みのパスに書けない。

### 読み込みの順序

1. 下書きを復元する。入力欄の `value` が復元した値になる。
2. ページのすべての `data-hs-signals` をストアに入れる。
3. `bindValue` の入力欄を読む。`value` が `defaultValue` と違う入力欄は、入力欄の値でストアを上書きする。`type="hidden"` の入力欄は `value` を書くと `defaultValue` も変わるので、常に編集済みとして読む。
4. すべての束縛を評価して DOM に反映する。

### Action の呼び出しと既知の制約

`action.call(input)` を含むハンドラーは、文を順に実行する。`call` より前の `set` / `toggle` は通常の書き込みで、すぐに表示され、Action が失敗してもそのまま残る。送信中に Live View からそのパスの値が届けば、すぐに適用する（フォーカス中の `bindValue` の入力欄が持つパスは除く）。確定前の値を表示したいアプリは、`onError` の文でページを描画したときの値を書いて戻す（例: `onError: [r.completed.set(todo.completed)]`）。切り替え（`toggle`）で戻すと、送信中に届いた Live View の更新のあとでは逆の値になるので、値を書く。`action.pending()` と `action.draftRestored()` は、`$pending` / `$restored` の組み込みの Signal として読む。キーはレンダリングされた Action の URL である。

以前は `call` より前の書き込みを暗黙に楽観的な書き込みとして扱い、送信中はそのパスのスナップショットを保留し、失敗したら元の値に戻していた。ダイアログを閉じるようなブラウザだけの書き込みまで戻り、commit 前後の更新と応答の順序で値が一瞬戻る競合と、同じパスに重なった呼び出しが互いの値に戻す競合があり、使う例もなかったため取り除いた。明示的な指定（`call(input, { optimistic: [...] })` など）は必要になったときに検討する。

次の制約がある。

- 送信中に Live View の更新が届くと、先に表示した値を上書きする。`onError` はページを描画したときの値を書く。
- `hypersig:action-success` イベントの `detail.data` は、応答に `data` がないとき `undefined` ではなく `null` になる。

### 確定してから表示する

画面は操作にすぐ反応し、データはサーバーが確定してから表示する。送信中は `action.pending()` と、ランタイムが送信元のフォームやボタンに付ける `data-hs-pending` 属性で処理中であることを示し、値は確定したデータを持つ Live View の更新で変わる。一覧の新しい行もサーバーが key を決めて描く。確定前の値を表示するときは `call` より前に書き、`onError` で描画したときの値を書いて戻す。ほかの人が同時に編集しうる値、サーバーが決める値、検証で失敗しうる入力には使わない。TodoMVC は完了の切り替え、追加、削除を処理中として表示し、確定前の値を使わない。処理中の表示は HTTP の応答で終わる。外部の pubsub を使う構成では確定した更新が応答のあとに届くことがあり、そのあいだは古い値が薄くならずに一瞬見える。

確定前の値を表示してよいのは、利用者が自分で動かした結果を処理中として示す場合に限る。並べ替えのサンプルは、手を離した位置を薄く表示したまま残し、確定した並びが Live View の属性で届いたら置き換え、失敗したら戻す。ほかの人の変更やサーバーが決める値を先に見せるものではなく、それらはサーバーが確定してから表示する。

`data-hs-pending` はランタイムがコントロールごとに数え、最後のリクエストが終わるまで付けたままにする。Live View の morph でも、送信中のコントロールからは外さない（Idiomorph の `beforeAttributeUpdated`）。送信中のフォームやボタンは再び送信しない。`form({ onSubmit })` の文は送信の前に走り、束縛を描き直してから `FormData` を作る。送信中のフォームでは文も走らない。

一時期、テンプレートから複製した仮の行で一覧への追加を先に表示していたが、確定していないデータが確定したデータと並び、アプリのサーバーがブラウザの作った key を受け入れる必要があったため取り除いた。

### キー、フォーカス、タイマー、条件

選択式のコンボボックスやタブのような部品を Signal の文だけで書けるように、次の命令を足した。属性名は `src/protocol.ts` で一度だけ定義し、キーの名前や時間は型と実行時の両方で検査する。

- **式**: 文字列に `length()`、`trim()`、`lower()`、`includes(other)`、数に `clamp(min, max)`、`mod(n)`、配列に `at(index, fallback)`、`length()`。どれもサーバーとブラウザの `evaluate` で同じ結果になり、型が合わない値でも例外にしない（`length()` は文字列と配列以外で 0、`trim()` と `lower()` は文字列以外で `""`、`includes` は両方が文字列でなければ false、`mod(0)` は 0、`clamp` は値か `max` が数でなければ `min`、`min` が数でなければ 0、`at` は範囲外や整数でない番号で `fallback`）。`length()` は UTF-16 の長さ（`String.prototype.length`）で、絵文字などのサロゲートペアは 2 と数える。
- **束縛できる属性**: `bindAttr` に `aria-activedescendant`、`aria-selected`、`aria-controls`、`aria-label`、`tabindex`、`hidden` を足した。`hidden` は `disabled` と同じ真偽値の属性。`bindAttr` は真偽値でない属性を取り除けない。式が空文字列になると、属性は空の値のまま残る（`aria-activedescendant=""`）。
- **`refs()`**: `attr(key)` で要素に key を付け、`focus(keyExpr)` が式の値の要素にフォーカスする。`keyExpr` は文字列か文字列の式で、数や真偽値、配列の式は型エラーにする。見つからないときは何もしない。`ref()` と `refs()` の `attr` はどちらも `data-hs-ref` を書くので、1 つの要素にはどちらか一方だけを付ける（両方を展開すると後のほうだけが残る）。`focus()` と `focus(key)` は、予約済みの描き直しを先に済ませてからフォーカスする（同じ文の一覧で前の `set` が `hidden` を外した要素に届く）。
- **`on.keydown(map)`**: `KeyboardEvent.key` の値でキーを書く。名前付きのキー（`Enter`、`Escape`、`Tab`、`" "`、矢印、`Home`、`End`、`PageUp`、`PageDown`、`Backspace`、`Delete`）、1 文字のキー、数のキーを受け付ける。数のキーは 1 桁（`"0"`〜`"9"`）だけで、`10` は型エラーと例外になる。修飾キーは `Control+`、`Alt+`、`Shift+`、`Meta+` の順に前へ付け、順序を間違えるか未知の名前なら型エラーと、`on.keydown` を呼んだときの例外になる。
  - 修飾キーは完全に一致したときだけ当てはまる（`Enter` は `Shift+Enter` に当てはまらない）。スペース以外の 1 文字のキーは Shift を照合に使わない。`"?"` や `"A"` は Shift の有無に関わらず当てはまり、`"Shift+?"` は型エラーと例外にする。
  - 押した要素から近い対応表を探し、キーがなければ外側の対応表を探す。当てはまったら `preventDefault()` して文を実行する。`Tab` と `Shift+Tab` は止めない。`isComposing` と `keyCode` 229 の `keydown` は無視する。
  - 対応表を持つ要素で Action の送信が進行中なら、`preventDefault()` だけして文は実行しない（Enter の二重送信を防ぐ）。子を自分で描くカスタム要素の中の対応表は無視する。中の要素（アイランドなど）がすでに `preventDefault()` したキーでは、どの対応表の文も実行しない。
  - 検査できない制約。macOS では Meta を押すと文字の `key` が小文字になるため、`Meta+z` は Cmd+Shift+Z にも当てはまる。Caps Lock が有効だと文字の大小が変わるので、`"a"` と `"A"` は別のキーとして扱われる。macOS の Option は文字を合成するので、`Alt+<文字>` は届かないことがある。容器に `Enter` や `" "` を割り当てると、中のボタンの押下による起動を止める。1 文字のキーを割り当てると、中の入力欄でその文字を打てなくなる。
- **`on.focusEnter(文)` / `on.focusLeave(文)`**: フォーカスが要素の外から中へ入った、中から外へ出たときに走る。要素の中での移動では走らない。ランタイムは `focusin` / `focusout` を document で委譲し、`relatedTarget` と `document.hasFocus()` で判定する。ウィンドウやタブの切り替えでページがフォーカスを失ったときは、離れたとみなさず、フォーカスが戻って別の場所に入ったときに離れたものとして扱う。マウスで中の要素を押すとフォーカスが一度 `body` に移るので、押される要素には `tabindex="-1"` を付ける。送信が進行中の要素では実行しない。
- **`timer({ name })`**: `after(ms, 文)` と `cancel()` を持つ。予約はページにタイマーの ID ごとに 1 つで、`after` は前の予約を取り消してから予約し直す（デバウンスになる）。Live View の更新で要素が消えても取り消さない。時間が来たとき、予約した要素で送信が進行中でも文を実行するので、同じ Action が並行して送られうる。予約した要素がページから外れていれば `call` は送らず、ほかの文だけを実行する。予約した時点の `output` と `detail` を、時間が来たときの文も読める。`ms` は 0 以上 2147483647 以下の整数で、型は `number`、実行時に `RangeError` にする。
- **`when(condition, then, otherwise?)`**: 条件が真なら `then`、偽なら `otherwise` の文を実行する。真偽の判定は `choose` と同じ。文を書けるどこでも使え、分岐の中の `call` は `when` を実行した要素から送る。選択式のコンボボックスで、Enter が閉じた一覧では開き、開いた一覧では選んで保存するために足した。

[部品のサンプル](../examples/widgets/server.tsx)のコンボボックスは、WAI-ARIA APG の select-only combobox のうち、文字を打って候補へ移る type-ahead と `PageUp` / `PageDown` を省いている。決定に使う Enter、Space、Tab、Shift+Tab は、保存の送信中は文を実行しない（矢印キー、Home、End、Escape は動く）。下書きはデバウンスで保存するが、保存の順序は守らないので、前の保存が遅れて後の保存より後に確定すると、古い本文が残りうる。

### カスタム要素

地図やエディタのような JavaScript のライブラリは、アプリが読み込むカスタム要素で包む。要素の属性とイベントは、サーバーとブラウザが共有する宣言の値で一度だけ書く。ランタイムは宣言から作った属性の仕様を解釈するだけで、要素の JavaScript は読まない。

```ts
import { customElement, event, json } from "hypersig.ts/element";

const sortableList = customElement("sortable-list", {
  attributes: { items: json<Item[]>(), failures: "number" },
  events: { reorder: event<string[]>() },
  ownsChildren: true,
});
```

#### 宣言と入口

- `customElement(tag, { attributes, events, ownsChildren })`（`src/element.ts`）が宣言を値として返す。属性の種類は `"string"`、`"number"`、`"boolean"`、`json<T>()` の4つで、`event<Detail>()` がイベントの `detail` の型を持つ。`json<T>()` の `T` とイベントの `Detail` は JSON にできる型に限る。
- 入口は3つに分ける。`hypersig.ts/element`（宣言と、ブラウザ側の `defineElement`）は Hono も React も読み込まず、DOM のないサーバーで import しても例外を出さない。`HTMLElement` を継承するクラスは `defineElement` の呼び出し時に作る。`hypersig.ts/react` は `reactElement` を持ち、React を読み込む。`hypersig.ts` は `customElement`、`event`、`json` と宣言の型（`AttributeValues`、`EventName`、`EventDetail`、`Emit`、`ElementImplementation`、`MountedElement` など）を `hypersig.ts/element` から再 export し、React は読み込まない。`react` と `react-dom`（^19）は optional の peerDependency で、`hypersig.ts/react` を使うアプリだけが必要とする。
- サーバーでは `<CustomTag of={declaration} id=... />`（`src/custom-tag.tsx`）が宣言のタグで要素を描き、`declaration.on(...)`、`scope.bindElement(declaration, values)` が属性を作る。
- タグ名は型（`CustomTagName`）で検査できる範囲を検査し、残りの文字は `customElement()` を呼んだときに実行時に検査する。属性名、イベント名、属性の種類も同じときに実行時に検査するので、打ち間違いは起動時の例外になる。
- `ownsChildren: true` の宣言の `CustomTag` は `id` を必須の props にする（型で強制する）。`id` がないと Live View の更新のたびに要素が作り直され、`unmount` → `mount` で部品の内部の状態が消える。値はアプリが決める（一覧なら行ごとに一意にする）。
- 古い `customElement<Spec>(tag, options)` と `decl.Element` は残していない。

#### 属性の値の形式

- `bindElement` は `data-hs-element-attr` に書く。`bindAttr` の `data-hs-attr` は名前の一覧で受け付けるので、サーバーとブラウザが同じ規則を使えるよう属性を分けた。`data-hs-element-attr` は宣言済みの名前を値の型で書き分ける（`string` と `number` は文字列、`boolean` は空の属性か属性なし）。ただし `aria-*`、`data-*`、`draggable`、`spellcheck`、`contenteditable` の `boolean` は `"true"` か `"false"` の文字列にする。この判定は `src/protocol.ts` の `rendersBooleanAsText` 1つで、`CustomTag`、`bindElement`、ランタイム、`defineElement` が共有する。Hono の JSX は自分の一覧にない名前の `true` を `"true"` と描くので、`bindElement` と `CustomTag` の props はそれ以外の名前の真偽値を空文字列か省略に直してから渡す。
- `json` の属性は `formatJsonAttribute`（`JSON.stringify`）の文字列で書く。`CustomTag` の props、`bindElement`（Signal の値）、ランタイムの書き込みのどれも同じ形式にする。`bindElement` は JSON の属性の名前を `data-hs-element-json`（`customElementAttributes.elementJson`）に並べ、ランタイムはその名前の値を同じ関数で書く。JSON の属性がない束縛では、この属性は書かない。`bindElement` の出力を `CustomTag` に展開しても、すでに書いた JSON を二重に変換しない。`bindElement` は自分が書いた JSON の文字列を、返すオブジェクトのシンボルのキーにも持たせる。展開するとシンボルのキーも写り、Hono の JSX はシンボルのキーを描かない。`CustomTag` が変換せずに渡すのは、そのシンボルに記録された文字列と同じ値だけで、props の値は文字列も含めてすべて `formatJsonAttribute` で書く。そのため同じ属性を props と `bindElement` の両方で書くと後に書いた方が残り、手で書いた `data-hs-element-json` は変換の判断に使わない。`CustomTag` の `json` の props は読み取り専用の配列も受け付ける（`bindElement` の Signal と同じ）。
- JSON の値の入れ子は `maxNestingDepth`（64 段）までにする。`isJsonValue` はそれより深い値を JSON と見なさないので、`CustomTag` は `NaN` などの JSON でない値と同じく `TypeError` を投げ、`defineElement` はその属性を `props` に含めない。
- `on` で始まる名前（`once` を含む）、`style`、`id`、`data-hs-*` は型と実行時の両方で拒否する。`id` を拒否するのは、ブラウザだけで変わる `id` が子を自分で描く要素を更新のたびに作り直すためである。`json` の属性に `data-*` の名前は使えない（`CustomTag` は `data-*` の props を文字列、数、真偽値として渡すため、型と実行時の両方で拒否する）。ランタイムは値が変わらない属性を書かないので、ほかのシグナルの書き込みで `attributeChangedCallback` は呼ばれない。JSON の属性も同じ文字列かどうかで判定する。型は宣言していないキーを検査できないので、変数から渡したオブジェクトでは余分なキーも書かれる。
- タグ名は HTML が予約している名前（`font-face` など）を拒否する。イベント名は、ランタイムがすべての要素に委譲で扱う `click`、`input`、`change`、`submit` を型と実行時の両方で拒否する。送信中のクリックを捨てる処理などと衝突するためである。

#### イベント

- イベントは `data-hs-on-custom` にイベント名と文の組で書き、ランタイムがリスナーを付ける。ハンドラの中の `call` の `onSuccess` と `onError` も、発火したイベントの `detail` を読める。ボタンのような送信中のスキップはせず、送信中でもイベントを実行する（エディタやピッカーは頻繁にイベントを出し、捨てると入力を失うため）。リスナーは要素が挿入されたあとの次の描画で付くので、`connectedCallback` の中の同期的なイベントは取りこぼす。
- 更新の HTML は DOMPurify が検査する。カスタム要素は `isCustomElementName` を満たすタグだけを残す。属性は DOMPurify の許可一覧にあるもの、`data-*` と `aria-*`、`isBindableCustomAttribute` を満たすものが残る。URL の値を検査するのは許可一覧の属性だけなので、一覧にない属性は `javascript:` のような値も残る。`is` による拡張した組み込み要素は受け付けない。

#### 子を自分で描く要素

`ownsChildren` の要素は、morph（`src/morph.ts` の `morphView`）がタグ、`data-hs-owns-children`、`id` が一致するときだけ子を残し、一致しなければ Idiomorph の終了後に作り直す。残した要素では、`data-hs-element-attr` と `data-hs-element-json` に書かれた属性をサーバーの HTML から写さず、ランタイムに任せる。要素の `attributeChangedCallback` がサーバーの一時的な値を見ないためで、サーバーが変えるつもりだった束縛済みの属性は、ランタイムが同じ tick のうちに描画し直すまで待つ。サーバーが固定の値として描いた JSON の属性は、ほかの属性と同じく写す。

子はライブラリが描き、ユーザーの内容を含むことがあるので、ランタイムは子の中の hypersig の属性（束縛、委譲するイベントのハンドラ、スナップショット、値の束縛、ref、カスタムイベントのリスナー、Action のボタン、`data-hs-form` のフォーム、`data-hs-error` と `data-hs-field-error` の出力先、`data-hs-draft-form` と `data-hs-draft` の下書き）を無視する。要素そのものは対象に残る。委譲するイベントは、子の中のハンドラを飛ばして要素そのものか外側のいちばん近いハンドラを実行する。`src/browser.ts` のボタンとフォームの委譲は既定の動作を止めたうえでランタイムの `send` / `sendForm` に渡し、ランタイムが子の中のものを送らない。既定の動作を止めるので、偽のフォームがブラウザの通常の送信で Action を送ることもない。出力先と下書きは `src/browser.ts` と `src/drafts.ts` が探すので、そこでも子の中のものを飛ばす。判定はどれもランタイムの `isOwnedChild` を使う。`ownsChildren: false` の要素の子は Live View の更新で消える。

#### defineElement

ブラウザ側は `defineElement(declaration, { mount(host, props, emit) { return { update, unmount }; } })`（`src/define-element.ts`）で書く。

- 宣言のタグ名で `customElements.define` を呼び、同じタグが定義済みなら例外にする。`observedAttributes` は宣言の属性名から作る。
- `props` は宣言の属性の型から決まり、各項目は省略可能になる。属性がない、`number` が有限の数にならない、`data-*` や `aria-*` の真偽値が `"true"` か `"false"` でない、`json` が JSON として読めないか 64 段より深く入れ子になっている、という属性は `props` に含めず、`undefined` として読む。`number` は `Number()` で読むので、`"0x10"` や `"1e3"` も数になる。空の文字列は数にしない。`json` の値は `JSON.parse` で読めることしか検査せず、宣言した `T` の形かどうかは実行時に検査しない。
- `emit(name, detail)` の `name` と `detail` は宣言で検査する。`bubbles: false` の `CustomEvent` を発火し、`data-hs-on-custom` のリスナーが受ける。
- `connectedCallback` で `mount` を呼ぶ。`attributeChangedCallback` は、同じタスクの中の変更をまとめ、マイクロタスクで一度だけ `update` を呼ぶ（Live View の morph で複数の属性が同時に変わるため）。`update` には宣言したすべての属性を読み直して渡す。`disconnectedCallback` で `unmount` を呼ぶ。`unmount` の前の変更は `update` に届かない。切り離してから同じ要素を挿し直したら、もう一度 `mount` する（要素を動かすと `unmount` のあとに `mount` が走る）。
- `mount` が例外を投げると、その要素は `mount` されないままになり、`update` も `unmount` も呼ばれない。その要素を挿し直すまで、もう一度 `mount` することはない。
- `ownsChildren: true` の宣言では、`mount` は `host` の子を自由に描ける。SSR で置いた仮の子は `mount` が消してよい。

宣言と要素の JavaScript の突き合わせは、`defineElement` を使うときだけ型で行う。`props` と `emit` の型は宣言から決まるので、読まない属性や宣言にないイベントは型エラーになる。`customElements.define` で直接書いた要素は、今までどおり突き合わせない。要素が読まない属性や発火しないイベントは何も起こさず、別の形の `detail` はそのまま文に届く（JSON でなければ `null`）。

#### React アダプター

`reactElement(declaration, Component)`（`src/react.tsx`）は `defineElement` の上に作る。`mount` で `createRoot(host)` を作って描き、`update` で同じ root に描き直し、`unmount` で `root.unmount()` する。同じ root への描き直しなので、部品の内部の状態は残る。部品の props は宣言の属性の型（省略可能）と `emit` で、合わない部品は型エラーになる。React が子を描くので、`ownsChildren: true` の宣言だけを受け付け、`false` の宣言は型エラーにする。`unmount` は `disconnectedCallback` から呼ぶため、外側の React の木が commit の最中にこの要素を外すと、React の処理中に `root.unmount()` を呼ぶことになり、React が警告する。ページはサーバーが描くので、通常は外側に React の木はない。

アイランドはサーバーで描かない。サーバーの HTML は、部品が描く前の仮の子（上の例では行の一覧）だけで、`mount` が置き換える。Shadow DOM も使わない。部品の DOM は通常の DOM なので、ページの CSS が当たり、`ownsChildren` の規則で hypersig の属性が無視される。

#### JSON の属性と Live View

Live View の `render` の中で `<CustomTag of={list} items={todos} />` のように書くと、サーバーが JSON の属性を描く。Topic の更新で Live View が描き直されると属性が変わり、morph が残した要素の `attributeChangedCallback` から `update` に届く。JSON の属性の大きさに上限は設けない。属性の値はそのままページの HTML と更新の HTML に入り、Live View が描き直されるたびに全体を送るので、一覧の行数が多いときは更新境界を小さくする（行ごとに別の Live View にする、一覧を分ける）。Live View ごとに描き直す方針は、ほかの View と同じである。

#### サンプルの並べ替え

`examples/sortable` は React と dnd-kit の部品を `reactElement` で載せる。Live View が一覧を JSON の属性で渡し、並べ替えたら `emit("reorder", keys)` から Action で保存し、Topic を発行して、ほかのタブの Live View が新しい順で描き直す。

- 手を離した位置は、処理中として薄く表示したまま残す。確定した並びが属性で届いたらそちらに置き換える。保存が失敗したら、Action の `call` の `onError` で `failures` の Signal を書き換え、`bindElement` で部品の属性に渡す。部品は属性が変わったら手元の並びを捨てて、サーバーの並びに戻る。フレームワークに失敗の API は足していない。
- 処理中は行をドラッグできないので、保存は同時に1つだけ走り、その結果が処理中の表示を消す。
- ドラッグ中に別のタブの更新が届いても、ドロップするまで反映を待つ。ほかのタブの並べ替えのあとにドロップしたときは、画面の位置ではなくキーで移動を適用する。
- キーボードでの並べ替えは dnd-kit の `KeyboardSensor` を使う。

`examples/rating` は同じ宣言を `defineElement` で実装している。

### ランタイムの大きさ

`dist/runtime.js` を `bun build src/browser.ts --target=browser --minify` で作り、設計の計画を書いたコミット（dd55741）と Signal の実装後で比べた。

| 時点                   | minify 後 | gzip -9  |
| ---------------------- | --------- | -------- |
| dd55741（Signal の前） | 49,571 B  | 18,411 B |
| Signal の実装後        | 57,668 B  | 21,112 B |
| 増分                   | 8,097 B   | 2,701 B  |

gzip での増分は目安の 4 KB 以下に収まった。

仮の行を取り除いたあと、仮の行の計画を書いたコミット（6445c3a）と現在を同じ方法で比べた（Bun 1.3.1、gzip -9）。増分は `form({ onSubmit })` の送信処理と、morph でも `data-hs-pending` を残す処理である。

| 時点                   | minify 後 | gzip -9  |
| ---------------------- | --------- | -------- |
| 6445c3a（仮の行の前）  | 58,168 B  | 21,298 B |
| 仮の行を取り除いたあと | 58,462 B  | 21,366 B |
| 増分                   | 294 B     | 68 B     |

暗黙の楽観的な書き戻しを取り除いたあと、同じ 6445c3a と現在を同じ方法で比べた（Bun 1.3.1、gzip -9）。書き込みの記録、スナップショットの保留、失敗時の書き戻しがなくなった。

| 時点                       | minify 後 | gzip -9  |
| -------------------------- | --------- | -------- |
| 6445c3a（仮の行の前）      | 58,168 B  | 21,298 B |
| 暗黙の書き戻しを除いたあと | 57,900 B  | 21,149 B |
| 増分                       | -268 B    | -149 B   |

カスタム要素の実装後に、計画を書いたコミット（9c3ccf7）と現在を同じ方法で比べた（Bun 1.3.1、gzip -9）。増分はカスタム属性の束縛、カスタムイベントのリスナー、サニタイズの設定、子を残す morph である。最終レビューの修正で、値が変わらない属性を書かない処理と、子を自分で描く要素の中を無視する処理が加わった。

| 時点                        | minify 後 | gzip -9  |
| --------------------------- | --------- | -------- |
| 9c3ccf7（カスタム要素の前） | 58,002 B  | 21,174 B |
| カスタム要素の実装後        | 60,580 B  | 22,248 B |
| 最終レビューの修正後        | 60,913 B  | 22,374 B |
| 増分（修正後まで）          | 2,911 B   | 1,200 B  |

アイランドの実装後に、この計画を書いたコミット（c2332fa）と現在を同じ方法で比べた（Bun 1.3.1、gzip -9）。増分は `json` の属性を書く処理で、`data-hs-element-json` の名前の読み取りと `formatJsonAttribute` の呼び出しである。`defineElement` と `reactElement` は別の入口なので、ランタイムには入らない。

| 時点                                   | minify 後 | gzip -9  |
| -------------------------------------- | --------- | -------- |
| c2332fa（アイランドの前）              | 61,674 B  | 22,615 B |
| 宣言の値と JSON の属性の実装後（現在） | 61,925 B  | 22,674 B |
| 増分                                   | 251 B     | 59 B     |

キー、フォーカス、タイマー、条件の実装後に、設計を書いたコミット（93a68e5）と現在を同じ方法で比べた（Bun 1.3.1、gzip -9）。増分は式の評価、`on.keydown`、フォーカスの出入り、タイマーの予約、`when` である。

| 時点                                 | minify 後 | gzip -9  |
| ------------------------------------ | --------- | -------- |
| 93a68e5（Signal の命令を足す前）     | 61,925 B  | 22,674 B |
| キー、フォーカス、タイマー、条件の後 | 65,086 B  | 23,707 B |
| 増分                                 | 3,161 B   | 1,033 B  |

gzip での増分は目安の 4 KB 以下に収まった。

## 独立した View の描画

一つの接続では、トップレベルの Live View ごとに購読と再描画を進める。別のトップレベル View が非同期データ取得を待っていても、準備ができた View は HTML を送信できる。同じ親子ツリー内は、親の境界が確定してから子を反映する順序を守る。SSE の送信とバージョンは接続で共有するため、通信が詰まれば同じ接続の配信全体に影響する。一接続あたりの上限は既存の32 View で、その範囲で並行する。

同じ接続の `liveShared` または版照合を設定した通常のリーフ View では、通常の Topic 更新でも HTML が直前と同じなら送信を省く。子境界の増減や、描画エラーからの回復に必要な断片は送信する。接続アダプターが一つのフレームの受け入れを既定で30秒以内に完了できない場合は、接続を閉じて既存の再接続経路に戻す。上限は `sendTimeoutMs` で調整できる。

明細と合計のように同時に見せる必要がある値は、一つの Live View で同じスナップショットから読み、単一の HTML 断片にする。注文サマリーでは、集計の読み取り中に別の変更が確定しても、先に取得した注文明細の版に対応する合計を描画する。ブラウザテストでは集計に120msの待ちを入れ、二回の注文変更を送り、DOM に異なる版や不一致の金額が現れないことを確認する。

## 接続間での描画共有

`liveShared({ load, renderShared, ... })` は子 View を持たない表示向け。まず接続ごとに認可と `load` を実行する。同じ定義で、`load` が返したプリミティブ値が等しい場合だけ、更新用の HTML を再利用する。直近の一値を定義ごと、ランタイムごとに保持し、失敗した描画は取り除く。`renderShared` は受け取った値からだけ HTML を生成する。ユーザー属性や時刻が表示に必要なら、その情報を値に含めるか、通常の `live` を使う。配信前の認可、ストリームごとのバージョン、接続ごとの送信は共有しない。[計測](../bench/README.md#接続間での描画共有)

### 同時に進行する読み取りの共有

`liveShared(definition, { shareLoad(params, user) { ... } })` を明示した View は、認可後に `{ scope, revision, load }` を選べる。`scope` はリソースと可視範囲の両方を区別する。たとえばテナント ID、注文 ID、閲覧できる項目の範囲を含める。`revision` は読み取る確定済みの版で、`load()` は選んだ版のデータを取得する。個別に取得する場合は `shareLoad` が `undefined` を返すと通常の `load(params, user)` が実行される。

ライブラリは同じ View 定義の同じスコープ・版について、進行中の Promise を共有する。成功・失敗の両方で登録を取り除く。View の配信前にも接続ごとに認可を確認する。データの版を選ぶ処理は各接続で実行されるため、選択時にも DB を読むアプリではそのコストが残る。読み取りの削減量は取得が重なる度合いで変わる。[読み取り共有の計測](../bench/README.md#接続間での読み取り共有)
