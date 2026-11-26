import type { VerdictReceipt } from "@lane-pilot/contracts";

export type FalseDoneFinding = {
  kind: "claimed_file_untouched" | "claimed_test_not_run" | "claimed_test_failed";
  claim: string;
  detail: string;
};

export type FalseDoneResult = {
  verdict: "pass" | "fail";
  findings: FalseDoneFinding[];
  reason: string | null;
};

const FILE_CLAIM_RE = /(?:^|[\s`"'(])([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]{1,10})(?=$|[\s`"'),.:;])/g;
const TEST_CLAIM_LINE_RE = /(?:^|\n)[^\n]*\b(?:ran|passed|passing|green|all tests pass|tests?\s+pass(?:ed)?|vitest|pytest|jest|npm\s+test|pnpm\s+test|cargo\s+test|go\s+test)\b[^\n]*/gi;
const CLAIMED_CMD_RE = /`([^`\n]+)`/g;
const VERIFY_MENTION_RE = /\b(?:npm|pnpm|yarn|bun|npx|vitest|jest|pytest|mocha|node|cargo|go|tsc)\b[^\n`]{0,120}/i;
const TEST_RUN_OUTCOME_CLAIM_RE = /\b(?:all\s+\d*\s*tests?\s+pass(?:ed)?|tests?\s+(?:passed|green)|(?:vitest|jest|pytest)\s+pass(?:ed)?|0\s+failed)\b/i;

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").trim();
}

function sameCommand(claimed: string, ran: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const a = norm(claimed);
  const b = norm(ran);
  if (a === b) return true;
  return b.includes(a) || a.includes(b);
}

/**
 * Deterministic (non-LLM) false-done detector: compares the writer's self-report claims
 * against the verdict receipt and actual git diff paths.
 * Claimed files untouched or claimed tests not run / failed -> verdict `fail`.
 */
export function detectFalseDone(input: {
  writerOutput: string;
  diffPaths: readonly string[];
  receipt: Pick<VerdictReceipt, "verdict" | "criteria"> | null;
  knownRepoFiles?: readonly string[];
}): FalseDoneResult {
  const findings: FalseDoneFinding[] = [];
  const diffSet = new Set(input.diffPaths.map(normalizePath).filter(Boolean));
  const text = input.writerOutput ?? "";

  // 1. Files explicitly claimed as changed/edited/created/added/fixed/updated in prose or plan-fact tables.
  const claimLines = text.split("\n").filter((line) =>
    /\b(?:modified|edited|updated|created|added|changed|fixed|implemented|wrote|in)\b|^\s*\|/i.test(line),
  );
  const claimedFiles = new Set<string>();
  const knownSet = input.knownRepoFiles ? new Set(input.knownRepoFiles.map(normalizePath)) : null;
  for (const line of claimLines) {
    for (const m of line.matchAll(FILE_CLAIM_RE)) {
      const p = normalizePath(m[1]!);
      if (p.startsWith("http") || p.startsWith("node_modules/")) continue;
      if (knownSet && !knownSet.has(p) && !diffSet.has(p)) {
        // Only treat paths as claimed file edits when mentioned near edit verbs or inside diff-like prose;
        // still flag if it's a path-shaped claim in an edit line not in diffSet.
      }
      claimedFiles.add(p);
    }
  }
  for (const file of claimedFiles) {
    const matched = diffSet.has(file) || [...diffSet].some((d) => d.endsWith(`/${file}`));
    if (!matched) {
      findings.push({
        kind: "claimed_file_untouched",
        claim: file,
        detail: `writer claimed ${file} was modified/created, but it is absent from the diff`,
      });
    }
  }

  // 2. Tests/commands claimed to have passed vs verdict receipt criteria.
  const criteria = input.receipt?.criteria ?? [];
  const receiptMissingOrNotRun = !input.receipt || input.receipt.verdict === "not_run";
  const claimedCommands = new Set<string>();
  for (const lineMatch of text.matchAll(TEST_CLAIM_LINE_RE)) {
    const line = lineMatch[0]!;
    if (/\b(?:did not run|not run|failed|failing|skipped|unable to run)\b/i.test(line)) continue;
    for (const cmdMatch of line.matchAll(CLAIMED_CMD_RE)) {
      const cmd = cmdMatch[1]!.trim();
      if (VERIFY_MENTION_RE.test(cmd)) claimedCommands.add(cmd);
    }
  }

  for (const cmd of claimedCommands) {
    const matching = criteria.filter((c) => sameCommand(cmd, c.command));
    if (matching.length === 0) {
      findings.push({
        kind: "claimed_test_not_run",
        claim: cmd,
        detail: `writer claimed \`${cmd}\` passed, but no matching check is in the verdict receipt`,
      });
    } else if (matching.some((c) => c.exitCode === null)) {
      findings.push({
        kind: "claimed_test_not_run",
        claim: cmd,
        detail: `writer claimed \`${cmd}\` passed, but receipt recorded it as not_run`,
      });
    } else if (matching.some((c) => c.exitCode !== 0)) {
      findings.push({
        kind: "claimed_test_failed",
        claim: cmd,
        detail: `writer claimed \`${cmd}\` passed, but receipt recorded a non-zero exit code`,
      });
    }
  }

  // Also catch generic "all tests passed" claims when no check ran or receipt is not_run / fail.
  if (claimedCommands.size === 0 && TEST_RUN_OUTCOME_CLAIM_RE.test(text)) {
    if (receiptMissingOrNotRun || criteria.length === 0 || criteria.every((c) => c.exitCode === null)) {
      findings.push({
        kind: "claimed_test_not_run",
        claim: "tests passed",
        detail: "writer claimed tests passed, but no executed test receipt exists",
      });
    } else if (input.receipt?.verdict === "fail" || criteria.some((c) => c.exitCode !== 0)) {
      findings.push({
        kind: "claimed_test_failed",
        claim: "tests passed",
        detail: "writer claimed tests passed, but verdict receipt failed",
      });
    }
  }

  if (findings.length === 0) return { verdict: "pass", findings, reason: null };
  return {
    verdict: "fail",
    findings,
    reason: `false_done: ${findings.map((f) => f.detail).slice(0, 3).join("; ")}`,
  };
}
