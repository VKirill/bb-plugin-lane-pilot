import type { DesignCritiqueCase, DesignJournalLine } from "@lane-pilot/contracts";

/** The design journal's KV key: one list of lines, capped at 2000, every reader shares. */
export const DESIGN_JOURNAL_KEY = "lp.design.journal";
/** Set cases a critique asked to store for later checks of the judge (SMA k_lib_dfeedback). */
export const DESIGN_CRITIQUE_CASES_KEY = "lp.design.critique-cases";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };

/** Every line of the design journal. */
export async function designJournalLines(kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalLine[]> {
  return ((await kv.get(DESIGN_JOURNAL_KEY)) as DesignJournalLine[] | null) ?? [];
}

/** Append a line to the design journal (the phase reactions' writes). */
export async function appendDesignJournalLine(kv: Kv, line: DesignJournalLine): Promise<void> {
  const lines = await designJournalLines(kv);
  await kv.set(DESIGN_JOURNAL_KEY, [...lines, line].slice(-2000) as never);
}

/** Store one set case: the drawing's sha, the form and the verdict the judge should learn to give. */
export async function appendDesignCritiqueCase(kv: Kv, entry: DesignCritiqueCase): Promise<void> {
  const cases = ((await kv.get(DESIGN_CRITIQUE_CASES_KEY)) as DesignCritiqueCase[] | null) ?? [];
  await kv.set(DESIGN_CRITIQUE_CASES_KEY, [...cases, entry].slice(-500) as never);
}

/** The owner's word on a phase, recorded on its latest journal line; a «no» also fails its first pass. */
export async function noteDesignJournalWord(kv: Kv, phaseId: string, decision: "yes" | "no"): Promise<void> {
  const lines = await designJournalLines(kv);
  const last = [...lines].reverse().find((line) => line.phaseId === phaseId);
  if (!last) return;
  last.ownerWord = decision;
  if (decision === "no") last.firstPass = false;
  await kv.set(DESIGN_JOURNAL_KEY, lines as never);
}
