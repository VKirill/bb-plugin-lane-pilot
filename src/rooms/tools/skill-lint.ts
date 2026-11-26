import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lintSkillDir, type SkillFile } from "./models/skill-lint";

const TEXT_FILE = /\.(md|markdown|sh|bash|py|js|mjs|cjs|ts|json|txt|yaml|yml)$/;

export function readSkillDir(dir: string): SkillFile[] {
  const walk = (current: string): string[] => readdirSync(current).flatMap((name) => {
    const full = join(current, name);
    // Bundled and installed code is not the skill's text: vendor/ and node_modules/ are skipped.
    if (name === "node_modules" || name === "vendor" || name.startsWith(".")) return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  return walk(dir)
    .filter((path) => TEXT_FILE.test(path) || !/\.[^./]+$/.test(relative(dir, path)))
    .map((path) => ({ path: relative(dir, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
}

/** `bb lane-pilot skill-lint <dir>`: lint a local skill folder (the canon lives at ~/.bb/skills/<name>/). */
export function runSkillLintCli(args: string[]): { exitCode: number; stdout?: string; stderr?: string } {
  const dir = args[0];
  if (!dir || args.length !== 1) return { exitCode: 1, stderr: "usage: bb lane-pilot skill-lint <dir>" };
  let files: SkillFile[];
  try { files = readSkillDir(dir); }
  catch { return { exitCode: 1, stderr: `bb lane-pilot skill-lint: cannot read ${dir}` }; }
  const { errors, warnings } = lintSkillDir(files);
  const lines = [...errors.map((line) => `error: ${line}`), ...warnings.map((line) => `warning: ${line}`)];
  if (!lines.length) return { exitCode: 0, stdout: `${dir}: clean` };
  return { exitCode: errors.length ? 1 : 0, stdout: lines.join("\n") };
}
