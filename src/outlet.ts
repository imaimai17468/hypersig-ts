import { outletAttributes } from "./protocol.js";

/**
 * Marks the element that shows an Action's failure message. The runtime uses
 * the one inside the submitting form, or else the first one on the page.
 */
export function errorOutlet(): { [outletAttributes.error]: "" } {
  return { [outletAttributes.error]: "" };
}

/** Marks the element that tells the user when live updates disconnect. */
export function connectionStatusOutlet(): {
  [outletAttributes.connectionStatus]: "";
} {
  return { [outletAttributes.connectionStatus]: "" };
}
