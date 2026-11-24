import { Idiomorph } from "idiomorph";
import { customElementAttributes } from "./protocol.js";
import type { SignalRuntime } from "./signal-runtime.js";
import { isTextControl } from "./signal-runtime.js";

const pendingAttribute = "data-hs-pending";

/**
 * What a morph does with an existing element: morph it as usual, leave a
 * nested view alone, keep an owned element's children while taking the new
 * attributes, or replace an owned element that is a different instance.
 */
type ElementMorph =
  | { kind: "morph" }
  | { kind: "skip" }
  | { kind: "keepChildren"; boundAttributes: ReadonlySet<string> }
  | { kind: "replace" };

function chooseElementMorph(
  previous: Element,
  next: Element,
  runtime: Pick<SignalRuntime, "keepsChildren" | "boundElementAttributes">
): ElementMorph {
  const view = next.getAttribute("data-hs-view");
  if (view && previous.getAttribute("data-hs-view") === view) {
    return { kind: "skip" };
  }
  if (runtime.keepsChildren(previous, next)) {
    return {
      kind: "keepChildren",
      boundAttributes: runtime.boundElementAttributes(next),
    };
  }
  const mark = customElementAttributes.ownsChildren;
  if (previous.hasAttribute(mark) && next.hasAttribute(mark)) {
    return { kind: "replace" };
  }
  return { kind: "morph" };
}

/**
 * Gives `previous` the attributes of `next`, except `data-hs-pending` while
 * sending and the bound attributes, which the runtime renders after the morph
 * from the browser's signal values.
 */
function copyAttributes(
  previous: Element,
  next: Element,
  kept: { isSending: boolean; boundAttributes: ReadonlySet<string> }
) {
  for (const name of previous.getAttributeNames()) {
    if (next.hasAttribute(name) || kept.boundAttributes.has(name)) continue;
    if (name === pendingAttribute && kept.isSending) continue;
    previous.removeAttribute(name);
  }
  for (const { name, value } of next.attributes) {
    if (kept.boundAttributes.has(name)) continue;
    if (previous.getAttribute(name) !== value)
      previous.setAttribute(name, value);
  }
}

/**
 * Morphs the children of `view` into `fragment`. Nested views keep their
 * content, and a control whose request is in flight keeps `data-hs-pending`.
 * An element with `data-hs-owns-children` keeps its children when
 * `runtime.keepsChildren` matches it with the new element, and only takes the
 * new attributes other than its bound ones; otherwise it is replaced after the morph, so its children
 * and JavaScript state start over.
 */
export function morphView(
  view: HTMLElement,
  fragment: DocumentFragment,
  runtime: Pick<
    SignalRuntime,
    "isSending" | "keepsChildren" | "boundElementAttributes"
  >
): void {
  // Replacing an element during the morph would detach the node Idiomorph
  // continues from, so replacements wait until it ends.
  const replacements: [Element, Node][] = [];
  // Idiomorph is synchronous when head processing is non-blocking.
  void Idiomorph.morph(view, fragment, {
    head: { style: "none" },
    morphStyle: "innerHTML",
    ignoreActiveValue: isTextControl(view.ownerDocument.activeElement),
    restoreFocus: true,
    callbacks: {
      beforeNodeMorphed(previous, next) {
        if (!(previous instanceof Element) || !(next instanceof Element)) {
          return true;
        }
        const morph = chooseElementMorph(previous, next, runtime);
        switch (morph.kind) {
          case "morph":
            return true;
          case "skip":
            return false;
          case "keepChildren":
            copyAttributes(previous, next, {
              isSending: runtime.isSending(previous),
              boundAttributes: morph.boundAttributes,
            });
            return false;
          case "replace":
            replacements.push([previous, next.cloneNode(true)]);
            return false;
        }
      },
      // The server HTML never has the attribute, so keep it on a control
      // whose request is still in flight.
      beforeAttributeUpdated(name, element, mutation) {
        return !(
          name === pendingAttribute &&
          mutation === "remove" &&
          runtime.isSending(element)
        );
      },
    },
  });
  for (const [previous, next] of replacements) previous.replaceWith(next);
}
