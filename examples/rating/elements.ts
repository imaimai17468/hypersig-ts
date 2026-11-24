import { customElement, event } from "../../src/element.js";

// Implemented by rating.ts, which renders the star buttons inside the element.
export const rating = customElement("star-rating", {
  attributes: { value: "number", max: "number" },
  events: { rate: event<number>() },
  ownsChildren: true,
});
