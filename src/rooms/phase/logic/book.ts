import { sha256Hex } from "@lane-pilot/kit";
import { PHASE_STAGES, type Phase } from "./record";

/** The nine sections of the phase book, in order. */
export const BOOK_SECTIONS = ["goal", "discussion", "plan", "design", "execution", "verification", "acceptance", "lessons", "decisions"] as const;
export type BookSection = (typeof BOOK_SECTIONS)[number];
export type BookPart = { seq: number; at: number; section: BookSection; kind: string; text: string; prevHash: string; hash: string };

export const GENESIS = "0".repeat(64);
export const partHash = (prevHash: string, part: { seq: number; at: number; section: string; kind: string; text: string }) =>
  sha256Hex(`${prevHash}\n${part.seq}\n${part.at}\n${part.section}\n${part.kind}\n${part.text}`);

/** The first part whose hash or link does not hold, or null when the whole chain is intact. */
export function brokenLink(parts: readonly BookPart[]): number | null {
  let prev = GENESIS;
  for (const part of parts) {
    if (part.prevHash !== prev || part.hash !== partHash(prev, part)) return part.seq;
    prev = part.hash;
  }
  return null;
}

/** The phase book as Markdown: the nine sections, each with its parts in order, and the chain's state. */
export function renderBook(phase: Phase, parts: readonly BookPart[]): string {
  const titles: Record<BookSection, string> = { goal: "1. Goal", discussion: "2. Discussion", plan: "3. Plan", design: "4. Design", execution: "5. Execution", verification: "6. Verification", acceptance: "7. Acceptance", lessons: "8. Lessons", decisions: "9. Decisions and returns" };
  const broken = brokenLink(parts);
  const lines = [`# Phase ${phase.id}: ${phase.title}`, "", `Stage: ${phase.stage} · state: ${phase.state} · edition ${phase.edition} · chain: ${broken === null ? `intact (${parts.length} parts)` : `BROKEN at part ${broken}`}`, ""];
  for (const section of BOOK_SECTIONS) {
    const own = parts.filter((part) => part.section === section);
    lines.push(`## ${titles[section]}`, "");
    if (section === "goal") lines.push(phase.goal, "");
    for (const part of own) lines.push(`- ${new Date(part.at).toISOString().slice(0, 16).replace("T", " ")} **${part.kind}** — ${part.text}`);
    if (own.length) lines.push("");
  }
  return lines.join("\n");
}

/** One cell per PHASE_STAGES stage for the phase's picture (SMA m_ws_stage_graph): before the current passed,
 *  it running (failed when the phase is stopped), the rest pending. */
export type PhaseStageCell = { stageId: string; state: "passed" | "failed" | "running" | "pending"; rounds: number; failures: number; reason: string | null };
export function phaseStageCells(stage: string, state: string): PhaseStageCell[] {
  const current = (PHASE_STAGES as readonly string[]).indexOf(stage);
  return PHASE_STAGES.map((stageId, index) => ({
    stageId, rounds: index === current ? 1 : 0, failures: index === current && state === "stopped" ? 1 : 0, reason: null,
    state: index < current || state === "closed" ? "passed" : index > current ? "pending" : state === "stopped" ? "failed" : state === "active" ? "running" : "pending",
  }));
}
