import { spawnAsync } from "@lane-pilot/kit";

/** The catalog tree is read at most once an hour. A failed read keeps the old full-catalog pick. */
export const SKILL_TREE_TTL_MS = 60 * 60_000;

export type SkillTreeSection = {
  id: string;
  title: string;
  titleEn?: string;
  description?: string;
  subsections?: Array<{ id: string; title: string; titleEn?: string; description?: string }>;
};

export type SkillTree = {
  sections: SkillTreeSection[];
  skills: Array<{ name: string; category: { sectionId: string; subsectionId: string } | null }>;
};

let cache: { at: number; tree: SkillTree | null } | null = null;
let pending: Promise<SkillTree | null> | null = null;

export function resetSkillTreeCache(): void {
  cache = null;
  pending = null;
}

export function parseSkillTree(raw: string): SkillTree {
  // bb core prints `{ tree: { sections }, skills }`; an older core printed `{ sections, skills }` (until 2026-11-02 only that was read,
  // and every writer's skill pick silently went without the tree).
  const parsed = JSON.parse(raw) as { sections?: unknown; skills?: unknown; tree?: { sections?: unknown } };
  const sections = parsed.sections ?? parsed.tree?.sections;
  if (!Array.isArray(sections) || !Array.isArray(parsed.skills)) throw new Error("skill_tree_shape");
  return { ...parsed, sections } as SkillTree;
}

/** Words of 4+ letters. Short tokens («3d», «ui») match too much of the tree. */
function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((word) => word.length >= 4));
}

function overlaps(task: Set<string>, text: string): boolean {
  for (const word of tokens(text)) if (task.has(word)) return true;
  return false;
}

/**
 * Skill names whose section or subsection shares a word with the task (title, area, paths).
 * Empty means nothing matched: the caller keeps the old full catalog.
 */
export function candidateNames(tree: SkillTree, text: string): string[] {
  const task = tokens(text);
  const hit = new Set<string>();
  for (const section of tree.sections) {
    const sectionText = `${section.title} ${section.titleEn ?? ""} ${section.description ?? ""}`;
    const sectionHit = overlaps(task, sectionText);
    if (sectionHit) hit.add(section.id);
    for (const sub of section.subsections ?? []) {
      if (sectionHit || overlaps(task, `${sub.title} ${sub.titleEn ?? ""} ${sub.description ?? ""}`)) hit.add(sub.id);
    }
  }
  const names = new Set<string>();
  const lower = text.toLowerCase();
  for (const skill of tree.skills) {
    const cat = skill.category;
    if (cat && (hit.has(cat.sectionId) || hit.has(cat.subsectionId))) names.add(skill.name);
    else if (lower.includes(skill.name.toLowerCase())) names.add(skill.name);
  }
  return [...names];
}

/** Cached tree. `null` (a bad read, cached for the hour) means the caller uses the old catalog. */
export function skillTreeCached(read: () => Promise<string>): Promise<SkillTree | null> {
  if (cache && Date.now() - cache.at < SKILL_TREE_TTL_MS) return Promise.resolve(cache.tree);
  if (!pending) {
    pending = read()
      .then((raw) => {
        const tree = parseSkillTree(raw);
        cache = { at: Date.now(), tree };
        return tree;
      })
      .catch(() => {
        cache = { at: Date.now(), tree: null };
        return null;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

export async function readSkillTreeText(): Promise<string> {
  const bin = process.env.BB_CLI || "bb";
  const out = await spawnAsync(bin, ["tools", "skills-tree", "--skills", "--json"], { timeout: 20_000, maxBuffer: 8_000_000 });
  if (out.error || out.status !== 0) throw out.error ?? new Error(`skills-tree exit ${out.status}: ${out.stderr.slice(0, 200)}`);
  return out.stdout;
}

/**
 * B7: Jev walks the catalog tree for a specialist or a graph step (hierarchical: section → subsection → skill).
 * `judge` is the shared Jev or null; shadow mode records receipts while the caller's own pick stands.
 */
export async function pickSkillTree(
  judge: import("@lane-pilot/jev").Jev | null,
  tree: SkillTree,
  task: { title: string; prompt: string },
  ctx: import("@lane-pilot/jev").JudgeContext = {},
): Promise<{ skills: string[]; picked: string[]; by: "jev" | "shadow" | "off" }> {
  const { skillTreePickJudgment } = await import("@lane-pilot/jev/judgments/skill-tree-pick");
  if (!judge || !tree.sections.length) return { skills: [], picked: [], by: "off" };
  const text = `${task.title}\n${task.prompt}`;
  const ask = async (level: "section" | "subsection" | "skill", path: string, options: Record<string, string>) => {
    const verdict = await judge.judge(skillTreePickJudgment, { task: text, level, path, options }, ctx);
    const picked = verdict.by === "jev" ? verdict.decision.picked : verdict.by === "fallback" && verdict.shadow?.decision ? verdict.shadow.decision.picked : [];
    return { picked, active: verdict.by === "jev" };
  };
  const sections = await ask("section", "/", Object.fromEntries(tree.sections.map((s) => [s.id, s.titleEn ?? s.title])));
  const skills: string[] = [], picked: string[] = [...sections.picked];
  let active = sections.active;
  for (const sectionId of sections.picked) {
    const section = tree.sections.find((s) => s.id === sectionId);
    const subs = section?.subsections ?? [];
    let subIds: string[] = [];
    if (subs.length) {
      const sub = await ask("subsection", `/${sectionId}`, Object.fromEntries(subs.map((s) => [s.id, s.titleEn ?? s.title])));
      active = active || sub.active;
      subIds = sub.picked;
      picked.push(...sub.picked.map((id) => `${sectionId}/${id}`));
    }
    const pool = tree.skills.filter((sk) => sk.category?.sectionId === sectionId && (!subIds.length || (sk.category.subsectionId && subIds.includes(sk.category.subsectionId))));
    if (pool.length && pool.length <= 24) {
      const hit = await ask("skill", `/${sectionId}/${subIds.join(",")}`, Object.fromEntries(pool.map((sk) => [sk.name, sk.name])));
      active = active || hit.active;
      skills.push(...hit.picked);
      picked.push(...hit.picked);
    } else skills.push(...pool.map((sk) => sk.name));
  }
  return { skills: [...new Set(skills)], picked, by: active ? "jev" : "shadow" };
}

/* --- `bb lane-pilot skills`: the PM's searchable view of the hub catalog -------------------------- */

export const SKILLS_USAGE = "bb lane-pilot skills [--section <id or name>] [--query <words>] [--json]";

export type SkillHubEntry = { name: string; description: string; category: { sectionId: string; subsectionId: string } | null };
export type SkillHub = { sections: SkillTreeSection[]; skills: SkillHubEntry[] };

/** `bb tools skills-hub --json` nests the tree under `tree`; flat `sections` is accepted too. */
export function parseSkillHub(raw: string): SkillHub {
  const parsed = JSON.parse(raw) as { tree?: { sections?: unknown }; sections?: unknown; skills?: unknown };
  const sections = parsed.tree?.sections ?? parsed.sections;
  if (!Array.isArray(sections) || !Array.isArray(parsed.skills)) throw new Error("skill_hub_shape");
  const skills = (parsed.skills as Array<Record<string, unknown>>).map((sk) => ({
    name: String(sk.name ?? ""),
    description: typeof sk.description === "string" ? sk.description : "",
    category: sk.category && typeof sk.category === "object"
      ? { sectionId: String((sk.category as Record<string, unknown>).sectionId ?? ""), subsectionId: String((sk.category as Record<string, unknown>).subsectionId ?? "") }
      : null,
  })).filter((sk) => sk.name);
  return { sections: sections as SkillTreeSection[], skills };
}

/** First sentence of a hub description; falls back to the first 160 characters. */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const cut = clean.search(/[.!?](?:\s|$)/);
  const head = cut >= 0 ? clean.slice(0, cut + 1) : clean;
  return head.length > 160 ? `${head.slice(0, 157)}…` : head;
}

function sectionHaystack(section: SkillTreeSection): string {
  return `${section.id} ${section.title} ${section.titleEn ?? ""} ${section.description ?? ""}`.toLowerCase();
}

function haystackFor(hub: SkillHub): (id: string | undefined) => string {
  const byId = new Map<string, string>();
  for (const section of hub.sections) {
    byId.set(section.id, sectionHaystack(section));
    for (const sub of section.subsections ?? []) {
      byId.set(sub.id, `${sub.id} ${sub.title} ${sub.titleEn ?? ""} ${sub.description ?? ""}`.toLowerCase());
    }
  }
  return (id) => (id ? byId.get(id) ?? "" : "");
}

/**
 * `--section` keeps the skills under a matching section or subsection (id or title, case-insensitive).
 * `--query` keeps a skill when every word hits its name, description or section titles.
 */
export function filterSkillHub(hub: SkillHub, filter: { section?: string; query?: string }): SkillHubEntry[] {
  let pool = hub.skills;
  const textOf = haystackFor(hub);
  const want = filter.section?.trim().toLowerCase();
  if (want) {
    const hit = new Set<string>();
    for (const section of hub.sections) {
      if (sectionHaystack(section).includes(want)) hit.add(section.id);
      for (const sub of section.subsections ?? []) {
        if (`${sub.id} ${sub.title} ${sub.titleEn ?? ""} ${sub.description ?? ""}`.toLowerCase().includes(want)) hit.add(sub.id);
      }
    }
    pool = pool.filter((sk) => sk.category && (hit.has(sk.category.sectionId) || hit.has(sk.category.subsectionId)));
  }
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    pool = pool.filter((sk) => {
      const hay = `${sk.name} ${sk.description} ${textOf(sk.category?.sectionId)} ${textOf(sk.category?.subsectionId)}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    });
    // A name hit ranks above a description-only hit; stable sort keeps the hub order inside each group.
    const nameHits = (sk: SkillHubEntry) => words.filter((word) => sk.name.toLowerCase().includes(word)).length;
    pool = [...pool].sort((a, b) => nameHits(b) - nameHits(a));
  }
  return pool;
}

/** Compact default output: one line per skill. */
export function formatSkillList(skills: SkillHubEntry[]): string {
  return skills.map((sk) => {
    const sentence = firstSentence(sk.description);
    return sentence ? `${sk.name} — ${sentence}` : sk.name;
  }).join("\n");
}

export async function runSkillsCli(args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const at = (flag: string) => args.indexOf(flag);
  const sectionAt = at("--section");
  const queryAt = at("--query");
  const section = sectionAt >= 0 ? args[sectionAt + 1] : undefined;
  const query = queryAt >= 0 ? args.slice(queryAt + 1).filter((arg) => !arg.startsWith("--")).join(" ") : undefined;
  const bin = process.env.BB_CLI || "bb";
  const out = await spawnAsync(bin, ["tools", "skills-hub", "--json"], { timeout: 30_000, maxBuffer: 24_000_000 });
  if (out.error || out.status !== 0) return { exitCode: 1, stderr: `skills-hub failed: ${out.error?.message ?? out.stderr.slice(0, 200)}` };
  let hub: SkillHub;
  try {
    hub = parseSkillHub(out.stdout);
  } catch {
    return { exitCode: 1, stderr: "skills-hub returned a shape this build cannot read" };
  }
  const skills = filterSkillHub(hub, { ...(section ? { section } : {}), ...(query ? { query } : {}) });
  if (args.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ sections: hub.sections, skills }, null, 2) };
  return { exitCode: 0, stdout: formatSkillList(skills) || "no skills match" };
}
