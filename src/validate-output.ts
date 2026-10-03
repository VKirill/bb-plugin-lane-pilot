import { fileAllowedByOwns, fileBlockedByNeverTouch } from "./owns-paths";
import type { TaskV2 } from "./contracts";

export type OutputCheck =
  | { ok:true }
  | { ok:false; state:"empty_output"|"validation_failed"; reason:string };

export type VerifyResult = { command:string; exitCode:number; stdout:string; stderr:string };

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

export function isOutputPath(entry: string): boolean {
  const text = entry.trim();
  return Boolean(text) && !/\s/.test(text) && (text.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(text));
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
  // A Lane PM may describe an output in prose; only path-like entries name a file to check.
  const fileOutputs = input.task.expected_outputs.filter(isOutputPath);
  if (!fileOutputs.length && !input.produced.length) {
    return { ok:false, state:"empty_output", reason:"writer changed no files" };
  }
  // A bare file name («CardMockCard.vue») names the file wherever the task owns it, not a file at the repository
  // root: 22 of 57 failed SelfyStudio attempts on 2026-10-03 were writers whose file was there under its folder.
  const resolveOutput = (path: string) => path.includes("/") ? path
    : input.produced.find((file) => file === path || file.endsWith(`/${path}`)) ?? path;
  const missing = fileOutputs.filter((entry) => {
    const path = resolveOutput(entry);
    const content = input.contents[path];
    return !input.produced.includes(path) || content === null || content === undefined;
  });
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
      return {
        ok:false,
        state:"validation_failed",
        reason:`verification failed (${verify.command}): ${verify.stderr || `exit ${verify.exitCode}`}`,
      };
    }
  }
  return { ok:true };
}
