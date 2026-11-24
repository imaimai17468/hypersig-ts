import type { AttributeValues } from "../../src/element.js";
import { defineElement } from "../../src/element.js";
import { rating } from "./elements.js";

type Props = Partial<AttributeValues<typeof rating>>;

// Renders the star buttons in the light DOM and emits the chosen star (from 1).
defineElement(rating, {
  mount(host, props, emit) {
    const buttons: HTMLButtonElement[] = [];
    const render = ({ max, value }: Props) => {
      const count =
        max !== undefined && Number.isInteger(max) && max > 0 ? max : 5;
      // Keep the existing buttons so state other scripts attach to them stays.
      while (buttons.length > count) buttons.pop()?.remove();
      while (buttons.length < count) {
        const star = buttons.length + 1;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "★";
        button.setAttribute(
          "aria-label",
          star === 1 ? "1 star" : `${star} stars`
        );
        button.addEventListener("click", () => emit("rate", star));
        host.append(button);
        buttons.push(button);
      }
      const pressed = value ?? 0;
      buttons.forEach((button, index) => {
        button.setAttribute("aria-pressed", String(index < pressed));
      });
    };
    render(props);
    return {
      update: render,
      unmount() {
        for (const button of buttons) button.remove();
      },
    };
  },
});
