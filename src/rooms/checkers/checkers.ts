import { filterOwnershipNoise } from "@lane-pilot/settings-catalog";
import type { TaskV2 } from "../contracts";
import { MAX_FILE_EXCERPT_BYTES, buildCandidateEvidence, codeCritiquePrompt, critiquePrompt, parseCodeCritique, parseCritique } from "../critique";
import { blindPlanFact } from "../tasks";
import type { PlanFactFacts, PlanFactTable } from "../tasks";
import { lintContract } from "../tasks/server";
import { findUnownedChanges } from "../verification";
import { changedRanges, linesOf } from "./linediff";
import { sha256, type CheckerId, type CheckerResult, type FileChange, type PlanFactClaim, type PlantedDefect } from "./types";

/** What a checker looks at: the contract, the files the candidate changed, and the writer's table of claims. */
export type Subject = { contract: TaskV2; changes: FileChange[]; claim: PlanFactClaim };

export type CommandRun = { command: string; exitCode: number; stdout: string; stderr: string };

/** The checks of a contract run against a subject (in a clone of the project at the task's base). */
export interface VerificationSession {
  run(subject: Subject): Promise<CommandRun[]>;
  close(): Promise<void>;
}

/** A model call. The service owns the budget; the port only asks. `tokens` and `costUsd` are what the call is known to have cost. */
export interface ModelPort {
  ask(prompt: string, kind: "code_critic" | "plan_critic", where?: Where): Promise<{ text: string; tokens: number | null; costUsd: number | null }>;
}

/** The project folder a critic thread works in (the candidate's own, as a real critic does). */
export type Where = { projectId: string; hostId: string; path: string };

const live = (changes: readonly FileChange[]) => changes.filter((change) => change.after !== change.before);

/** The findings of the ownership check: the changed paths no `owns_paths` entry covers (or `never_touch` bars), noise filtered the way the pipeline does. */
export function ownershipFindings(subject: Subject): string[] {
  const { contract } = subject;
  const paths = filterOwnershipNoise(live(subject.changes).map((change) => change.path));
  return findUnownedChanges(paths, { project_cwd: contract.project_cwd, owns_paths: contract.owns_paths, never_touch: contract.never_touch, verification: contract.verification.map((check) => ({ cwd: check.cwd })) });
}

/** The error codes of the contract lint that need no machine (`kinds` null: the rules that probe files stay silent, as they do when the machine cannot be asked). */
export function lintFindings(subject: Subject): string[] {
  const { errors } = lintContract({ task: subject.contract, workspacePath: subject.contract.project_cwd, hostId: "checkers", kinds: null, sandboxUnsafe: [], openTasks: [], deadDependencies: [] });
  return [...new Set(errors.map((error) => error.code))].sort();
}

/** The plan→fact blind check: the items of the contract the writer's table claims and the diff does not show. */
export function planFactFindings(subject: Subject): string[] {
  const changed: Record<string, "all" | Array<[number, number]>> = {}, lineCount: Record<string, number> = {}, produced: string[] = [];
  for (const change of live(subject.changes)) {
    produced.push(change.path);
    if (change.after === null) continue;
    changed[change.path] = change.before === null ? "all" : changedRanges(change.before, change.after);
    lineCount[change.path] = linesOf(change.after).length;
  }
  const table: PlanFactTable = { status: "ok", rows: subject.claim.rows.map((row) => ({ item: row.item, status: "done" as const, evidence: row.evidence })) };
  const check = blindPlanFact(subject.contract.acceptance, table, { produced, changed, lineCount, hunksKnown: true, contractCommands: subject.contract.verification.map((item) => item.command), ran: [] });
  return check.blocking.map((item) => `item:${item}`);
}

/** The failing commands of a run of the contract's checks. */
export const verificationFindings = (runs: readonly CommandRun[]): string[] => runs.filter((run) => run.exitCode !== 0).map((run) => run.command);

/** A deterministic checker's verdict on a planted subject: it caught the defect when it raises something the clean candidate did not. */
export function judge(checker: CheckerId, planted: readonly string[], control: readonly string[], detail?: string): CheckerResult {
  const fresh = planted.filter((finding) => !control.includes(finding));
  return fresh.length
    ? { checker, outcome: "hit", flagged: true, detail: `${detail ? `${detail}: ` : ""}${fresh.slice(0, 3).join("; ")}`.slice(0, 300) }
    : { checker, outcome: "miss", flagged: false, detail: detail ?? "nothing new raised" };
}

export type ModelAnswer = { flagged: boolean; status: string; paths: string[]; text: string };

const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size)}…` : text);

function candidateEvidence(subject: Subject, runs: readonly CommandRun[]) {
  const changed = live(subject.changes).filter((change) => change.after !== null);
  const hashes: Record<string, string | null> = {}, baseline: Record<string, string | null> = {};
  for (const change of changed) { hashes[change.path] = sha256(change.after!); baseline[change.path] = change.before === null ? null : sha256(change.before); }
  return buildCandidateEvidence({
    produced: changed.map((change) => change.path), hashes, baselineHashes: baseline,
    verification: runs.map((run) => ({ command: run.command, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr })),
    files: changed.map((change) => ({ path: change.path, content: change.after })), output: "",
    ownsPaths: subject.contract.owns_paths, neverTouch: subject.contract.never_touch, dirtOk: true,
  });
}

/** The prompt the pipeline's code critic would get for this candidate (same builders, same packet), and whether the defect is inside what it is shown. */
export function codeCriticPrompt(subject: Subject, runs: readonly CommandRun[], defect: PlantedDefect | null): { prompt: string; visible: boolean } {
  const evidence = candidateEvidence(subject, runs);
  const shown = defect?.path ? evidence.files.find((file) => file.path === defect.path) : null;
  let visible = true;
  if (defect?.path && defect.line) {
    const change = subject.changes.find((item) => item.path === defect.path);
    const head = change?.after ? linesOf(change.after).slice(0, defect.line).join("\n") : "";
    visible = Buffer.byteLength(head, "utf8") <= MAX_FILE_EXCERPT_BYTES && (shown !== undefined || defect.path === null);
  }
  return { prompt: codeCritiquePrompt({ evidence, task: subject.contract, agent: "code-critic" }), visible };
}

/** Reads a code critic's answer the way the pipeline does; `paths` are the files its findings name. */
export function readCodeCritic(text: string): ModelAnswer {
  const parsed = parseCodeCritique(text);
  return { flagged: (parsed.status ?? (parsed.decision === "approve" ? "pass" : "rework")) !== "pass", status: parsed.status ?? parsed.decision, paths: parsed.findings.flatMap((row) => (row.path ? [row.path] : [])), text: JSON.stringify(parsed.findings.map((row) => [row.finding, row.evidence])) };
}

/** The plan the plan critic reads: the objective, the acceptance items and the checks. */
export const planText = (contract: TaskV2): string => [
  `Objective: ${contract.objective}`, "Acceptance:", ...contract.acceptance.map((item) => `- ${item}`),
  "Verification:", ...contract.verification.map((item) => `- ${item.command} (in ${item.cwd})`),
].join("\n");

export const planCriticPrompt = (contract: TaskV2): string => critiquePrompt({ plan: planText(contract), task: contract, agent: "plan-critic" });

export function readPlanCritic(text: string): ModelAnswer {
  const parsed = parseCritique(text);
  return { flagged: parsed.status !== "pass", status: parsed.status, paths: [], text: JSON.stringify(parsed.findings.map((row) => [row.finding, row.evidence ?? ""])) };
}

const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** A model verdict on a planted candidate: a hit when it is not a pass and it names the defect's file (or, for the plan, the masked check) and did not name that file on the clean candidate; not a pass elsewhere is off target. */
export function judgeModel(checker: "code_critic" | "plan_critic", answer: ModelAnswer, defect: PlantedDefect | null, extra: Pick<CheckerResult, "tokens" | "costUsd" | "ms">, controlPaths: readonly string[] = []): CheckerResult {
  if (!defect) return { checker, outcome: answer.flagged ? "hit" : "miss", flagged: answer.flagged, detail: `control: ${answer.status}${answer.flagged ? `: ${clip(answer.text, 300)}` : ""}`, ...extra };
  if (!answer.flagged) return { checker, outcome: "miss", flagged: false, detail: answer.status, ...extra };
  // A file the critic already flagged on the clean candidate says nothing about the defect: it flags that file whatever is in it.
  if (checker === "code_critic" && defect.path !== null && controlPaths.some((path) => sameFile(path, defect.path!))) {
    return { checker, outcome: "off_target", flagged: true, detail: `${answer.status}, but the clean candidate got a finding on ${defect.path} too`, ...extra };
  }
  const onTarget = checker === "code_critic"
    ? (defect.path !== null && (answer.paths.some((path) => sameFile(path, defect.path!)) || answer.text.includes(defect.path.split("/").pop()!)))
    : /\|\|\s*true|always (?:pass|exit)|swallow|mask/i.test(answer.text);
  return { checker, outcome: onTarget ? "hit" : "off_target", flagged: true, detail: `${answer.status}: ${clip(answer.text, 200)}`, ...extra };
}
