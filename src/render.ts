import type { LiveRenderContext, Principal } from "./live.js";
import type { Topic } from "./topic.js";

export interface LiveRenderer<Markup> {
  empty(): Markup | Promise<Markup>;
  boundary(target: string, content: string): Markup | Promise<Markup>;
  serialize(markup: Markup | Promise<Markup>): string | Promise<string>;
}

export interface ViewInstance<User, Event> {
  definition: object;
  revision(user: User): string | number | undefined;
  topics(user: User): readonly Event[];
  authorize(user: User): boolean | Promise<boolean>;
  render(
    user: User,
    mode: "initial" | "update",
    admit: () => void
  ): Promise<RenderedView<User, Event>>;
}

export interface RenderedView<User, Event> {
  html: string;
  children: ReadonlyMap<string, ViewInstance<User, Event>>;
}

export const maxViews = 32;
const maxDepth = 4;
const keyPattern = /^[a-zA-Z0-9._:-]{1,64}$/;

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
  parent?: string
): LiveRenderContext<User, Event, Markup> {
  return {
    async view(definition, params) {
      if (!(await definition.authorize(params, user))) return renderer.empty();
      const key = definition.key(params);
      const target = parent ? `${parent}/${key}` : key;
      if (
        !keyPattern.test(key) ||
        views.has(target) ||
        target.split("/").length > maxDepth
      ) {
        throw new Error(
          `Invalid, duplicate or too-deep Live View key: ${target}`
        );
      }
      admit();
      const instance: ViewInstance<User, Event> = {
        definition,
        revision: (current) => definition.revision?.(params, current),
        topics: (current) => definition.subscribe(params, current),
        authorize: (current) => definition.authorize(params, current),
        async render(current, childMode, admitChild) {
          const children = new Map<string, ViewInstance<User, Event>>();
          const data = await definition.load(params, current);
          const context = renderContext(
            renderer,
            current,
            children,
            childMode,
            admitChild,
            target
          );
          const html = await renderer.serialize(
            definition.render(data, params, context)
          );
          return { html, children };
        },
      };
      views.set(target, instance);
      // Existing child DOM can stay in place while the stream reconciles its subscription.
      if (mode === "update") return renderer.boundary(target, "");
      const result = await instance.render(user, mode, admit);
      return renderer.boundary(target, result.html);
    },
  };
}
