/// <reference types="bun" />
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { Context, Hono } from "hono";
import { hc } from "hono/client";
import { getCookie, setCookie } from "hono/cookie";
import * as v from "valibot";
import {
  connectionStatusOutlet,
  createHypersig,
  createMemoryPubSub,
  errorOutlet,
  lit,
  on,
  ref,
  refs,
  signals,
  timer,
  topic,
  when,
} from "../../src/index.js";

const port = Number(Bun.env.PORT ?? 3000);
const origin = `http://127.0.0.1:${port}`;
const runtime = Bun.file(new URL("../../dist/runtime.js", import.meta.url));
const stylesheet = Bun.file(new URL("./style.css", import.meta.url));
const cookie = "widgets-session";

const fruits = [
  { key: "apple", label: "Apple" },
  { key: "banana", label: "Banana" },
  { key: "cherry", label: "Cherry" },
  { key: "grape", label: "Grape" },
  { key: "mango", label: "Mango" },
  { key: "orange", label: "Orange" },
] as const;
type Fruit = (typeof fruits)[number]["key"];
const fruitKeys = fruits.map(({ key }) => key);
const fruitKeyList = lit(fruitKeys);
const fruitLabels = lit(fruits.map(({ label }) => label));
// Option `id`s are the application's own strings, as TodoMVC's editor ids are.
const optionId = (fruit: Fruit) => `fruit-option-${fruit}`;
const optionIds = lit(fruits.map(({ key }) => optionId(key)));
const lastFruit = fruits.length - 1;

const tabs = [
  {
    key: "overview",
    label: "Overview",
    body: "A teapot that keeps tea warm for an hour.",
  },
  { key: "specs", label: "Specs", body: "Capacity 600 ml. Weight 450 g." },
  { key: "reviews", label: "Reviews", body: "4.6 out of 5 from 120 reviews." },
] as const;
const tabKeys = lit(tabs.map(({ key }) => key));

const countries = ["Brazil", "Canada", "Germany", "Japan", "Kenya", "Norway"];
const messageLength = 80;

interface Session {
  fruit: Fruit;
  draft: string;
}
const sessions = new Map<string, Session>();

const fruitChanged = topic("fruit", (sessionId: string) => sessionId);
const draftChanged = topic("draft", (sessionId: string) => sessionId);
type WidgetEvent =
  | ReturnType<typeof fruitChanged>
  | ReturnType<typeof draftChanged>;

function readSession(request: Request) {
  const sessionId = getCookie(new Context(request), cookie);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  return sessionId && session ? { sessionId, session } : null;
}

const hypersig = createHypersig({
  origin,
  pubsub: createMemoryPubSub<WidgetEvent>(),
  // `v.trim()` has no JSON Schema form. Skipping it leaves the length limit,
  // which the browser checks against the untrimmed value.
  jsonSchema: { libraryOptions: { ignoreActions: ["trim"] } },
  authenticate: readSession,
});

const saveFruit = hypersig.action("save-fruit", {
  input: v.object({ fruit: v.picklist(fruitKeys) }),
  output: v.literal(true),
  authorize: () => true,
  async execute({ fruit }, { sessionId, session }) {
    if (session.fruit !== fruit) {
      session.fruit = fruit;
      await hypersig.publish(fruitChanged(sessionId));
    }
    return true as const;
  },
});

const sendMessage = hypersig.action("send-message", {
  input: toStandardJsonSchema(
    v.object({
      message: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(messageLength)
      ),
    })
  ),
  output: v.literal(true),
  authorize: () => true,
  execute: () => true as const,
});

const saveDraft = hypersig.action("save-draft", {
  input: v.object({ draft: v.pipe(v.string(), v.maxLength(1000)) }),
  output: v.literal(true),
  authorize: () => true,
  async execute({ draft }, { sessionId, session }) {
    session.draft = draft;
    await hypersig.publish(draftChanged(sessionId));
    return true as const;
  },
});

const savedFruit = hypersig.live({
  name: "saved-fruit",
  subscribe: (_params: Record<string, never>, { sessionId }) => [
    fruitChanged(sessionId),
  ],
  authorize: () => true,
  load: (_params, { session }) => session.fruit,
  render: (fruit) => (
    <p>
      Saved fruit:{" "}
      <strong id="saved-fruit">
        {fruits.find(({ key }) => key === fruit)?.label}
      </strong>
    </p>
  ),
});

const savedDraft = hypersig.live({
  name: "saved-draft",
  subscribe: (_params: Record<string, never>, { sessionId }) => [
    draftChanged(sessionId),
  ],
  authorize: () => true,
  load: (_params, { session }) => session.draft,
  render: (draft) => (
    <p>
      Saved draft: <q id="saved-draft">{draft}</q>
    </p>
  ),
});

// Groups, refs and timers are defined once here, so their IDs stay the same
// across renders.
const combo = signals(
  { open: false, active: 0, selected: 0 },
  { name: "fruit" }
);
const comboRef = ref({ name: "fruit-combobox" });
const tabState = signals({ active: 0 }, { name: "tabs" });
const tabRefs = refs({ name: "tab" });
const disclosure = signals({ open: false }, { name: "display-options" });
const disclosureRef = ref({ name: "display-options-button" });
const feedback = signals({ message: "" }, { name: "feedback" });
const toast = signals({ visible: false }, { name: "toast" });
const toastTimer = timer({ name: "toast-hide" });
const countryFilter = signals({ query: "" }, { name: "country-filter" });
const draft = signals({ text: "" }, { name: "draft" });
const draftTimer = timer({ name: "draft-save" });

function FruitCombobox({ fruit }: { fruit: Fruit }) {
  const index = fruitKeys.indexOf(fruit);
  const c = combo.with({ selected: index, active: index });
  // Opening starts from the chosen option; an open list moves its active one.
  const move = (to: Parameters<typeof c.active.set>[0]) => [
    c.active.set(c.open.choose(to, c.selected)),
    c.open.set(true),
  ];
  const pick = [
    c.selected.set(c.active),
    c.open.set(false),
    saveFruit.call({ fruit: fruitKeyList.at(c.active, "apple") }),
  ];
  // Enter and Space open a closed list and pick from an open one; only the
  // pick saves.
  const openOrPick = when(c.open, pick, [
    c.active.set(c.selected),
    c.open.set(true),
  ]);
  return (
    <section aria-labelledby="fruit-heading" class="widget">
      <h2 id="fruit-heading">Select-only combobox</h2>
      <div
        class="combobox"
        {...c.init()}
        {...on.focusLeave([c.open.set(false)])}
      >
        <span id="fruit-label" class="label">
          Favorite fruit
        </span>
        {/* The keys that save sit on this element, so the save in flight
            skips only them: the arrow keys on the combobox keep working, and
            closing on focus leaving still runs on the element outside. */}
        <div
          class="combobox-field"
          {...on.keydown({
            Enter: openOrPick,
            " ": openOrPick,
            // Tab and Shift+Tab move focus on; an open list picks its active
            // option first.
            Tab: when(c.open, pick),
            "Shift+Tab": when(c.open, pick),
          })}
        >
          <div
            role="combobox"
            tabindex={0}
            aria-haspopup="listbox"
            aria-labelledby="fruit-label"
            aria-controls="fruit-listbox"
            class="combobox-button"
            {...comboRef.attr()}
            {...c.bindAttr({
              "aria-expanded": c.open,
              "aria-activedescendant": c.open.choose(
                optionIds.at(c.active, ""),
                ""
              ),
            })}
            {...on.click([c.active.set(c.selected), c.open.toggle()])}
            {...on.keydown({
              ArrowDown: move(c.active.add(1).clamp(0, lastFruit)),
              ArrowUp: move(c.active.sub(1).clamp(0, lastFruit)),
              Home: move(0),
              End: move(lastFruit),
              Escape: [c.open.set(false)],
            })}
          >
            <span {...c.bindText(fruitLabels.at(c.selected, ""))} />
          </div>
          <div
            id="fruit-listbox"
            role="listbox"
            aria-labelledby="fruit-label"
            class="listbox"
            {...c.bindShow(c.open)}
          >
            {fruits.map(({ key, label }, i) => (
              // `tabindex="-1"` lets a click focus the option, so focus stays
              // inside the combobox instead of leaving for the page body.
              <div
                id={optionId(key)}
                role="option"
                tabindex={-1}
                class="option"
                {...c.bindAttr({ "aria-selected": c.active.eq(i) })}
                {...on.click([
                  c.selected.set(i),
                  c.active.set(i),
                  c.open.set(false),
                  saveFruit.call({ fruit: key }),
                  comboRef.focus(),
                ])}
              >
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductTabs() {
  const t = tabState.with({});
  const count = tabs.length;
  const select = (index: Parameters<typeof t.active.set>[0]) => [
    t.active.set(index),
    tabRefs.focus(tabKeys.at(t.active, "")),
  ];
  return (
    <section aria-labelledby="tabs-heading" class="widget" {...t.init()}>
      <h2 id="tabs-heading">Tabs</h2>
      <div
        role="tablist"
        aria-label="Product details"
        class="tablist"
        {...on.keydown({
          ArrowRight: select(t.active.add(1).mod(count)),
          ArrowLeft: select(t.active.sub(1).mod(count)),
          Home: select(0),
          End: select(count - 1),
        })}
      >
        {tabs.map(({ key, label }, i) => (
          <button
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-controls={`panel-${key}`}
            {...tabRefs.attr(key)}
            {...t.bindAttr({
              "aria-selected": t.active.eq(i),
              tabindex: t.active.eq(i).choose(0, -1),
            })}
            {...on.click([t.active.set(i)])}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(({ key, body }, i) => (
        <div
          role="tabpanel"
          id={`panel-${key}`}
          aria-labelledby={`tab-${key}`}
          tabindex={0}
          class="tabpanel"
          {...t.bindShow(t.active.eq(i))}
        >
          {body}
        </div>
      ))}
    </section>
  );
}

function DisplayOptions() {
  const d = disclosure.with({});
  return (
    <section aria-labelledby="disclosure-heading" class="widget">
      <h2 id="disclosure-heading">Disclosure</h2>
      <div
        class="disclosure"
        {...d.init()}
        {...on.focusLeave([d.open.set(false)])}
        {...on.keydown({
          Escape: [d.open.set(false), disclosureRef.focus()],
        })}
      >
        <button
          type="button"
          aria-controls="display-options"
          {...disclosureRef.attr()}
          {...d.bindAttr({ "aria-expanded": d.open })}
          {...on.click([d.open.toggle()])}
        >
          Display options
        </button>
        <div id="display-options" class="panel" {...d.bindShow(d.open)}>
          <label>
            <input type="checkbox" /> Show prices
          </label>
          <label>
            <input type="checkbox" /> Compact rows
          </label>
        </div>
      </div>
    </section>
  );
}

function MessageForm() {
  const m = feedback.with({});
  const n = toast.with({});
  return (
    <section aria-labelledby="message-heading" class="widget">
      <h2 id="message-heading">Counter and toast</h2>
      <form
        {...m.init()}
        {...sendMessage.form({
          resetOnSuccess: true,
          onSuccess: () => [
            n.visible.set(true),
            toastTimer.after(3000, [n.visible.set(false)]),
          ],
        })}
      >
        <label for="message">Message</label>
        <input
          id="message"
          aria-describedby="message-remaining"
          {...sendMessage.control("message")}
          {...m.bindValue(m.message)}
        />
        <p id="message-remaining">
          <span {...m.bindText(lit(messageLength).sub(m.message.length()))} />{" "}
          characters left
        </p>
        <button
          type="submit"
          {...m.bindAttr({ disabled: m.message.trim().length().eq(0) })}
        >
          Send
        </button>
      </form>
      {/* The live region stays on the page so a screen reader announces the
          text that appears in it. */}
      <p role="status" class="toast-region" {...n.init()}>
        <span id="toast" class="toast" {...n.bindShow(n.visible)}>
          Message sent.
        </span>
      </p>
    </section>
  );
}

function CountryFilter() {
  const f = countryFilter.with({});
  const query = f.query.trim().lower();
  return (
    <section aria-labelledby="filter-heading" class="widget" {...f.init()}>
      <h2 id="filter-heading">Filter</h2>
      <label for="country-filter">Filter countries</label>
      <input id="country-filter" type="search" {...f.bindValue(f.query)} />
      <ul aria-label="Countries">
        {countries.map((country) => (
          <li {...f.bindShow(lit(country.toLowerCase()).includes(query))}>
            {country}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DraftEditor({ text }: { text: string }) {
  const d = draft.with({ text });
  return (
    <section aria-labelledby="draft-heading" class="widget" {...d.init()}>
      <h2 id="draft-heading">Debounced draft</h2>
      <label for="draft">Draft</label>
      <textarea
        id="draft"
        rows={3}
        {...d.bindValue(d.text)}
        {...on.input([
          draftTimer.after(500, [saveDraft.call({ draft: d.text })]),
        ])}
      >
        {text}
      </textarea>
    </section>
  );
}

const app = new Hono()
  .route("/", hypersig.routes)
  .get("/", renderWidgets)
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

async function renderWidgets(c: Context): Promise<Response> {
  const current = readSession(c.req.raw);
  if (!current) {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { fruit: "apple", draft: "" });
    setCookie(c, cookie, sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect(links.index.$path());
  }
  const { session } = current;
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return hypersig.page(c.req.raw, (page) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>hypersig widgets</title>
        <link rel="stylesheet" href={links["style.css"].$path()} />
        {page.runtime(links["runtime.js"].$path())}
      </head>
      <body>
        <main>
          <h1>Widgets</h1>
          <p>Each widget is written with signal statements only.</p>
          <FruitCombobox fruit={session.fruit} />
          {page.view(savedFruit, {})}
          <ProductTabs />
          <DisplayOptions />
          <MessageForm />
          <CountryFilter />
          <DraftEditor text={session.draft} />
          {page.view(savedDraft, {})}
          <p role="status" {...connectionStatusOutlet()}></p>
          <p role="alert" {...errorOutlet()}></p>
        </main>
      </body>
    </html>
  ));
}

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: app.fetch });
console.log(`Widgets listening on ${origin}`);
