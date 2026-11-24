import type { Topic } from "./topic.js";

export type LiveDiagnostic<Event extends Topic> =
  | { type: "send-timeout" }
  /**
   * A page token was altered, or sealed with a key this runtime does not hold.
   * Any client can cause this by sending garbage, so a single occurrence is
   * not a reason to alert. A rise after a deploy points to a dropped page key.
   */
  | { type: "page-token-invalid" }
  /**
   * A valid page token names a view the runtime no longer registers, or whose
   * `key()` throws or returns an invalid or duplicate key for the params the
   * token holds. The page renders again. `view` is the failing view's name.
   */
  | { type: "page-rebuild-failed"; view: string }
  | { type: "publish" | "publish-error"; topic: Event }
  | { type: "invalidate"; topic: Event; target: string }
  | {
      type: "subscribe-error" | "subscription-disconnected";
      topic: Event;
      target: string;
    }
  | {
      type: "reconcile-skipped" | "initial-sync-skipped" | "revision-error";
      target: string;
    }
  | { type: "render" | "render-error"; target: string; reason: RenderReason };

export type RenderReason = "connect" | "topic" | "reconcile";

export function report<Event extends Topic>(
  observer: ((event: LiveDiagnostic<Event>) => void) | undefined,
  event: LiveDiagnostic<Event>
) {
  try {
    observer?.(event);
  } catch (error) {
    console.error("Live diagnostics observer failed", error);
  }
}
