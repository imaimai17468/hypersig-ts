export interface HtmlUpdate {
  target: string;
  version: number;
  html: string;
  children?: readonly string[];
}

export const events = {
  update: "html-update",
  ready: "ready",
  viewError: "view-error",
  reset: "reset",
  denied: "access-denied",
} as const;
