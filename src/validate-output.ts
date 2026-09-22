import { fileAllowedByOwns, fileBlockedByNeverTouch } from "./owns-paths";
import type { TaskV2 } from "./contracts";

export type OutputCheck =
  | { ok:true }
  | { ok:false; state:"empty_output"|"validation_failed"; reason:string };

export type VerifyResult = { command:string; exitCode:number; stderr:string };

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
  return [...paths];
}

export function classifyWriterOutput(input: {
  task: TaskV2;
  produced: string[];
  contents: Record<string, string | null>;
  verifies?: VerifyResult[];
}): OutputCheck {
  for (const file of input.produced) {
    if (fileBlockedByNeverTouch(file, input.task.never_touch)) {
      return { ok:false, state:"validation_failed", reason:`never_touch matched ${file}` };
    }
    if (!fileAllowedByOwns(file, input.task.owns_paths)) {
      return { ok:false, state:"validation_failed", reason:`owns_paths rejected ${file}` };
    }
  }
  const missing = input.task.expected_outputs.filter((path) => {
    const content = input.contents[path];
    return !input.produced.includes(path) || content === null || content === undefined;
  });
  if (missing.length === input.task.expected_outputs.length) {
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
      return {
        ok:false,
        state:"validation_failed",
        reason:`verification failed (${verify.command}): ${verify.stderr || `exit ${verify.exitCode}`}`,
      };
    }
  }
  return { ok:true };
}
