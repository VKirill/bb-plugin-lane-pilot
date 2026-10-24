import { createHash } from "node:crypto";

/**
 * The forge (SMA map, The forge): the «Creator» role writes exactly one draft — a skill, a role or a workflow — into its draft folder; the
 * draft is linted (shape, a trigger to be found by, no forbidden grants), a receipt records the bytes that passed, and enabling is two
 * steps: a request on the receipt, then the confirmation that the same bytes are still there (with owner.words on, the second is the owner's).
 */
export const FORGE_KINDS = ["skill", "role", "workflow"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export const NAME = /^[a-z][a-z0-9-]{1,47}$/;

/** Draft folders: one per kind, one folder per draft. */
export const draftFolder = (kind: ForgeKind, name: string) => `.agents/forge/${kind}s/${name}`;
export const draftFile = (kind: ForgeKind, name: string) => `${draftFolder(kind, name)}/${kind === "skill" ? "SKILL.md" : kind === "role" ? `${name}.md` : `${name}.json`}`;
/** Where an enabled draft lands in the project. */
export const enabledPath = (kind: ForgeKind, name: string) => kind === "skill" ? `.claude/skills/${name}/SKILL.md` : kind === "role" ? `.claude/agents/${name}.md` : `.lane-pilot/workflows/${name}.json`;

/** Forbidden grants: what a forged skill or role may never ask for. */
export const FORBIDDEN_GRANTS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /--dangerously-skip-permissions|bypassPermissions|permission-mode\s+bypass/i, why: "bypasses the permission prompts" },
  { pattern: /^tools:\s*\*\s*$|allowed-tools:\s*\*|"tools"\s*:\s*"\*"/im, why: "asks for every tool" },
  { pattern: /Bash\(\s*\*\s*\)|Bash\(rm\b|Bash\(sudo\b/i, why: "an unrestricted or destructive shell grant" },
  { pattern: /env_get|Env Catalog|\.env\b|secrets?\//i, why: "reads secrets — a forged draft gets none; the PM hands accounts by name" },
  { pattern: /guard_shell|LANE_GUARD|agent-guard|disable[_ -]?hooks?/i, why: "touches the guard or the hooks" },
  { pattern: /curl[^\n]*\|\s*(ba)?sh|wget[^\n]*\|\s*(ba)?sh/i, why: "pipes a download into a shell" },
];

export type LintFinding = { code: string; message: string };

const frontmatter = (text: string): Record<string, string> | null => {
  if (!text.startsWith("---\n")) return null;
  const head = text.slice(4).split("\n---", 1)[0] ?? "";
  return Object.fromEntries(head.split("\n").filter((line) => /^[A-Za-z_-]+:/.test(line)).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim().replace(/^"|"$/g, "")]));
};

/** Draft lint: the shape of its kind, a description with a trigger, a size cap, no forbidden grant. */
export function lintDraft(kind: ForgeKind, name: string, text: string): LintFinding[] {
  const found: LintFinding[] = [];
  if (!text.trim()) return [{ code: "empty", message: "the draft is empty" }];
  if (Buffer.byteLength(text, "utf8") > 40_000) found.push({ code: "too_big", message: "the draft is over 40 KB: a skill or role says what to do, not everything there is" });
  if (kind === "workflow") {
    try {
      const parsed = JSON.parse(text) as { id?: unknown; nodes?: unknown; entry?: unknown; description?: unknown };
      if (parsed.id !== name) found.push({ code: "id", message: `the workflow id must be ${name}` });
      if (!Array.isArray(parsed.nodes) || !parsed.nodes.length) found.push({ code: "nodes", message: "the workflow has no nodes" });
      if (typeof parsed.entry !== "string") found.push({ code: "entry", message: "the workflow has no entry node" });
      if (!parsed.description) found.push({ code: "description", message: "the workflow has no description" });
    } catch { found.push({ code: "json", message: "the workflow draft is not JSON" }); }
  } else {
    const meta = frontmatter(text);
    if (!meta) found.push({ code: "frontmatter", message: "the draft has no front matter (--- name, description ---)" });
    else {
      if (meta.name !== name) found.push({ code: "name", message: `front matter name must be ${name}` });
      const description = meta.description ?? "";
      if (description.length < 40) found.push({ code: "description", message: "the description is too short to be found by: say what it does and when to use it" });
      if (!/use when|применяется|используй|when:/i.test(description)) found.push({ code: "trigger", message: "the description has no trigger (\"Use when …\")" });
      if (/draft:\s*true/.test(text.split("\n---", 2)[0] ?? "")) found.push({ code: "draft_mark", message: "remove draft: true and fill the trigger before linting" });
    }
  }
  for (const grant of FORBIDDEN_GRANTS) if (grant.pattern.test(text)) found.push({ code: "forbidden_grant", message: `forbidden grant: ${grant.why}` });
  return found;
}

export type ForgeReceipt = { kind: ForgeKind; name: string; path: string; sha256: string; ok: boolean; findings: LintFinding[]; at: number; requestedAt?: number; enabledAt?: number; enabledBy?: string };
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The Creator prompt: the brief of the writer who forges the one draft. */
export function creatorBrief(kind: ForgeKind, name: string, brief: string): string {
  const file = draftFile(kind, name);
  return [`You are the Creator (forge). Write exactly one ${kind} draft, ${file}, and nothing else.`,
    kind === "skill" ? "A skill: front matter with name and a description that says what it does and «Use when …» triggers; then the steps, short; the files it reads; what it never does."
      : kind === "role" ? "A role (a Claude Code agent): front matter with name, description with «Use when …», model, tools (the fewest that do the job); then what the role does, its inputs and its report."
      : "A workflow: Lane Pilot workflow JSON (id, name, description, examples, inputs, outputs, entry, nodes, edges, test) with roles that exist.",
    "Never grant: permission bypass, every tool, an unrestricted or destructive shell, secrets, the guard or the hooks, a download piped into a shell.",
    `What it is for: ${brief}`].join("\n");
}
