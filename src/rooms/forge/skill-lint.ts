import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../docs";

/**
 * The skill standard lint (docs/skill-standard.md): one set of rules for a skill folder — SKILL.md plus the
 * references/ and scripts/ it names. `lintSkillDir` reads a folder as {path, text}[]; the forge's `lintDraft`
 * calls the same rules for a one-file skill draft, so a forged draft and the published canon are held to one bar.
 * Errors block, warnings advise.
 */
export const SKILL_NAME = /^[a-z][a-z0-9-]{1,47}$/;
const SKILL_MD = "SKILL.md";
const DESCRIPTION_MAX = 1024;
const BODY_MAX_LINES = 500;
const BODY_MAX_BYTES = 8_192;
const DRAFT_MAX_BYTES = 40_000;

/** Forbidden grants: what a forged skill or role may never ask for. */
export const FORBIDDEN_GRANTS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /--dangerously-skip-permissions|bypassPermissions|permission-mode\s+bypass/i, why: "bypasses the permission prompts" },
  { pattern: /^tools:\s*\*\s*$|allowed-tools:\s*\*|"tools"\s*:\s*"\*"/im, why: "asks for every tool" },
  { pattern: /Bash\(\s*\*\s*\)|Bash\(rm\b|Bash\(sudo\b/i, why: "an unrestricted or destructive shell grant" },
  { pattern: /env_get|Env Catalog|\.env\b|secrets?\//i, why: "reads secrets — a forged draft gets none; the PM hands accounts by name" },
  { pattern: /guard_shell|LANE_GUARD|agent-guard|disable[_ -]?hooks?/i, why: "touches the guard or the hooks" },
  { pattern: /curl[^\n]*\|\s*(ba)?sh|wget[^\n]*\|\s*(ba)?sh/i, why: "pipes a download into a shell" },
];

export type SkillFile = { path: string; text: string };
export type SkillFinding = { severity: "error" | "warning"; code: string; file: string; message: string };

const scalar = (value: string | string[] | undefined): string => Array.isArray(value) ? value.join(" ") : value ?? "";
const isScript = (path: string) => path.startsWith("scripts/") || /\.(sh|bash|py|js|mjs|cjs|ts)$/.test(path);
/** A path the SKILL.md names: `references/x.md`, `scripts/y`, in prose or in a link. */
const NAMED_PATH = /(?:references|scripts)\/[A-Za-z0-9_@.[\]+~/-]+/g;

export function lintSkillFiles(files: SkillFile[], expectedName?: string): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const add = (severity: SkillFinding["severity"], code: string, file: string, message: string) => findings.push({ severity, code, file, message });
  const skill = files.find((file) => file.path === SKILL_MD || file.path.endsWith(`/${SKILL_MD}`));
  if (!skill) return [{ severity: "error", code: "frontmatter", file: SKILL_MD, message: "the skill has no SKILL.md" }];
  const text = skill.text;
  if (!text.trim()) { add("error", "empty", skill.path, "the skill is empty"); return findings; }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > DRAFT_MAX_BYTES) add("error", "too_big", skill.path, "the draft is over 40 KB: a skill says what to do, not everything there is");
  const lineCount = text.split("\n").length;
  if (lineCount > BODY_MAX_LINES) add("warning", "too_long", skill.path, `SKILL.md is ${lineCount} lines; the standard keeps it under ${BODY_MAX_LINES} — long material lives in references/`);
  if (bytes >= BODY_MAX_BYTES) add("warning", "body_size", skill.path, `SKILL.md is ${bytes} bytes; tool results truncate at 8 KB — move long material to references/`);
  const parsed = parseFrontmatter(text);
  if (!parsed) add("error", "frontmatter", skill.path, "the skill has no front matter (--- name, description ---)");
  else {
    const { data } = parsed;
    const name = scalar(data.name);
    if (expectedName !== undefined ? name !== expectedName : !SKILL_NAME.test(name))
      add("error", "name", skill.path, expectedName !== undefined ? `front matter name must be ${expectedName}` : "front matter needs a kebab-case name");
    const description = scalar(data.description);
    if (description.length < 40) add("error", "description", skill.path, "the description is too short to be found by: say what it does and when to use it");
    else if (description.length > DESCRIPTION_MAX) add("error", "description", skill.path, "the description is over 1024 characters: keep the triggers here, move the detail to the body");
    if (!/use when|применяется|используй|when:/i.test(description)) add("error", "trigger", skill.path, "the description has no trigger (\"Use when …\")");
    if (!/not for|do not use|\bskip\b|не используй|когда не/i.test(description)) add("warning", "scope", skill.path, "the description has no «when not to use it» clause (\"not for …\", \"SKIP: …\")");
  }
  for (const file of files) for (const grant of FORBIDDEN_GRANTS) if (grant.pattern.test(file.text)) add("error", "forbidden_grant", file.path, `forbidden grant: ${grant.why}`);
  const known = files.map((file) => file.path);
  const named = new Set<string>();
  for (const match of text.matchAll(NAMED_PATH)) {
    const target = match[0].replace(/[.,;:!?)\]]+$/, "").replace(/\/+$/, "");
    if (target) named.add(target);
  }
  for (const target of named) if (!known.some((path) => path === target || path.startsWith(`${target}/`))) add("error", "missing_file", skill.path, `${target} is named but the skill does not carry it`);
  for (const file of files) {
    if (!isScript(file.path)) continue;
    file.text.split("\n").forEach((line, index) => {
      // ponytail: a '#' inside a string truncates the line for this check; a missed swallow is a warning, not a gate.
      const code = line.replace(/#.*$/, "");
      if (!code.trim() || /^\s*(if|while|until)\b/.test(code)) return;
      const where = `${file.path}:${index + 1}`;
      if (/\|\|\s*true\b/.test(code)) add("warning", "swallow", where, "`|| true` hides the failure — a check proves its result, not its exit code");
      const muted = /2>\s*\/dev\/null/.test(code);
      // A line with a fallback (`probe 2>/dev/null || fallback`) mutes a probe, not the main command.
      if (muted && !/\|\||&&/.test(code)) add("warning", "swallow", where, "`2>/dev/null` on the main command hides its errors — a check proves its result, not its exit code");
      if (/except(\s+[\w., ]+)?\s*:\s*pass\s*$/.test(code.trim())) add("warning", "swallow", where, "`except: pass` hides the failure — a check proves its result, not its exit code");
      if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(code)) add("warning", "swallow", where, "an empty `catch {}` hides the failure — a check proves its result, not its exit code");
    });
  }
  return findings;
}

/** Lint a skill folder read as {path, text}[] (paths relative to the skill root, `/` separators). */
export function lintSkillDir(files: SkillFile[]): { errors: string[]; warnings: string[] } {
  const findings = lintSkillFiles(files);
  const render = (finding: SkillFinding) => `${finding.file}: ${finding.message}`;
  return {
    errors: findings.filter((finding) => finding.severity === "error").map(render),
    warnings: findings.filter((finding) => finding.severity === "warning").map(render),
  };
}

const TEXT_FILE = /\.(md|markdown|sh|bash|py|js|mjs|cjs|ts|json|txt|yaml|yml)$/;

function readSkillDir(dir: string): SkillFile[] {
  const walk = (current: string): string[] => readdirSync(current).flatMap((name) => {
    const full = join(current, name);
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
