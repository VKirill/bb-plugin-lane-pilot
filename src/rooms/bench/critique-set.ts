import type { BenchDb, BenchSet } from "./store";
import { insertSet } from "./store";
import type { ManifestTask, Risk } from "./types";

/**
 * The critic's eval set: PRs with a known bug planted in a patch (wave 3, pack 3). Every task carries
 * `contract.expected_findings` — the reference bugs the critic must name. A finding hits when its file
 * mentions the expected file (or is the same file) and its text shares a keyword with the expected subject.
 * The metric is recall: found/expected per task, "critique: found X/Y known bugs" in the arm report.
 */
export type ExpectedFinding = { file?: string; keyword: string; severity?: string };

export function expectedFindings(contract: Record<string, unknown> | undefined): ExpectedFinding[] {
  const raw = contract?.["expected_findings"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({ file: typeof item.file === "string" ? item.file : undefined, keyword: String(item.keyword ?? "").trim(), severity: typeof item.severity === "string" ? item.severity : undefined }))
    .filter((item) => item.keyword.length > 0);
}

type CriticFinding = { file?: string; finding?: string; criterion?: string; severity?: string };

const words = (text: string): string[] => text.toLowerCase().split(/[^a-zа-яё0-9_]+/u).filter((word) => word.length >= 4);
const baseName = (path: string) => path.split("/").pop() ?? path;

/** One expected bug is "found" when some critic finding names its file and shares a keyword with its subject. */
export function judgeCriticFindings(findings: readonly CriticFinding[], expected: readonly ExpectedFinding[]): { found: number; total: number; missing: string[] } {
  const missing: string[] = [];
  let found = 0;
  for (const bug of expected) {
    const keys = words(bug.keyword);
    const hit = findings.some((finding) => {
      const fileOk = !bug.file || (finding.file ?? "").endsWith(baseName(bug.file));
      const text = `${finding.finding ?? ""} ${finding.criterion ?? ""}`.toLowerCase();
      const keyOk = keys.length === 0 || keys.some((key) => text.includes(key));
      return fileOk && keyOk;
    });
    if (hit) found += 1;
    else missing.push(bug.keyword);
  }
  return { found, total: expected.length, missing };
}

/** The critic's parsed findings of one task's code-critique receipt. */
export function findingsOfResult(result: unknown): CriticFinding[] {
  const list = (result as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is CriticFinding => typeof item === "object" && item !== null);
}

/**
 * Recall of the known bugs across an arm's receipts: `receipts` maps taskId → critic result
 * (the caller reads the code-critique stage receipt per task). Returns the report line.
 */
export function critiqueRecallLine(tasks: readonly ManifestTask[], receipts: (taskId: string) => unknown): { line: string | null; found: number; total: number } {
  let found = 0, total = 0;
  const missed: string[] = [];
  for (const task of tasks) {
    const expected = expectedFindings(task.contract);
    if (!expected.length) continue;
    const judge = judgeCriticFindings(findingsOfResult(receipts(task.taskId)), expected);
    found += judge.found;
    total += judge.total;
    missed.push(...judge.missing.slice(0, 2).map((bug) => `${task.taskId}:${bug}`));
  }
  if (!total) return { line: null, found: 0, total: 0 };
  return { line: `critique: found ${found}/${total} known bugs${missed.length ? ` (missed e.g. ${missed.slice(0, 3).join(", ")})` : ""}`, found, total };
}

/** A sealed set entry: one PR-shaped task — a buggy patch, its reference finding. `outcome` marks real history (S4): how the PR ended. */
export type SealedEntry = { taskId: string; title: string; risk?: Risk; diff: string; expected_findings?: ExpectedFinding[]; hard?: boolean; outcome?: "accepted" | "reverted" | "fixed_after" };

/**
 * Loads a sealed manifest (JSON array or { tasks: [...] }) as a bench set. The tasks travel as contract text —
 * no repo, no warm-up: a critic arm applies the patch itself, or reads it as the review evidence.
 */
export function loadSealedSet(db: BenchDb, input: { version: string; manifest: { tasks: SealedEntry[] } | SealedEntry[]; now?: number }): BenchSet {
  const entries = Array.isArray(input.manifest) ? input.manifest : input.manifest.tasks;
  const tasks: ManifestTask[] = entries.map((entry, index) => ({
    taskId: entry.taskId, position: index, projectId: "critic-eval", projectName: "critic-eval", hostId: "", repoPath: "",
    stratum: "critique", hard: entry.hard ?? false, risk: entry.risk ?? "medium", area: "critique",
    initialHeadSha: "sealed", solutionCommit: "sealed", solutionPatchSha256: "",
    contract: { title: entry.title, diff: entry.diff, expected_findings: entry.expected_findings ?? [], kind: "critic_eval", ...(entry.outcome ? { outcome: entry.outcome } : {}) },
    warm: { base: [], solution: [], discriminating: [], applied: "apply" as const, files: [] },
    validator: "critique_finds",
  }));
  return insertSet(db, { version: input.version, tasks, rejected: [], candidateCount: tasks.length, config: { sealed: true, stratum: "critique" }, now: input.now });
}

import sealedManifest from "../../../bench/known-bugs-v1.json";
import realPrsManifest from "../../../bench/real-prs-v1.json";
import { getSet } from "./store";

/** The severity a critic finding needs on an accepted PR to count as a false alarm; an unmarked note is just a note. */
const ALARM_SEVERITIES = new Set(["blocker", "critical", "high", "error"]);

/**
 * S4: the advisory score of the code critic on real history. A bad PR (reverted, fixed after) is caught when the critic
 * names one of its expected findings; a clean one is a false alarm when a finding claims blocker/critical/high severity.
 */
export function advisoryCritiqueLine(tasks: readonly ManifestTask[], receipts: (taskId: string) => unknown): { line: string | null; caught: number; bad: number; falseAlarms: number; clean: number } {
  let caught = 0, bad = 0, falseAlarms = 0, clean = 0;
  for (const task of tasks) {
    const outcome = (task.contract as { outcome?: string }).outcome;
    if (!outcome) continue;
    const findings = findingsOfResult(receipts(task.taskId));
    if (outcome === "accepted") {
      clean += 1;
      if (findings.some((finding) => ALARM_SEVERITIES.has((finding.severity ?? "").toLowerCase()))) falseAlarms += 1;
    } else {
      bad += 1;
      if (judgeCriticFindings(findings, expectedFindings(task.contract)).found > 0) caught += 1;
    }
  }
  if (!bad && !clean) return { line: null, caught: 0, bad: 0, falseAlarms: 0, clean: 0 };
  return { line: `advisory critique: caught ${caught}/${bad} bad PRs, ${falseAlarms} false alarm${falseAlarms === 1 ? "" : "s"} on ${clean} clean PRs`, caught, bad, falseAlarms, clean };
}

/** Registers the bundled sealed sets once (mount, idempotent by version): the night then picks them up like any set. */
export function ensureSealedSets(db: BenchDb): string[] {
  const added: string[] = [];
  const manifests = [sealedManifest as { version: string; tasks: SealedEntry[] }, realPrsManifest as { version: string; tasks: SealedEntry[] }];
  for (const manifest of manifests) {
    if (!getSet(db, manifest.version)) {
      loadSealedSet(db, { version: manifest.version, manifest });
      added.push(manifest.version);
    }
  }
  return added;
}
