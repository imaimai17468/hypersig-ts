import type { Topic } from "./topic.js";

export interface Principal {
  /** Stable identity for the authenticated session, including its access scope. */
  readonly sessionId: string;
}

type MaybePromise<Value> = Value | Promise<Value>;

export interface LiveRenderContext<
  User extends Principal,
  Event extends Topic,
  Markup,
> {
  view<Params, Data>(
    definition: LiveView<Params, Data, User, Event, Markup>,
    params: NoInfer<Params>
  ): Promise<Markup>;
}

export interface LiveView<
  Params,
  Data,
  User extends Principal,
  Event extends Topic,
  Markup,
> {
  key(params: Params): string;
  /**
   * Changes when the parent supplies different render inputs for this identity.
   * Data changes still arrive through the view's topics.
   */
  revision?(params: Params, user: User): string | number;
  subscribe(params: Params, user: User): readonly Event[];
  authorize(params: Params, user: User): MaybePromise<boolean>;
  load(params: Params, user: User): MaybePromise<Data>;
  render(
    data: NoInfer<Data>,
    params: Params,
    context: LiveRenderContext<User, Event, NoInfer<Markup>>
  ): MaybePromise<Markup>;
}

export function live<
  Params,
  Data,
  User extends Principal,
  Event extends Topic,
  Markup,
>(
  view: LiveView<Params, Data, User, Event, Markup>
): LiveView<Params, Data, User, Event, Markup> {
  return view;
}
