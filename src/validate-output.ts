import { fileAllowedByOwns, fileBlockedByNeverTouch } from "./owns-paths";
import { cleanCheckOutput } from "./output-excerpt";
import type { TaskV2 } from "./contracts";

export function isTaskFolderFile(path:string):boolean {
  const normalized = path.replace(/^\.\//, "").replaceAll("\\", "/");
  return normalized === ".agents/plans/items" || normalized.startsWith(".agents/plans/items/");
}

export type OutputCheck =
  | { ok:true; warnings?:string[] }
  | { ok:false; state:"empty_output"|"validation_failed"; reason:string };

export type VerifyResult = { command:string; exitCode:number; stdout:string; stderr:string; flaky?:true };

export function parseGitChangedPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (/^[ MADRCU?!]{2} /.test(line)) {
      const rest = line.slice(3).trim();
      const renamed = rest.includes(" -> ") ? rest.slice(rest.lastIndexOf(" -> ") + 4).trim() : rest;
      if (renamed) paths.add(renamed.replace(/^\.\//, ""));
      continue;
    }
    if (!line.startsWith("#")) paths.add(line.trim().replace(/^\.\//, ""));
  }
  return [...paths].filter((path) => !isTaskFolderFile(path));
}

export function isOutputPath(entry: string): boolean {
  const text = entry.trim();
  return Boolean(text) && !/\s/.test(text) && (text.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(text));
}

/** Expected files the task may not write: no attempt can produce them. */
export function unownedExpectedOutputs(task:Pick<TaskV2, "expected_outputs" | "owns_paths">):string[] {
  return task.expected_outputs.filter((entry) => entry.includes("/") && isOutputPath(entry) && !fileAllowedByOwns(entry.replace(/^\.\//, ""), task.owns_paths));
}

/** A post-merge repair task and its redispatches («x-mainfix», «x-mainfix.2»). */
export function isMainfixTask(taskId: string): boolean {
  return /-mainfix(\.\d+)*$/.test(taskId);
}

/** The reason recorded when the writer gave no answer at all; the only empty_output that reads as a provider fault. */
export const NO_ANSWER_REASON = "writer returned no output";

export function classifyWriterOutput(input: {
  task: TaskV2;
  produced: string[];
  contents: Record<string, string | null>;
  verifies?: VerifyResult[];
  /** Whether the writer's answer carried any text; without it an empty_output reads as a provider fault. */
  answered?: boolean;
  /** Owned files already dirty with known content when the attempt started (work the contract inherited). */
  preexisting?: string[];
}): OutputCheck {
  const produced = input.produced.filter((file) => !isTaskFolderFile(file));
  // Every stray file at once: the same-thread retry fixes what the reason names, and naming one of two cost
  // SelfyStudio cards-retention-1day.4 and cards-checkout-cabinet-chips.2 their last retry (2026-10-05).
  const blocked = produced.filter((file) => fileBlockedByNeverTouch(file, input.task.never_touch));
  const rejected = produced.filter((file) => !blocked.includes(file) && !fileAllowedByOwns(file, input.task.owns_paths));
  if (blocked.length || rejected.length) {
    const reason = [blocked.length ? `never_touch matched ${blocked.join(", ")}` : "",
      rejected.length ? `owns_paths rejected ${rejected.join(", ")}` : ""].filter(Boolean).join("; ");
    return { ok:false, state:"validation_failed", reason };
  }
  // A Lane PM may describe an output in prose; only path-like entries name a file to check.
  const fileOutputs = input.task.expected_outputs.filter(isOutputPath);
  // A mainfix names no files to chase: its expected_outputs are the failing commands, and its whole acceptance is
  // green checks on main (even with zero changed files). A command like `bin/check.sh` is still a command, so no
  // expected_output of a mainfix can reject it; the stray-file checks above still hold.
  if (isMainfixTask(input.task.id)) {
    return { ok:true };
  }
  if (!fileOutputs.length && !produced.length) {
    return { ok:false, state:"empty_output",
      reason: input.answered === false ? NO_ANSWER_REASON : "writer answered but changed no files" };
  }
  // A bare file name («CardMockCard.vue») names the file wherever the task owns it, not a file at the repository
  // root: 22 of 57 failed SelfyStudio attempts on 2026-10-03 were writers whose file was there under its folder.
  const resolveOutput = (path: string) => path.includes("/") ? path
    : produced.find((file) => file === path || file.endsWith(`/${path}`)) ?? path;
  // A folder («…/greeting-cards», «…/greeting-cards/», «…/greeting-cards/**») is met by any changed file under it:
  // SelfyStudio cards-preview-lightbox-fullscreen (2026-10-05) was blocked twice with three changed files in the folder.
  const folder = (entry: string) => `${entry.replace(/\/\*\*$/, "").replace(/\/+$/, "")}/`;
  const missing = fileOutputs.filter((entry) => {
    if (produced.some((file) => file.startsWith(folder(entry)))) return false;
    const path = resolveOutput(entry);
    const content = input.contents[path];
    // A named output that already sat in the workspace with content when the attempt started (work this contract
    // inherited, e.g. a sibling attempt's edits the PM lists as this task's output) is met once the attempt produced
    // its other outputs. A writer that produced nothing still fails, so pre-existing dirt never substitutes for work.
    if (input.preexisting?.includes(path) && produced.length > 0) return false;
    return !produced.includes(path) || content === null || content === undefined;
  });
  // A shape-only gate: with real work inside owns_paths (checked above) and every check green, the writer met the task
  // another way, so a named output it did not make is a warning in the receipt, not a rejection.
  const checksGreen = (input.verifies ?? []).length > 0 && (input.verifies ?? []).every((verify) => verify.exitCode === 0);
  if (missing.length > 0 && produced.length > 0 && checksGreen) {
    return { ok:true, warnings:[`missing expected_outputs: ${missing.join(", ")} (checks are green and every changed file is inside owns_paths)`] };
  }
  if (fileOutputs.length && missing.length === fileOutputs.length) {
    return { ok:false, state:"empty_output", reason:`missing expected_outputs: ${missing.join(", ")}` };
  }
  if (missing.length > 0) {
    return { ok:false, state:"validation_failed", reason:`missing expected_outputs: ${missing.join(", ")}` };
  }
  if (input.task.verify !== "none" && input.task.verification.length === 0) {
    return { ok:false, state:"validation_failed", reason:"verify is set but verification[] is empty" };
  }
  for (const verify of input.verifies ?? []) {
    if (verify.exitCode !== 0) {
      const cleaned = cleanCheckOutput(verify.stderr || "").slice(0, 300);
      return {
        ok:false,
        state:"validation_failed",
        reason:`verification failed (${verify.command}): ${cleaned || `exit ${verify.exitCode}`}`,
      };
    }
  }
  return { ok:true };
}
