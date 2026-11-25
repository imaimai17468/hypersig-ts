import { customElement, event, json } from "../../src/element.js";

// A type alias, not an interface, so that it is assignable to `JsonValue`.
export type Item = { key: string; label: string };

// Implemented by list.tsx, which renders the list with React and dnd-kit.
export const sortableList = customElement("sortable-list", {
  // `items` is the server's committed order. `failures` changes when a save
  // fails, which tells the list to drop the order it is showing as pending.
  // It does not count failures: the Live View's snapshot sets it back to 0
  // whenever the view updates.
  attributes: { items: json<Item[]>(), failures: "number" },
  // The item keys in the order the user dropped them.
  events: { reorder: event<string[]>() },
  ownsChildren: true,
});
