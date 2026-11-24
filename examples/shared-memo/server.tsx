/// <reference types="bun" />
import { Database } from "bun:sqlite";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { Context, Hono } from "hono";
import { hc } from "hono/client";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import * as v from "valibot";
import {
  ActionError,
  createHypersig,
  createMemoryPubSub,
  on,
  ref,
  signals,
  topic,
  uuid,
} from "../../src/index.js";
import { createMemoStore } from "./store.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
const stylesheet = Bun.file(new URL("./style.css", import.meta.url));
const cookie = `memo-session-${port}`;
const sessionSecret = Bun.env.MEMO_SESSION_SECRET ?? crypto.randomUUID();
if (sessionSecret.length < 32)
  throw new Error("MEMO_SESSION_SECRET must be at least 32 characters");
const sessionLifetime = 8 * 60 * 60;

async function authenticate(request: Request) {
  const ticket = await getSignedCookie(
    new Context(request),
    sessionSecret,
    cookie
  );
  if (typeof ticket !== "string") return null;
  const [sessionId, draftScope, expires] = ticket.split("/");
  return sessionId && draftScope && Number(expires) > Date.now()
    ? { sessionId, draftScope }
    : null;
}

const maxLength = 1000;
const operationSchema = v.pipe(v.string(), v.uuid());
const revisionSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/),
  v.transform((text) => Number(text)),
  v.check((revision) => Number.isSafeInteger(revision))
);
const conflictMessage =
  "別の編集が先に保存されたため、下書きは保存されていません。共有中の本文を確認してから変更を反映してください。";
const store = createMemoStore(
  new Database(Bun.env.MEMO_DB ?? ":memory:"),
  "引き継ぎメモ\n次の担当者に共有したい内容を書いてください。"
);

const memoChanged = topic("memo", () => "shared");
const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<ReturnType<typeof memoChanged>>(),
  reconcileIntervalMs: 30_000,
  // `v.trim()` has no JSON Schema form. Skipping it leaves the text lengths,
  // which the browser checks against the untrimmed value.
  jsonSchema: { libraryOptions: { ignoreActions: ["trim"] } },
  ...(Bun.env.HYPERSIG_TRACE === "1" && {
    onDiagnostic: (event) => console.info(JSON.stringify(event)),
  }),
  authenticate,
  draftScope: (user) => user.draftScope,
});

function flushOutbox() {
  void store
    .flush(() => hypersig.publish(memoChanged()))
    .catch((error: unknown) => {
      console.error("メモの変更通知を再試行します", error);
    });
}

flushOutbox();
setInterval(flushOutbox, 5000).unref();

const save = hypersig.action("save-memo", {
  input: toStandardJsonSchema(
    v.object({
      operationId: operationSchema,
      memoText: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, "本文を入力してください。"),
        v.maxLength(maxLength, "本文は1000文字以内で入力してください。")
      ),
      baseRevision: revisionSchema,
    })
  ),
  output: v.object({ revision: v.number() }),
  authorize: () => true,
  execute({ memoText, baseRevision, operationId }, { sessionId }) {
    const result = store.save(memoText, baseRevision, {
      sessionId,
      id: operationId,
    });
    switch (result.type) {
      case "stale":
        throw new ActionError(409, conflictMessage);
      case "mismatch":
        throw new ActionError(
          409,
          "同じ保存操作で内容が変わっています。先に共有中の本文を確認し、最新版を読み込んでください。"
        );
      case "saved":
        flushOutbox();
        return { revision: result.revision };
    }
  },
  async formResponse(result, request) {
    if (result.type === "success")
      return new Response(null, { status: 303, headers: { Location: "/" } });
    const submittedText = result.values.get("memoText");
    const baseRevision = v.safeParse(
      revisionSchema,
      result.values.get("baseRevision")
    );
    const operationId = v.safeParse(
      operationSchema,
      result.values.get("operationId")
    );
    const issues = result.type === "invalid" ? result.issues : [];
    const inline = issues.filter((issue) => issue.field === "memoText");
    const general = issues.filter((issue) => issue.field !== "memoText");
    return renderEditor(request, {
      draft: {
        text: typeof submittedText === "string" ? submittedText : "",
        // A malformed revision renders as 0, which the next save rejects.
        revision: baseRevision.success ? baseRevision.output : 0,
      },
      fieldError: inline.map(({ message }) => message).join(" "),
      error:
        result.type === "rejected"
          ? result.error.message
          : general.map(({ message }) => message).join(" "),
      status: result.type === "invalid" ? 422 : result.error.status,
      ...(operationId.success && { operationId: operationId.output }),
    });
  },
});

const editor = signals(
  { base: 0, published: 0, operation: "" },
  { name: "memo-editor" }
);
const draftRef = ref({ name: "memo-draft" });

const publishedMemo = hypersig.live({
  name: "shared-memo",
  subscribe: () => [memoChanged()],
  authorize: () => true,
  load: () => store.read(),
  snapshotRevision: {
    read: () => store.readRevision(),
    from: (snapshot) => snapshot.revision,
  },
  render(current) {
    return (
      <section
        aria-labelledby="published-title"
        class="panel"
        {...editor.with({ published: current.revision }).init()}
      >
        <div class="panel-header">
          <h2 id="published-title">共有中のメモ</h2>
          <output aria-label="共有中の版" data-revision={current.revision}>
            版 {current.revision}
          </output>
        </div>
        <p id="published-memo" class="memo">
          {current.text}
        </p>
      </section>
    );
  },
});

async function showEditor(c: Context): Promise<Response> {
  if (!(await authenticate(c.req.raw))) {
    const ticket = `${crypto.randomUUID()}/${crypto.randomUUID()}/${Date.now() + sessionLifetime * 1000}`;
    await setSignedCookie(c, cookie, ticket, sessionSecret, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      maxAge: sessionLifetime,
    });
    const response = c.redirect(links.index.$path());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  return renderEditor(c.req.raw, { draft: store.read() });
}

async function renderEditor(
  request: Request,
  {
    draft,
    fieldError = "",
    error = "",
    status = 200,
    operationId = crypto.randomUUID(),
  }: {
    draft: { text: string; revision: number };
    fieldError?: string;
    error?: string;
    status?: number;
    operationId?: string;
  }
) {
  const e = editor.with({
    base: draft.revision,
    published: store.readRevision(),
    operation: operationId,
  });
  const response = await hypersig.page(request, (page) => (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>共有メモ</title>
        <link rel="stylesheet" href="/style.css" />
        <link rel="prefetch" href={links.guide.$path()} />
        {page.runtime("/runtime.js")}
      </head>
      <body>
        <main>
          <h1>共有メモ</h1>
          <p>
            <a href={links.guide.$path()}>使い方</a>
          </p>
          <div class="panels">
            <div id="published">{page.view(publishedMemo, {})}</div>
            <section aria-labelledby="edit-title" class="panel">
              <form
                {...save.form({
                  reportSuccess: true,
                  draft: true,
                  onSuccess: (out) => [
                    e.base.set(out.get("revision")),
                    e.operation.set(uuid()),
                  ],
                })}
                {...e.init()}
                id="memo-editor"
              >
                <div class="panel-header">
                  <h2 id="edit-title">下書き</h2>
                  <p>
                    編集元は版{" "}
                    <span id="draft-version" {...e.bindText(e.base)} />
                  </p>
                </div>
                <input
                  type="hidden"
                  {...save.draft("baseRevision")}
                  {...e.bindValue(e.base)}
                />
                <input
                  type="hidden"
                  {...save.draft("operationId")}
                  {...e.bindValue(e.operation)}
                />
                <label for="memo-text">本文</label>
                <textarea
                  id="memo-text"
                  {...save.draft("memoText")}
                  {...save.control("memoText")}
                  {...draftRef.attr()}
                  aria-describedby="memo-text-error"
                  rows={7}
                >
                  {draft.text}
                </textarea>
                <p
                  id="memo-text-error"
                  data-hs-field-error={save.field("memoText")}
                  aria-live="polite"
                >
                  {fieldError}
                </p>
                <p
                  id="restored-draft"
                  role="status"
                  {...e.bindShow(save.draftRestored())}
                >
                  接続の復旧前に書いていた下書きを復元しました。
                </p>
                <div
                  id="newer-version"
                  class="notice"
                  {...e.bindShow(e.published.gt(e.base))}
                >
                  <p role="status">
                    共有中のメモに新しい版があります。本文を見比べてください。
                  </p>
                  <p id="rebase-note">
                    編集元の版だけを切り替えます。次に保存すると、公開中の本文が下書きの内容に置き換わります。
                  </p>
                  <button
                    type="button"
                    id="use-latest-revision"
                    aria-describedby="rebase-note"
                    {...on.click([
                      e.base.set(e.published),
                      e.operation.set(uuid()),
                      draftRef.focus(),
                    ])}
                    {...e.bindAttr({ disabled: save.pending() })}
                  >
                    表示中の版から編集を続ける
                  </button>
                </div>
                <p data-hs-error="" role="alert">
                  {error}
                </p>
                <div class="controls">
                  <button type="submit">保存</button>
                  <span class="pending" role="status">
                    送信中…
                  </span>
                  <a href={links.index.$path()} aria-describedby="reload-note">
                    最新版を読み込む
                  </a>
                </div>
                <p id="reload-note">
                  下書きを残すには、コピーしてから最新版を読み込んでください。
                </p>
              </form>
            </section>
          </div>
          <p data-hs-connection-status="" role="status"></p>
        </main>
      </body>
    </html>
  ));
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return new Response(response.body, {
    status: response.ok ? status : response.status,
    headers: response.headers,
  });
}

function renderGuide(c: Context): Response | Promise<Response> {
  c.header("Cache-Control", "public, max-age=300");
  return c.html(
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>共有メモの使い方</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <main>
          <h1>共有メモの使い方</h1>
          <p>
            引き継ぎたい内容を入力して保存すると、開いている画面に反映されます。
          </p>
          <p>
            別の編集が先に保存された場合は、公開中のメモと下書きを見比べてから、表示中の版を編集元にできます。
          </p>
          <a href={links.index.$path()}>共有メモに戻る</a>
        </main>
      </body>
    </html>
  );
}

const app = new Hono()
  .route("/", hypersig.routes)
  .get("/", showEditor)
  .get("/health", (c) => c.text("OK"))
  .get("/guide", renderGuide)
  .get("/runtime.js", (c) =>
    c.body(runtime.stream(), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    })
  )
  .get("/style.css", (c) =>
    c.body(stylesheet.stream(), {
      headers: { "Content-Type": "text/css; charset=utf-8" },
    })
  );
const links = hc<typeof app>("/");

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`Shared memo listening on ${origin}`);
