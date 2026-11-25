/** The session storage key holding the times of this tab's recent automatic reloads. */
const storageKey = "hypersig:reset-reloads";
const windowMs = 60_000;
const maxReloads = 3;

type ReloadDecision =
  | { kind: "reload"; reloadTimes: number[] }
  | { kind: "ask-user" };

/**
 * Allows an automatic reload while fewer than `maxReloads` happened in the
 * last `windowMs`, so a stream that keeps resetting cannot reload the tab in
 * a loop.
 */
function decideReload(
  previousTimes: readonly number[],
  now: number
): ReloadDecision {
  const recent = previousTimes.filter((time) => now - time < windowMs);
  return recent.length < maxReloads
    ? { kind: "reload", reloadTimes: [...recent, now] }
    : { kind: "ask-user" };
}

/**
 * Records an automatic reload at `now` and reports whether the runtime may
 * reload. It reports false when session storage is unavailable, since
 * the reloads could not be counted.
 */
export function claimReload(now: number): boolean {
  try {
    const raw = sessionStorage.getItem(storageKey) ?? "[]";
    let saved: unknown = [];
    try {
      saved = JSON.parse(raw);
    } catch {
      // A malformed entry counts as no earlier reloads.
    }
    const previousTimes = Array.isArray(saved)
      ? saved.filter((time): time is number => typeof time === "number")
      : [];
    const decision = decideReload(previousTimes, now);
    if (decision.kind === "ask-user") return false;
    sessionStorage.setItem(storageKey, JSON.stringify(decision.reloadTimes));
    return true;
  } catch {
    return false;
  }
}
