const form = document.querySelector<HTMLFormElement>("#memo-editor");
const published = document.querySelector("#published");
const base = form?.querySelector<HTMLInputElement>("[name=baseRevision]");
const operation = form?.querySelector<HTMLInputElement>("[name=operationId]");
const version = form?.querySelector("#draft-version");
const notice = form?.querySelector<HTMLElement>("#newer-version");
const restored = form?.querySelector<HTMLElement>("#restored-draft");
const useLatest = form?.querySelector<HTMLButtonElement>(
  "#use-latest-revision"
);
const draft = form?.querySelector<HTMLTextAreaElement>("#memo-text");
const error = form?.querySelector("[data-hs-error]");

if (
  form &&
  published &&
  base &&
  operation &&
  version &&
  notice &&
  restored &&
  useLatest &&
  error
) {
  const readPublishedRevision = () =>
    Number(
      published.querySelector<HTMLElement>("[data-revision]")?.dataset.revision
    );
  const showNewerRevision = () => {
    notice.hidden = !(readPublishedRevision() > Number(base.value));
  };
  const setBaseRevision = (revision: number) => {
    base.value = String(revision);
    version.textContent = base.value;
    showNewerRevision();
  };

  useLatest.addEventListener("click", () => {
    const revision = readPublishedRevision();
    if (
      form.hasAttribute("data-hs-pending") ||
      !Number.isSafeInteger(revision) ||
      revision <= Number(base.value)
    )
      return;
    setBaseRevision(revision);
    operation.value = crypto.randomUUID();
    error.textContent = "";
    draft?.focus();
  });

  form.addEventListener("hypersig:action-success", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!detail || typeof detail !== "object" || !("data" in detail)) return;
    const { data } = detail;
    if (!data || typeof data !== "object" || !("revision" in data)) return;
    const { revision } = data;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision)) return;
    setBaseRevision(revision);
    operation.value = crypto.randomUUID();
    restored.hidden = true;
  });

  new MutationObserver(showNewerRevision).observe(published, {
    attributes: true,
    attributeFilter: ["data-revision"],
    childList: true,
    subtree: true,
  });
  version.textContent = base.value;
  restored.hidden = !form.hasAttribute("data-hs-draft-restored");
  showNewerRevision();
}
