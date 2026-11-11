/**
 * The seven-day rollback watch (SMA p6_observe): for a week after acceptance the machine reads history for rollbacks of the
 * phase's work and records what it saw on the phase — never the acceptance itself. `failure`: a revert of the phase's work was
 * found; `no_data`: nothing could be read (no merge commits, no history); `no_failure`: the window is over and nothing reverted;
 * `incomplete`: still watching, nothing reverted so far. The first pass after the window records the final outcome.
 */
export type PhaseObservation = { outcome: "failure" | "no_failure" | "incomplete" | "no_data"; reverted: string[]; until: number };
export const OBSERVE_WINDOW_MS = 7 * 86_400_000;
export function observationOutcome(closedAt: number, now: number, found: { reverted: string[]; readable: boolean }): PhaseObservation {
  const until = closedAt + OBSERVE_WINDOW_MS;
  if (found.reverted.length) return { outcome: "failure", reverted: found.reverted, until };
  if (!found.readable) return { outcome: "no_data", reverted: [], until };
  return { outcome: now >= until ? "no_failure" : "incomplete", reverted: [], until };
}
/** Is the watch still owed a pass: inside the window, or over it with no final outcome on record yet. */
export const observationDue = (closedAt: number, now: number, seen?: PhaseObservation) =>
  now - closedAt <= OBSERVE_WINDOW_MS || seen?.outcome === "incomplete";

/** Is a lessons analysis needed: a phase that went straight through has nothing to teach; returns, failed attempts or a failed verdict do. */
export function lessonsNeeded(input: { returns: number; failedAttempts: number; verdictFailures: number }): { needed: boolean; why: string } {
  const reasons = [input.returns ? `${input.returns} return(s) to an earlier stage` : "", input.failedAttempts ? `${input.failedAttempts} failed attempt(s)` : "", input.verdictFailures ? `${input.verdictFailures} failed verdict(s)` : ""].filter(Boolean);
  return reasons.length ? { needed: true, why: reasons.join(", ") } : { needed: false, why: "the phase went through without returns or failures" };
}
