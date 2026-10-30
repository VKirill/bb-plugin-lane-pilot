import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const exec = promisify(execFile);
let cache: { at: number; tree: SkillTree | null } | null = null;
let pending: Promise<SkillTree | null> | null = null;

export function resetSkillTreeCache(): void {
  cache = null;
  pending = null;
}

export function parseSkillTree(raw: string): SkillTree {
  const parsed = JSON.parse(raw) as { sections?: unknown; skills?: unknown };
  if (!Array.isArray(parsed.sections) || !Array.isArray(parsed.skills)) throw new Error("skill_tree_shape");
  return parsed as SkillTree;
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

export function readSkillTreeText(): Promise<string> {
  const bin = process.env.BB_CLI || "bb";
  return exec(bin, ["tools", "skills-tree", "--skills", "--json"], { timeout: 20_000, maxBuffer: 8_000_000 }).then((out) => out.stdout);
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
    return { picked, active: verdict.by === "jev" as boolean };
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
