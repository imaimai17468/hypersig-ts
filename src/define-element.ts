import type {
  AnyCustomElement,
  AttributeKind,
  AttributeValues,
  EventDetail,
  EventName,
} from "./element.js";
import type { JsonValue } from "./protocol.js";
import { isJsonValue, rendersBooleanAsText } from "./protocol.js";

/** Dispatches a declared event from the element. */
export type Emit<E extends AnyCustomElement> = <Name extends EventName<E>>(
  name: Name,
  detail: EventDetail<E, Name>
) => void;

/** What `mount` returns: how the element follows its attributes and ends. */
export interface MountedElement<E extends AnyCustomElement> {
  /** Receives every declared attribute after one or more of them change. */
  update(props: Partial<AttributeValues<E>>): void;
  /** Runs when the element leaves the document. */
  unmount(): void;
}

/** The browser side of a declaration. */
export interface ElementImplementation<E extends AnyCustomElement> {
  mount(
    host: HTMLElement,
    props: Partial<AttributeValues<E>>,
    emit: Emit<E>
  ): MountedElement<E>;
}

type Props = Record<string, JsonValue>;

interface LooseImplementation {
  mount(
    host: HTMLElement,
    props: Props,
    emit: (name: string, detail: JsonValue) => void
  ): { update(props: Props): void; unmount(): void };
}

/**
 * Reads an attribute's text as its declared kind. Text that does not read as
 * the kind counts as a missing attribute and gives `undefined`.
 */
function readAttribute(
  name: string,
  kind: AttributeKind,
  text: string | null
): JsonValue | undefined {
  if (text === null) return undefined;
  switch (kind) {
    case "string":
      return text;
    case "number": {
      if (text.trim() === "") return undefined;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    case "boolean":
      if (!rendersBooleanAsText(name)) return true;
      return text === "true" ? true : text === "false" ? false : undefined;
    case "json":
      try {
        const value: unknown = JSON.parse(text);
        return isJsonValue(value) ? value : undefined;
      } catch {
        return undefined;
      }
  }
}

function readProps(
  kinds: Readonly<Record<string, AttributeKind>>,
  element: Element
): Props {
  const props: Props = {};
  for (const [name, kind] of Object.entries(kinds)) {
    const value = readAttribute(name, kind, element.getAttribute(name));
    if (value !== undefined) props[name] = value;
  }
  return props;
}

interface Mount {
  readonly element: ReturnType<LooseImplementation["mount"]>;
  hasPendingUpdate: boolean;
}

/**
 * Registers the declaration's tag with `customElements` and runs
 * `implementation` for each element of that tag in the document. Throws when
 * the tag is already defined.
 *
 * `mount` runs when an element is inserted, with each declared attribute read
 * as its kind. A missing attribute, a `number` that is not a finite number, a
 * text boolean (`data-*`, `aria-*`) that is not `"true"` or `"false"`, and a
 * `json` value that `JSON.parse` cannot read or that nests more than 64
 * levels deep are left out of `props`, so they read as `undefined`. A `json`
 * value is not checked against its declared type. If `mount` throws, the
 * element stays unmounted: neither `update` nor `unmount` runs for it until
 * it is inserted again.
 *
 * Attribute changes made in one task reach `update` once, in a microtask,
 * with every declared attribute. `unmount` runs when the element is removed;
 * inserting it again calls `mount` again, so a move calls `unmount` and then
 * `mount`. A change made before `unmount` does not reach `update`.
 *
 * `emit` dispatches a `CustomEvent` that does not bubble, which handlers from
 * the declaration's `on` receive. With `ownsChildren`, `mount` may render the
 * element's children and replace those the server rendered.
 */
export function defineElement<E extends AnyCustomElement>(
  declaration: E,
  implementation: ElementImplementation<E>
): void;
export function defineElement(
  declaration: AnyCustomElement,
  implementation: LooseImplementation
): void {
  const { tag } = declaration;
  if (customElements.get(tag) !== undefined) {
    throw new Error(`Custom element "${tag}" is already defined`);
  }
  const kinds: Readonly<Record<string, AttributeKind>> = declaration.attributes;
  const observed = Object.keys(kinds);

  class DeclaredElement extends HTMLElement {
    static readonly observedAttributes = observed;
    #mount: Mount | undefined;

    connectedCallback() {
      const element = implementation.mount(
        this,
        readProps(kinds, this),
        (name, detail) => {
          this.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }));
        }
      );
      this.#mount = { element, hasPendingUpdate: false };
    }

    attributeChangedCallback(
      _name: string,
      oldValue: string | null,
      newValue: string | null
    ) {
      const mount = this.#mount;
      if (!mount || mount.hasPendingUpdate || oldValue === newValue) return;
      mount.hasPendingUpdate = true;
      queueMicrotask(() => {
        if (this.#mount !== mount) return;
        mount.hasPendingUpdate = false;
        mount.element.update(readProps(kinds, this));
      });
    }

    disconnectedCallback() {
      const mount = this.#mount;
      if (!mount) return;
      this.#mount = undefined;
      mount.element.unmount();
    }
  }

  customElements.define(tag, DeclaredElement);
}
