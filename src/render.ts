import type {
  LiveRenderContext,
  LiveView,
  Principal,
  SharedLiveView,
  SharedValue,
} from "./live.js";
import { digestHtml } from "./page-token.js";
import type { PageSnapshot } from "./page-token.js";
import type { Topic } from "./topic.js";

export interface LiveRenderer<Markup> {
  empty(): Markup | Promise<Markup>;
  boundary(target: string, content: string): Markup | Promise<Markup>;
  serialize(markup: Markup | Promise<Markup>): string | Promise<string>;
}

export interface ViewInstance<User, Event> {
  definition: { readonly name: string };
  /** The params the view was placed with. */
  params: unknown;
  revision(user: User): string | number | undefined;
  topics(user: User): readonly Event[];
  authorize(user: User): boolean | Promise<boolean>;
  readSnapshotRevision?(user: User): string | number | Promise<string | number>;
  skipUnchanged: boolean;
  /** Set at SSR for a top-level view without children that has a snapshot revision. */
  initialSnapshot?: PageSnapshot;
  render(
    user: User,
    mode: "initial" | "update",
    admit: () => void
  ): Promise<RenderedView<User, Event>>;
}

export interface RenderedView<User, Event> {
  html: string;
  children: ReadonlyMap<string, ViewInstance<User, Event>>;
  snapshotRevision?: string | number;
}

export const maxViews = 32;
const maxDepth = 4;
const keyPattern = /^[a-zA-Z0-9._:-]{1,64}$/;

export type SharedFragments = WeakMap<
  object,
  { data: SharedValue; html: Promise<string> }
>;

/** A definition of any params and data, as the registry stores it. */
export type RegisteredView<
  User extends Principal,
  Event extends Topic,
  Markup,
> =
  | LiveView<unknown, unknown, User, Event, Markup>
  | SharedLiveView<unknown, SharedValue, User, Event, Markup>;

/** Runtime-wide state that every page render of the runtime shares. */
export interface ViewRegistry<
  User extends Principal,
  Event extends Topic,
  Markup,
> {
  shared: SharedFragments;
  /** Records a definition under its name. Throws when the name is invalid or taken. */
  register(definition: RegisteredView<User, Event, Markup>): void;
  /** Returns the name of a registered definition. Throws for one that was never registered. */
  identify(definition: { readonly name: string }): string;
  /** Finds the definition registered under a name. */
  resolve(name: string): RegisteredView<User, Event, Markup> | undefined;
}

export function renderContext<
  User extends Principal,
  Event extends Topic,
  Markup,
>(
  renderer: LiveRenderer<Markup>,
  user: User,
  views: Map<string, ViewInstance<User, Event>>,
  mode: "initial" | "update",
  admit: () => void,
  registry: ViewRegistry<User, Event, Markup>,
  parent?: string
): LiveRenderContext<User, Event, Markup> {
  return {
    async view<Params, Data>(
      definition:
        | LiveView<Params, Data, User, Event, Markup>
        | SharedLiveView<Params, Data & SharedValue, User, Event, Markup>,
      params: Params
    ) {
      if (!(await definition.authorize(params, user))) return renderer.empty();
      const target = viewTarget(
        registry.identify(definition),
        definition,
        params,
        parent
      );
      if (views.has(target)) {
        throw new Error(
          `Invalid, duplicate or too-deep Live View key: ${target}`
        );
      }
      admit();
      const instance = createViewInstance(
        definition,
        params,
        target,
        renderer,
        registry
      );
      views.set(target, instance);
      // Existing child DOM can stay in place while the stream reconciles its subscription.
      if (mode === "update") return renderer.boundary(target, "");
      const result = await instance.render(user, mode, admit);
      if (
        !parent &&
        result.children.size === 0 &&
        result.snapshotRevision !== undefined
      )
        instance.initialSnapshot = {
          revision: result.snapshotRevision,
          digest: await digestHtml(result.html),
        };
      return renderer.boundary(target, result.html);
    },
  };
}

/**
 * Returns the key a view takes in the page: its name, followed by its `key()`
 * when it has one, under its parent's key. Throws for a key that is invalid or
 * nested too deeply.
 */
export function viewTarget<Params>(
  name: string,
  definition: { key?(params: Params): string },
  params: Params,
  parent?: string
): string {
  const key = definition.key?.(params);
  const segment = key === undefined ? name : `${name}.${key}`;
  const target = parent ? `${parent}/${segment}` : segment;
  if (
    (key !== undefined && !keyPattern.test(key)) ||
    target.split("/").length > maxDepth
  ) {
    throw new Error(`Invalid, duplicate or too-deep Live View key: ${target}`);
  }
  return target;
}

/** Binds a definition to its params at a key in the page, ready to render. */
export function createViewInstance<
  User extends Principal,
  Event extends Topic,
  Markup,
  Params,
  Data,
>(
  definition:
    | LiveView<Params, Data, User, Event, Markup>
    | SharedLiveView<Params, Data & SharedValue, User, Event, Markup>,
  params: Params,
  target: string,
  renderer: LiveRenderer<Markup>,
  registry: ViewRegistry<User, Event, Markup>
): ViewInstance<User, Event> {
  const revision =
    "snapshotRevision" in definition ? definition.snapshotRevision : undefined;
  const instance: ViewInstance<User, Event> = {
    definition,
    params,
    revision: (current) => definition.revision?.(params, current),
    topics: (current) => definition.subscribe(params, current),
    authorize: (current) => definition.authorize(params, current),
    skipUnchanged: Boolean(revision) || "renderShared" in definition,
    async render(current, childMode, admitChild) {
      const children = new Map<string, ViewInstance<User, Event>>();
      const { shared } = registry;
      if ("renderShared" in definition) {
        const data = await definition.load(params, current);
        const previous = childMode === "update" && shared.get(definition);
        if (previous && Object.is(previous.data, data))
          return { html: await previous.html, children };
        const html = Promise.resolve(
          renderer.serialize(definition.renderShared(data))
        );
        if (childMode === "update") shared.set(definition, { data, html });
        try {
          return { html: await html, children };
        } catch (error) {
          if (shared.get(definition)?.html === html) shared.delete(definition);
          throw error;
        }
      }
      const data = await definition.load(params, current);
      const snapshotRevision = definition.snapshotRevision?.from(data);
      const context = renderContext(
        renderer,
        current,
        children,
        childMode,
        admitChild,
        registry,
        target
      );
      const html = await renderer.serialize(
        definition.render(data, params, context)
      );
      return {
        html,
        children,
        ...(snapshotRevision !== undefined && { snapshotRevision }),
      };
    },
  };
  if (revision) {
    instance.readSnapshotRevision = (current) => revision.read(params, current);
  }
  return instance;
}
