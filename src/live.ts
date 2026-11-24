import type { Identifier } from "./identifier.js";
import type { JsonValue } from "./protocol.js";
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

/**
 * Accepts `Value` when every part of it is JSON: strings, numbers, booleans,
 * null, arrays of those, and objects of those, including interfaces and
 * optional properties. Turns a Date, function, bigint, symbol, or an array
 * entry that may be undefined into `never`, so the call that passes it fails.
 * A view that does not declare its params accepts any JSON value.
 */
type JsonCompatible<Value> = unknown extends Value
  ? JsonValue
  : JsonCompatibleKnown<Value>;

type JsonCompatibleKnown<Value> = [Value] extends [JsonValue]
  ? [JsonValue] extends [Value]
    ? Value
    : JsonCompatiblePart<Value>
  : JsonCompatiblePart<Value>;

type JsonCompatiblePart<Value> = Value extends string | number | boolean | null
  ? Value
  : Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: JsonCompatibleKnown<Value[Index]> }
    : Value extends Date | ((...args: never) => unknown)
      ? never
      : Value extends object
        ? {
            readonly [Key in keyof Value]:
              | JsonCompatibleKnown<Value[Key]>
              | (undefined extends Value[Key] ? undefined : never);
          }
        : never;

/**
 * Places the page's top-level views. Their params travel in the page token,
 * so they must be JSON. A value TypeScript accepts as JSON but that does not
 * survive `JSON.stringify`, such as `NaN` or a class instance, reaches the view
 * changed when the page reconnects.
 */
export interface PageRenderContext<
  User extends Principal,
  Event extends Topic,
  Markup,
> {
  view<Params, Data>(
    definition: LiveView<Params, Data, User, Event, Markup>,
    params: NoInfer<Params> & JsonCompatible<Params>
  ): Promise<Markup>;
  view<Params, Data extends SharedValue>(
    definition: SharedLiveView<Params, Data, User, Event, Markup>,
    params: NoInfer<Params> & JsonCompatible<Params>
  ): Promise<Markup>;
}

interface LiveViewDefinition<
  Params,
  User extends Principal,
  Event extends Topic,
> {
  /**
   * Identifies this view, so it is also the view's key in the page. Names are
   * unique within a runtime: registering a second definition under the same
   * name throws.
   */
  name: string;
  /**
   * Tells apart instances of this definition placed under the same parent.
   * Required only when the parent places the definition more than once.
   */
  key?(params: Params): string;
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

/**
 * Checks a literal `name` when a definition is written. A name typed as
 * `string`, such as one spread from another definition, is checked when
 * `live()` or `liveShared()` registers the definition.
 */
export interface NamedView<Name extends string> {
  name: string extends Name ? string : Identifier<Name>;
}
