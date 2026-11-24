/// <reference types="bun" />
import { Context, Hono } from "hono";
import { hc } from "hono/client";
import { getCookie, setCookie } from "hono/cookie";
import { validator } from "hono/validator";
import * as v from "valibot";
import {
  ActionError,
  createHypersig,
  createMemoryPubSub,
  live,
  on,
  signalFamily,
  signals,
  topic,
  uuid,
} from "../../src/index.js";
import {
  applyTodoAction,
  compareTodos,
  filters,
  selectTodos,
} from "./todos.js";
import type { Filter, Partition, Todo, TodoAction } from "./todos.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
const stylesheet = Bun.file(new URL("./style.css", import.meta.url));
const sessions = new Set<string>();
const cookie = "todo-session";
let todos: readonly Todo[] = [];

const todosChanged = topic("todos", (partition: Partition) => partition);
const countsChanged = topic("todo-counts", () => "shared");
type TodoEvent =
  | ReturnType<typeof todosChanged>
  | ReturnType<typeof countsChanged>;

const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<TodoEvent>(),
  authenticate(request) {
    const sessionId = getCookie(new Context(request), cookie);
    return sessionId && sessions.has(sessionId) ? { sessionId } : null;
  },
});

async function commit(action: TodoAction): Promise<true> {
  const next = applyTodoAction(todos, action);
  const changes = compareTodos(todos, next);
  todos = next;
  const events: TodoEvent[] = changes.partitions.map(todosChanged);
  if (changes.countsChanged) events.push(countsChanged());
  await Promise.all(events.map(hypersig.publish));
  return true;
}

/** The same-origin page that posted a native form, or the list. */
function returnPath(request: Request): string {
  const referrer = URL.parse(request.headers.get("Referer") ?? "");
  return referrer?.origin === origin
    ? referrer.pathname + referrer.search
    : "/";
}

const title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const todoKey = v.pipe(v.string(), v.uuid());
// Every authenticated demo session can read and edit the shared list.
const sharedAction = { authorize: () => true, output: v.literal(true) };
const add = hypersig.action("add-todo", {
  ...sharedAction,
  input: v.object({ todoKey, todoTitle: title }),
  execute: ({ todoKey, todoTitle }) => {
    // The browser picks the key so its preview can match the confirmed row.
    if (todos.some((todo) => todo.key === todoKey)) {
      throw new ActionError(409, "A task with this key already exists.");
    }
    return commit({ kind: "add", key: todoKey, title: todoTitle });
  },
  // Without JavaScript the browser posts the form itself, so send it back to
  // the list it came from.
  formResponse(result, request) {
    if (result.type === "success") {
      return new Response(null, {
        status: 303,
        headers: { Location: returnPath(request) },
      });
    }
    const message =
      result.type === "rejected"
        ? result.error.message
        : result.issues.map((issue) => issue.message).join(" ");
    return new Response(message, {
      status: result.type === "rejected" ? result.error.status : 422,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});
const edit = hypersig.action("edit-todo", {
  ...sharedAction,
  input: v.object({ todoKey, todoTitle: title }),
  execute: ({ todoKey, todoTitle }) =>
    commit({ kind: "edit", key: todoKey, title: todoTitle }),
});
const remove = hypersig.action("remove-todo", {
  ...sharedAction,
  input: v.object({ todoKey }),
  execute: ({ todoKey }) => commit({ kind: "remove", key: todoKey }),
});
const toggle = hypersig.action("set-todo-completed", {
  ...sharedAction,
  input: v.object({ todoKey, completed: v.boolean() }),
  execute: ({ todoKey, completed }) =>
    commit({ kind: "set-completed", key: todoKey, completed }),
});
const toggleAll = hypersig.action("set-all-todos-completed", {
  ...sharedAction,
  input: v.object({ completed: v.boolean() }),
  execute: ({ completed }) => commit({ kind: "set-all-completed", completed }),
});
const clear = hypersig.action("clear-completed-todos", {
  ...sharedAction,
  input: v.object({}),
  execute: () => commit({ kind: "clear-completed" }),
});

const rows = signalFamily(
  { completed: false, removed: false },
  { name: "todo-row" }
);
const composer = signals({ title: "", key: "" }, { name: "composer" });

function TodoRow({ todo }: { todo: Todo }) {
  const editor = `edit-${todo.key}`;
  const r = rows.at(todo.key).with({ completed: todo.completed });
  return (
    <li
      id={`todo-${todo.key}`}
      {...r.init()}
      {...r.bindAttr({ "data-completed": r.completed })}
      {...r.bindShow(r.removed.not())}
    >
      <div class="row">
        <button
          type="button"
          class="toggle"
          aria-label={`Completed: ${todo.title}`}
          {...r.bindAttr({ "aria-pressed": r.completed })}
          {...on.click([
            r.completed.toggle(),
            toggle.call({ todoKey: todo.key, completed: r.completed }),
          ])}
        >
          <span
            aria-hidden="true"
            {...r.bindText(r.completed.choose("✓", "○"))}
          >
            {todo.completed ? "✓" : "○"}
          </span>
        </button>
        <span class="title">{todo.title}</span>
        <button
          type="button"
          popovertarget={editor}
          aria-label={`Edit: ${todo.title}`}
        >
          Edit
        </button>
        <button
          type="button"
          aria-label={`Delete: ${todo.title}`}
          {...on.click([
            r.removed.set(true),
            remove.call({ todoKey: todo.key }),
          ])}
        >
          Delete
        </button>
      </div>
      <div id={editor} popover="auto" class="editor">
        <form {...edit.form()}>
          <input type="hidden" name={edit.field("todoKey")} value={todo.key} />
          <label>
            Task title
            <input
              name={edit.field("todoTitle")}
              value={todo.title}
              required
              maxLength={200}
              autoFocus
            />
          </label>
          <button type="submit">Save</button>
          <button
            type="button"
            popovertarget={editor}
            popovertargetaction="hide"
          >
            Close
          </button>
        </form>
      </div>
    </li>
  );
}

const list = live({
  name: "todos",
  key: ({ filter }: { filter: Filter }) => filter,
  subscribe: ({ filter }) =>
    filter === "all"
      ? [todosChanged("active"), todosChanged("completed")]
      : [todosChanged(filter)],
  authorize: () => true,
  load: ({ filter }) => ({ filter, visible: selectTodos(todos, filter) }),
  render: ({ filter, visible }) => {
    const acceptsNewTodos = filter !== "completed";
    return (
      <section aria-label="Task list">
        {(acceptsNewTodos || visible.length > 0) && (
          <ul>
            {visible.map((todo) => (
              <TodoRow todo={todo} />
            ))}
          </ul>
        )}
        {visible.length === 0 && <p class="empty">No tasks in this view.</p>}
      </section>
    );
  },
});

const counts = live({
  name: "todo-counts",
  subscribe: () => [countsChanged()],
  authorize: () => true,
  load: () => ({
    active: selectTodos(todos, "active").length,
    completed: selectTodos(todos, "completed").length,
  }),
  render: ({ active, completed }) => (
    <section class="counts" aria-label="Task counts">
      <span>
        {active} {active === 1 ? "item" : "items"} left
      </span>
      {active + completed > 0 && (
        <button type="button" {...toggleAll.bind({ completed: active > 0 })}>
          {active > 0 ? "Complete all" : "Reopen all"}
        </button>
      )}
      {completed > 0 && (
        <button type="button" {...clear.bind({})}>
          Clear completed
        </button>
      )}
    </section>
  ),
});

const labels: Record<Filter, string> = {
  all: "All",
  active: "Active",
  completed: "Completed",
};

const querySchema = v.object({ filter: v.optional(v.picklist(filters)) });

const app = new Hono()
  .route("/", hypersig.routes)
  .get(
    "/",
    validator("query", (query) => {
      const parsed = v.safeParse(querySchema, query);
      // An unknown filter shows every task, as the All link does.
      return parsed.success ? parsed.output : {};
    }),
    (c) => renderTodos(c, c.req.valid("query").filter ?? "all")
  )
  .get("/health", (c) => c.text("OK"))
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
const filterLink = (filter: Filter) =>
  links.index.$path({ query: filter === "all" ? {} : { filter } });

async function renderTodos(c: Context, filter: Filter): Promise<Response> {
  const current = getCookie(c, cookie);
  if (!current || !sessions.has(current)) {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
    setCookie(c, cookie, sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    const { pathname, search } = new URL(c.req.url);
    return c.redirect(pathname + search);
  }
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  // Without JavaScript the form posts this key, so each page gets its own.
  // With JavaScript, the submit statements replace it before every send.
  const entry = composer.with({ key: crypto.randomUUID() });
  return hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>hypersig TodoMVC</title>
        <link rel="stylesheet" href="/style.css" />
        {page.runtime("/runtime.js")}
      </head>
      <body>
        <main>
          <h1>Todos</h1>
          <form
            class="composer"
            {...entry.init()}
            {...add.form({
              resetOnSuccess: true,
              onSubmit: [entry.key.set(uuid())],
            })}
          >
            <label for="new-todo">New task</label>
            <input
              type="hidden"
              name={add.field("todoKey")}
              {...entry.bindValue(entry.key)}
            />
            <div>
              <input
                id="new-todo"
                name={add.field("todoTitle")}
                required
                maxLength={200}
                {...entry.bindValue(entry.title)}
              />
              <button type="submit">Add</button>
            </div>
          </form>
          <nav aria-label="Filter tasks">
            {filters.map((value) => (
              <a
                href={filterLink(value)}
                aria-current={value === filter ? "page" : undefined}
              >
                {labels[value]}
              </a>
            ))}
          </nav>
          {page.view(list, { filter })}
          {page.view(counts, {})}
          <p role="status" data-hs-connection-status=""></p>
          <p role="alert" data-hs-error=""></p>
        </main>
      </body>
    </html>
  ));
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`TodoMVC listening on ${origin}`);
