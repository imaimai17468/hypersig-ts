// A star rating that renders its own buttons in the light DOM. It reads `max`
// and `value`, and dispatches `rate` with the chosen star (from 1) as `detail`.
class StarRating extends HTMLElement {
  static observedAttributes = ["value", "max"];

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.#render();
  }

  get #max() {
    const max = Number(this.getAttribute("max"));
    return Number.isInteger(max) && max > 0 ? max : 5;
  }

  get #value() {
    const value = Number(this.getAttribute("value"));
    return Number.isFinite(value) ? value : 0;
  }

  #render() {
    const max = this.#max;
    const buttons = [...this.querySelectorAll(":scope > button")];
    // Keep the existing buttons so state other scripts attach to them stays.
    while (buttons.length > max) buttons.pop()?.remove();
    while (buttons.length < max) {
      const star = buttons.length + 1;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "★";
      button.setAttribute(
        "aria-label",
        star === 1 ? "1 star" : `${star} stars`
      );
      button.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("rate", { detail: star, bubbles: false })
        );
      });
      this.append(button);
      buttons.push(button);
    }
    const value = this.#value;
    buttons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(index < value));
    });
  }
}

customElements.define("star-rating", StarRating);
