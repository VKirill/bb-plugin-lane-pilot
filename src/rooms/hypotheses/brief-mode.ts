/**
 * Contracts between roles (SMA P2-11, from RHI arXiv 2607.15524): a writer that gets only its contract — role, task contract, plan, task
 * folder — against today's full brief, which adds memory notes, rules and the PM's read summary. Setting `writer.brief_mode`: `full`
 * (default) or `narrow`. It is a bench arm's setting first; whether it stays is the bench's verdict (src/rooms/hypotheses).
 */
export type BriefMode = "full" | "narrow";
export const briefMode = (settings: Record<string, unknown>): BriefMode => (settings["writer.brief_mode"] === "narrow" ? "narrow" : "full");

/** What a narrow brief keeps of the context parts: none of memory, rules and the PM's read summary. */
export function briefParts(mode: BriefMode, parts: { memory: string; rules: string; pmRead: string }): { memory: string; rules: string; pmRead: string } {
  return mode === "narrow" ? { memory: "", rules: "", pmRead: "" } : parts;
}
