import DOMPurify from "dompurify";
import { isBindableCustomAttribute, isCustomElementName } from "./protocol.js";

/**
 * Parses the HTML of a Live View update. Custom elements keep the attributes
 * a custom element may have bound; customized built-in elements (`is`) are
 * not admitted. `style`, `data-hs-stream`, `<style>` and `<template>` are
 * removed from every element.
 */
export function sanitizeFragment(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "template"],
    FORBID_ATTR: ["data-hs-stream", "style"],
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: (name) => isCustomElementName(name),
      attributeNameCheck: (name) => isBindableCustomAttribute(name),
      allowCustomizedBuiltInElements: false,
    },
  });
}
