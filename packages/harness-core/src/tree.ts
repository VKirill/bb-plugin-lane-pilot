import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * The editable harness of a Lane Pilot writer, as a tree of files (`rel -> content`). The edit contract is
 * omitted-is-inherited: a proposal carries only what it changes, and a file absent from a proposal keeps the base's.
 *
 *   always-on.md              lines the writer reads on every task, after the fixed brief   (ALWAYS ON, token-capped)
 *   skills/<name>/SKILL.md    a workflow loaded on demand; its name must be triggered in always-on.md
 *   skills/<name>/scripts/*   helpers carried with the skill
 *   checks/<name>.sh|.py|.mjs a deterministic check added to the task's verification
 *   hooks.json                Claude Code hook schema; fires in the tool loop, so it cannot be skipped
 *   memory.md                 at most three notes for the area, served as project memory
 */
export type Tree = Record<string, string>;

export type SurfaceSpec = {
  name: string;
  alwaysOn: readonly string[];
  /** Tokens (bytes / 4, the estimate the rule budget uses) the always-on files may hold together. */
  alwaysOnMaxTokens: number;
  skillDir: string;
  checksDir: string;
  hooksFile: string;
  memoryFile: string;
  memoryMaxNotes: number;
  hookEvents: readonly string[];
  /** Workflow JSON under workflows/. Off unless the project turns graph edits on. */
  graphFiles?: boolean;
};

export const LANE_PILOT_SURFACE: SurfaceSpec = {
  name: "lane-pilot",
  alwaysOn: ["always-on.md"],
  alwaysOnMaxTokens: 1600,
  skillDir: "skills",
  checksDir: "checks",
  hooksFile: "hooks.json",
  memoryFile: "memory.md",
  memoryMaxNotes: 3,
  hookEvents: ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"],
};

const NAME = "[a-z0-9][a-z0-9_-]*";
const GRAPH_RX = /^workflows\/[a-z0-9][a-z0-9._-]*\.json$/;
const SKILL_RX = (s: SurfaceSpec) => new RegExp(`^${esc(s.skillDir)}/(${NAME})/SKILL\\.md$`);
const SKILL_SCRIPT_RX = (s: SurfaceSpec) => new RegExp(`^${esc(s.skillDir)}/(${NAME})/scripts/[A-Za-z0-9_.-]+$`);
const CHECK_RX = (s: SurfaceSpec) => new RegExp(`^${esc(s.checksDir)}/(${NAME})\\.(sh|py|mjs)$`);
/** A check or a skill script named in prose: `checks/x.sh`, `python skills/a/scripts/b.py`, `bash checks/c.sh`. */
const SCRIPT_REF_RX = (s: SurfaceSpec) => new RegExp(`((?:${esc(s.checksDir)}/${NAME}\\.(?:sh|py|mjs))|(?:${esc(s.skillDir)}/${NAME}/scripts/[A-Za-z0-9_.-]+))`, "g");

/**
 * Output of the critic, the acceptance or a verifier must never travel inside a harness: a tree that carries it would
 * be served to later editors as evidence and teach them what the grader said instead of what the writer did.
 */
export const VERDICT_MARKERS: readonly string[] = ["evidenceSha256", "artifactRevisionSha256", "acceptance-receipt", '"findings":', '"status": "pass"', '"status":"pass"', "pass_rate"];

export class HarnessValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(problems.join(" | "));
    this.name = "HarnessValidationError";
  }
}

export const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bytes / 4, the same estimate the rule budget and the memory budget use. */
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

/** A relative path inside the tree; one that escapes it is refused before it is joined to a directory. */
export function normalizeRel(rel: string): string {
  let r = String(rel).trim().replace(/\\/g, "/");
  if (r.startsWith("/") || r.split("/").includes("..")) throw new Error(`path escapes the harness: ${rel}`);
  while (r.startsWith("./")) r = r.slice(2);
  return r.replace(/^\/+|\/+$/g, "");
}

/** Whether a path is on the editable surface. A predicate: it never throws. */
export function isAllowed(rel: string, surface: SurfaceSpec = LANE_PILOT_SURFACE): boolean {
  let r: string;
  try { r = normalizeRel(rel); } catch { return false; }
  if (surface.alwaysOn.includes(r) || r === surface.hooksFile || r === surface.memoryFile) return true;
  if (surface.graphFiles && GRAPH_RX.test(r)) return true;
  return SKILL_RX(surface).test(r) || SKILL_SCRIPT_RX(surface).test(r) || CHECK_RX(surface).test(r);
}

export const skillNames = (tree: Tree, surface: SurfaceSpec = LANE_PILOT_SURFACE): string[] =>
  [...new Set(Object.keys(tree).map((rel) => SKILL_RX(surface).exec(rel)?.[1]).filter((n): n is string => !!n))].sort();

export const checkNames = (tree: Tree, surface: SurfaceSpec = LANE_PILOT_SURFACE): string[] =>
  Object.keys(tree).filter((rel) => CHECK_RX(surface).test(rel)).sort();

export const alwaysOnText = (tree: Tree, surface: SurfaceSpec = LANE_PILOT_SURFACE): string =>
  surface.alwaysOn.map((rel) => tree[rel] ?? "").filter(Boolean).join("\n\n");

/** `rel -> content` for every file on the surface under `dir`; off-surface files are listed in `rejected`. */
export function readTree(dir: string, options: { surface?: SurfaceSpec; rejected?: string[] } = {}): Tree {
  const surface = options.surface ?? LANE_PILOT_SURFACE;
  const out: Tree = {};
  const walk = (folder: string): void => {
    let entries: string[];
    try { entries = readdirSync(folder); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(folder, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (name !== "__pycache__" && name !== "node_modules") walk(full); continue; }
      if (!st.isFile()) continue;
      const rel = relative(dir, full).replace(/\\/g, "/");
      if (!isAllowed(rel, surface)) { options.rejected?.push(rel); continue; }
      out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

/**
 * Materialise an exact tree under `dir`: editable files already there and absent from `tree` are removed, files off the
 * surface are left alone, and every always-on file exists afterwards (empty when the tree has none).
 */
export function writeTree(tree: Tree, dir: string, surface: SurfaceSpec = LANE_PILOT_SURFACE): string {
  mkdirSync(dir, { recursive: true });
  for (const rel of Object.keys(readTree(dir, { surface }))) if (!(rel in tree)) rmSync(join(dir, rel), { force: true });
  for (const rel of surface.alwaysOn) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (!(rel in tree)) { try { statSync(path); } catch { writeFileSync(path, "", "utf8"); } }
  }
  for (const [rel, content] of Object.entries(tree)) {
    const path = join(dir, normalizeRel(rel));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return dir;
}

/** A stable digest of a tree, independent of the order its files were added in. */
export function fingerprint(tree: Tree): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(tree).sort()) { h.update(rel); h.update("\0"); h.update(tree[rel] ?? ""); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}

export type DiffSummary = { added: string[]; removed: string[]; modified: string[]; alwaysOnTokenDelta: number };

export function diffSummary(before: Tree, after: Tree, surface: SurfaceSpec = LANE_PILOT_SURFACE): DiffSummary {
  const b = new Set(Object.keys(before)), a = new Set(Object.keys(after));
  return {
    added: [...a].filter((rel) => !b.has(rel)).sort(),
    removed: [...b].filter((rel) => !a.has(rel)).sort(),
    modified: [...a].filter((rel) => b.has(rel) && before[rel] !== after[rel]).sort(),
    alwaysOnTokenDelta: estimateTokens(alwaysOnText(after, surface)) - estimateTokens(alwaysOnText(before, surface)),
  };
}

export const isBase = (base: Tree, tree: Tree): boolean => {
  const d = diffSummary(base, tree);
  return d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0;
};

const frontmatter = (body: string): string => body.slice(0, 600);

function checkHooks(src: string, surface: SurfaceSpec, errs: string[]): void {
  let doc: unknown;
  try { doc = JSON.parse(src); } catch (cause) { errs.push(`${surface.hooksFile} is not valid JSON: ${(cause as Error).message}`); return; }
  const hooks = doc && typeof doc === "object" ? (doc as { hooks?: unknown }).hooks : null;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) || Object.keys(hooks).length === 0) {
    errs.push(`${surface.hooksFile} needs a top-level {"hooks": {"<Event>": [...]}} object`);
    return;
  }
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!surface.hookEvents.includes(event)) { errs.push(`${surface.hooksFile}: unknown event ${event}; the harness dispatches ${surface.hookEvents.join(", ")}`); continue; }
    if (!Array.isArray(entries)) { errs.push(`${surface.hooksFile}: ${event} must map to a list of matcher entries`); continue; }
    entries.forEach((entry, i) => {
      const list = entry && typeof entry === "object" ? (entry as { hooks?: unknown }).hooks : null;
      if (!Array.isArray(list)) { errs.push(`${surface.hooksFile}: ${event}[${i}] needs a hooks list`); return; }
      for (const hook of list) {
        const h = hook as { type?: unknown; command?: unknown } | null;
        if (!h || h.type !== "command") errs.push(`${surface.hooksFile}: ${event}[${i}] hook type must be "command"`);
        else if (typeof h.command !== "string" || !h.command.trim()) errs.push(`${surface.hooksFile}: ${event}[${i}] has an empty command`);
      }
    });
  }
}

export type TreeCensus = { alwaysOnTokens: number; files: number; skills: number; checks: number; hooks: boolean; memoryNotes: number };

/**
 * Every problem of a tree at once, as actionable prose: the message goes back to the editor verbatim as retry feedback.
 * A tree that fails is thrown away entire; nothing of it reaches a writer.
 */
export function validate(tree: Tree, options: { surface?: SurfaceSpec; alwaysOnMaxTokens?: number } = {}): TreeCensus {
  const surface = options.surface ?? LANE_PILOT_SURFACE;
  const cap = options.alwaysOnMaxTokens ?? surface.alwaysOnMaxTokens;
  const errs: string[] = [];
  for (const rel of Object.keys(tree)) {
    if (!isAllowed(rel, surface)) errs.push(`${rel} is off the editable surface (always-on.md, ${surface.skillDir}/<name>/SKILL.md, ${surface.checksDir}/<name>.sh, ${surface.hooksFile}, ${surface.memoryFile})`);
    for (const marker of VERDICT_MARKERS) {
      if (rel.includes(marker)) errs.push(`${rel} carries the verdict marker ${JSON.stringify(marker)} in its name; a harness never stores what the critic or the acceptance said`);
      else if ((tree[rel] ?? "").includes(marker)) errs.push(`${rel} contains the verdict marker ${JSON.stringify(marker)}; a harness never stores what the critic or the acceptance said`);
    }
    if (surface.graphFiles && GRAPH_RX.test(rel)) {
      let parsed: unknown;
      try { parsed = JSON.parse(tree[rel] ?? ""); } catch { parsed = null; }
      const doc = parsed && typeof parsed === "object" ? parsed as { id?: unknown; nodes?: unknown; edges?: unknown } : null;
      if (!doc || typeof doc.id !== "string" || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) errs.push(`${rel} must be JSON with id, nodes and edges`);
    }
  }
  const body = alwaysOnText(tree, surface);
  const alwaysOnTokens = estimateTokens(body);
  if (alwaysOnTokens > cap) errs.push(`always-on text is ${alwaysOnTokens} tokens, over the ${cap} cap: every token is read on every task of the area, so cut something to pay for what you add, or move it into a skill`);
  if (/\{\{|\{%/.test(body)) errs.push("always-on text contains template braces ({{ or {%); use plain words");

  const skills = skillNames(tree, surface);
  for (const name of skills) {
    const fm = frontmatter(tree[`${surface.skillDir}/${name}/SKILL.md`] ?? "");
    if (!/^description:\s*\S/m.test(fm)) errs.push(`${surface.skillDir}/${name}/SKILL.md needs a description: line in its frontmatter, or the skill is dropped at load`);
    const declared = /^name:\s*(\S+)\s*$/m.exec(fm)?.[1];
    if (declared && declared !== name) errs.push(`${surface.skillDir}/${name}/SKILL.md declares name: ${declared}, which does not match its folder; drop the line or make it ${name}`);
    if (!body.includes(name)) errs.push(`skill ${name} is never named in always-on.md, so no writer will load it; add one line: "When <situation>, load the ${name} skill"`);
  }

  const have = new Set(Object.keys(tree));
  for (const [rel, src] of Object.entries(tree)) {
    if (!(SKILL_RX(surface).test(rel) || surface.alwaysOn.includes(rel))) continue;
    for (const match of src.matchAll(SCRIPT_REF_RX(surface))) {
      const ref = match[1]!;
      if (!have.has(ref)) errs.push(`${rel} names ${ref} but that file is not in the harness; ship it in the same proposal`);
    }
  }
  for (const rel of checkNames(tree, surface)) if (!(tree[rel] ?? "").trim()) errs.push(`${rel} is empty; a check must run and exit 0 or non-zero`);

  if (surface.hooksFile in tree) checkHooks(tree[surface.hooksFile]!, surface, errs);

  let memoryNotes = 0;
  if (surface.memoryFile in tree) {
    const notes = (tree[surface.memoryFile] ?? "").split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line));
    memoryNotes = notes.length;
    if (notes.length > surface.memoryMaxNotes) errs.push(`${surface.memoryFile} holds ${notes.length} notes; a writer reads at most ${surface.memoryMaxNotes}, keep the ones that name a path or a decision`);
    for (const note of notes) if (note.length > 600) errs.push(`${surface.memoryFile}: a note is ${note.length} characters; keep each under 600`);
  }

  if (errs.length) throw new HarnessValidationError(errs);
  return { alwaysOnTokens, files: Object.keys(tree).length, skills: skills.length, checks: checkNames(tree, surface).length, hooks: surface.hooksFile in tree, memoryNotes };
}

/** One line naming what a tree carries, for an index or a log. */
export function inventory(tree: Tree, surface: SurfaceSpec = LANE_PILOT_SURFACE): string {
  const parts: string[] = [];
  const skills = skillNames(tree, surface).length, checks = checkNames(tree, surface).length;
  if (skills) parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  if (checks) parts.push(`${checks} check${checks === 1 ? "" : "s"}`);
  if (surface.hooksFile in tree) parts.push("hooks");
  if (surface.memoryFile in tree) parts.push("memory");
  return `${parts.join(", ") || "always-on edits only"}; ${estimateTokens(alwaysOnText(tree, surface))} always-on tokens`;
}
