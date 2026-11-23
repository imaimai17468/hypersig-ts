import type { Topic } from "./topic.js";

export type LiveDiagnostic<Event extends Topic> =
  | { type: "send-timeout" }
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
