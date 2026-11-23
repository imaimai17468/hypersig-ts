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
  view<Params, Data extends SharedValue>(
    definition: SharedLiveView<Params, Data, User, Event, Markup>,
    params: NoInfer<Params>
  ): Promise<Markup>;
}

interface LiveViewDefinition<
  Params,
  User extends Principal,
  Event extends Topic,
> {
  key(params: Params): string;
  /**
   * Changes when the parent supplies different render inputs for this identity.
   * Data changes still arrive through the view's topics.
   */
  revision?(params: Params, user: User): string | number;
  subscribe(params: Params, user: User): readonly Event[];
  authorize(params: Params, user: User): MaybePromise<boolean>;
}

export type SharedValue = string | number | bigint | boolean | null | undefined;

export interface SharedLoad<Data extends SharedValue> {
  /** Resource and visibility scope. Every viewer in this scope must see the same value. */
  readonly scope: string;
  /** Committed revision selected for this load. */
  readonly revision: string | number;
  /** Read the snapshot bound to this scope and revision. */
  load(): MaybePromise<Data>;
}

export interface SharedLoadOptions<
  Params,
  Data extends SharedValue,
  User extends Principal,
> {
  /** Select a snapshot after authorization. Return undefined for an individual load. */
  shareLoad(
    this: void,
    params: NoInfer<Params>,
    user: User
  ): MaybePromise<SharedLoad<NoInfer<Data>> | undefined>;
}

export interface SnapshotRevision<Params, Data, User extends Principal> {
  /** Read the current revision without loading the full snapshot. */
  read(params: Params, user: User): MaybePromise<string | number>;
  /** Read the revision from the exact snapshot that will be rendered. */
  from(data: NoInfer<Data>): string | number;
}

export interface LiveView<
  Params,
  Data,
  User extends Principal,
  Event extends Topic,
  Markup,
> extends LiveViewDefinition<Params, User, Event> {
  load(params: Params, user: User): MaybePromise<Data>;
  /** Optional shortcut for periodic reconciliation. */
  snapshotRevision?: SnapshotRevision<Params, NoInfer<Data>, User>;
  render(
    data: NoInfer<Data>,
    params: Params,
    context: LiveRenderContext<User, Event, NoInfer<Markup>>
  ): MaybePromise<Markup>;
}

export interface SharedLiveView<
  Params,
  Data extends SharedValue,
  User extends Principal,
  Event extends Topic,
  Markup,
> extends LiveViewDefinition<Params, User, Event> {
  load(params: Params, user: User): MaybePromise<Data>;
  /** Pure leaf renderer. Equal primitive snapshots can share rendered HTML. */
  renderShared(data: NoInfer<Data>): MaybePromise<Markup>;
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
