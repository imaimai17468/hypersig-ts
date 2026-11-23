const storageKey = "hypersig:reset-draft";

type Field = HTMLInputElement | HTMLTextAreaElement;
type SavedDraft = [form: string, fields: [key: string, value: string][]];

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function draftGroups() {
  const groups = new Map<
    string,
    {
      form: HTMLFormElement;
      fields: Map<string, Field>;
    }
  >();
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-hs-draft-form]"
  )) {
    const id = form.dataset.hsDraftForm;
    if (!id || groups.has(id) || form.closest("[data-hs-view]")) continue;
    const fields = new Map<string, Field>();
    for (const control of form.querySelectorAll<HTMLElement>(
      "[data-hs-draft]"
    )) {
      // The field name is the draft key, so it matches the Action's input field.
      const key = control.getAttribute("name");
      if (!key || fields.has(key) || control.closest("[data-hs-view]"))
        continue;
      if (
        control instanceof HTMLTextAreaElement ||
        (control instanceof HTMLInputElement &&
          [
            "text",
            "search",
            "email",
            "tel",
            "url",
            "number",
            "hidden",
          ].includes(control.type))
      ) {
        fields.set(key, control);
      }
    }
    groups.set(id, { form, fields });
  }
  return groups;
}

export function preserveDrafts(scope: string | undefined): boolean {
  const drafts: SavedDraft[] = [];
  for (const [id, { fields }] of draftGroups()) {
    if (
      [...fields.values()].some((field) => field.value !== field.defaultValue)
    ) {
      drafts.push([id, [...fields].map(([key, field]) => [key, field.value])]);
    }
  }
  if (!drafts.length) return true;
  if (!scope) return false;
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        url: location.pathname + location.search,
        scope,
        expires: Date.now() + 120_000,
        drafts,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/** Restores saved drafts and returns the `action` of each restored form. */
export function restoreDrafts(scope: string | undefined): string[] {
  const restoredActions: string[] = [];
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return restoredActions;
    sessionStorage.removeItem(storageKey);
    const saved: unknown = JSON.parse(raw);
    if (
      !scope ||
      !saved ||
      typeof saved !== "object" ||
      !("scope" in saved) ||
      saved.scope !== scope ||
      !("url" in saved) ||
      saved.url !== location.pathname + location.search ||
      !("expires" in saved) ||
      typeof saved.expires !== "number" ||
      saved.expires < Date.now() ||
      !("drafts" in saved) ||
      !isArray(saved.drafts)
    )
      return restoredActions;
    const groups = draftGroups();
    for (const draft of saved.drafts) {
      if (!isArray(draft)) continue;
      const [id, values] = draft;
      const group = typeof id === "string" ? groups.get(id) : undefined;
      if (!group || !isArray(values) || group.fields.size !== values.length)
        continue;
      const restored = new Map<Field, string>();
      for (const value of values) {
        if (!isArray(value)) continue;
        const [key, text] = value;
        const field =
          typeof key === "string" ? group.fields.get(key) : undefined;
        if (field && typeof text === "string") restored.set(field, text);
      }
      if (restored.size === group.fields.size) {
        for (const [field, text] of restored) field.value = text;
        group.form.setAttribute("data-hs-draft-restored", "");
        const action = group.form.getAttribute("action");
        if (action !== null) restoredActions.push(action);
      }
    }
  } catch {
    // Browser storage can be disabled, or the stored draft can be malformed.
  }
  return restoredActions;
}
