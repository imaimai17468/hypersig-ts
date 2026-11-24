/** @jsxImportSource react */
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { AnyCustomElement, AttributeValues, Emit } from "./element.js";
import { defineElement } from "./element.js";

/**
 * Registers the declaration's tag and renders `Component` into each element of
 * that tag with React. `Component` receives the declared attributes as props,
 * left out when absent or unreadable (see `defineElement`), and `emit`.
 *
 * Insertion creates a React root on the element and renders into it. An
 * attribute change renders again into the same root, so the component keeps
 * its state. Removal unmounts the root, which runs the component's effect
 * cleanups. Only a declaration with `ownsChildren: true` is accepted, because
 * React replaces the element's children.
 *
 * `react` and `react-dom` are optional peer dependencies; they are needed only
 * by apps that import `hypersig.ts/react`.
 */
export function reactElement<
  E extends AnyCustomElement & { readonly ownsChildren: true },
>(
  declaration: E,
  Component: ComponentType<Partial<AttributeValues<E>> & { emit: Emit<E> }>
): void {
  defineElement(declaration, {
    mount(host, props, emit) {
      const root = createRoot(host);
      root.render(<Component {...props} emit={emit} />);
      return {
        update(next) {
          root.render(<Component {...next} emit={emit} />);
        },
        unmount() {
          root.unmount();
        },
      };
    },
  });
}
