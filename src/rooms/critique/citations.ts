import { isSerious } from "@lane-pilot/workflow-engine";
import type { Verdict, VerdictFinding } from "@lane-pilot/workflow-engine";

/**
 * The code check on a reviewer's opinion (STAGE_PROOF «form»): does the file and line a serious finding names exist where the
 * reviewer could see it? A finding that cites nothing real is read as medium, like one with no file or no quoted evidence
 * (`settleVerdict` then lowers the status it cannot back up). The opinion stays an opinion; only its citation is checked.
 */
export type Citation = (finding: Pick<VerdictFinding, "file" | "line">) => boolean;

const normalize = (path: string): string => path.trim().replace(/^\.\//, "");

/** `TASK` and `PLAN` name the contract and the plan themselves. */
const isContractRef = (file: string): boolean => file === "TASK" || file === "PLAN";

/**
 * For a reviewer that sees only what is in its prompt (plan critique, specialist review): a file counts when its path appears in
 * that input (the contract, the plan, the pm-read excerpts); a path the reviewer was never shown is invented.
 */
export function inputCitations(...inputs: readonly string[]): Citation {
  const text = inputs.join("\n");
  return (finding) => {
    const file = normalize(finding.file);
    return file === "" || isContractRef(file) || text.includes(file);
  };
}

/**
 * For the code critic: a file that is among the candidate's files must have the line the finding names. A file outside them is not
 * refuted (the critic may have gitnexus to read callers), so it stays; its line cannot be checked here.
 */
export function candidateCitations(files: ReadonlyArray<{ path: string; content: string | null }>, excerptBytes: number): Citation {
  // A file cut at the excerpt ceiling shows the critic only its start, so its line count is unknown.
  const lines = new Map(files.map((row) => [normalize(row.path),
    row.content === null || Buffer.byteLength(row.content, "utf8") >= excerptBytes ? null : row.content.split("\n").length]));
  return (finding) => {
    const count = lines.get(normalize(finding.file));
    return count == null || finding.line == null || finding.line <= count;
  };
}

/** Serious findings whose citation fails are read as medium; the count goes to the stage result as `demoted`. */
export function demoteUncited(verdict: Verdict, cites: Citation | undefined): { verdict: Verdict; demoted: number } {
  if (!cites) return { verdict, demoted: 0 };
  let demoted = 0;
  const findings = verdict.findings.map((finding) => {
    if (!isSerious(finding) || cites(finding)) return finding;
    demoted += 1;
    return { ...finding, severity: "medium" as const };
  });
  return { verdict: demoted ? { ...verdict, findings } : verdict, demoted };
}
