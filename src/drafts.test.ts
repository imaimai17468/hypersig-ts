import { expect, it } from "vite-plus/test";
import { restoreDrafts } from "./drafts.js";

it("returns the action of each restored form", () => {
  document.body.innerHTML = [
    `<form data-hs-draft-form="memo" action="/_hypersig/actions/save-memo">`,
    `<textarea name="body" data-hs-draft>old</textarea></form>`,
    `<form data-hs-draft-form="other" action="/_hypersig/actions/other">`,
    `<input name="title" data-hs-draft value="kept"></form>`,
  ].join("");
  sessionStorage.setItem(
    "hypersig:reset-draft",
    JSON.stringify({
      url: location.pathname + location.search,
      scope: "page",
      expires: Date.now() + 60_000,
      drafts: [["memo", [["body", "draft"]]]],
    })
  );

  expect(restoreDrafts("page")).toEqual(["/_hypersig/actions/save-memo"]);
  expect(document.querySelector("textarea")?.value).toBe("draft");
  expect(restoreDrafts("page")).toEqual([]);
});
