import { sha256Hex } from "@lane-pilot/kit";

/**
 * Which skills a writer loads for one task (PM calibration 2026-10-09: 28 real hub tasks against a 213-skill catalog, recall 0.90,
 * 0.21 wrong extras per task). Two questions go to System One: the kind of each skill (domain work or how agents are run), asked
 * once per skill and cached by its text; then whether the skill teaches the product or technology this task edits, asked per task
 * with the task's plan in the state. The plan is required: without it three.js skills ranked 115–165 for three.js tasks.
 *
 * This module holds the catalog, the questions and the pick. The caller brings the Jev call (`ask`) and the cache of the kinds.
 */
export const SKILL_PICK_THRESHOLD = 0.3;
export const SKILL_PICK_TOP = 5;
/** A skill whose probability of «domain» is below this is not a skill a task can be about. */
export const SKILL_KIND_THRESHOLD = 0.2;
export const SKILL_QUESTION_CHUNK = 8;
export const SKILL_DESCRIPTION_CHARS = 420;
export const SKILL_HINT_LIMIT = 8;
export const SKILL_PLAN_CHARS = 4000;
export const SKILL_OBJECTIVE_CHARS = 1200;
/** The writer role's own skills: the role always has them, so the catalog never lists them. */
export const WRITER_BASE_SKILLS: readonly string[] = ["writer-practices", "karpathy-guidelines"];

export type ListedSkill = { name: string; description?: string | null };
export type CatalogEntry = { name: string; description: string };
export type SkillQuestion = { instructions: string; criteria: Record<string, string> };
/** The probability of each criterion, per question id; a question without an answer is missing from it. */
export type SkillAnswers = Record<string, Record<string, number>>;
/** One System One call; it resolves to the answers, or to null when the call failed. */
export type SkillAsk = (state: unknown, questions: Record<string, SkillQuestion>) => Promise<SkillAnswers | null>;
/** The kind verdict (the probability of «domain») of a skill, by the sha of its name and description. */
export type KindCache = { get(key: string): Promise<number | undefined>; set(key: string, domainP: number): Promise<void> };

export type PickTaskInput = {
  title: string; objective: string; owns_paths: string[]; expected_outputs: string[]; acceptance: string[]; verification_commands: string[];
};
export type SkillPickInput = {
  enabled: boolean; catalog: CatalogEntry[]; hints: string[]; task: PickTaskInput; plan: string; projectCwd: string;
  ask: SkillAsk; kindCache: KindCache; threshold?: number; top?: number;
};
/** `skills` is what the writer gets on top of its role: the project-folder skills, the picks and the hints, each once. */
export type SkillPick = {
  skills: string[]; picked: Array<{ name: string; p: number }>; projectFolder: string[]; hints: string[];
  catalog: number; kept: number; unanswered: number;
};

/**
 * The skills the pick may choose from: a listed skill with a description, without the writer's own skills, and without a
 * `plugin:name` copy of a plain name that is listed too. A skill with no description is skipped: a name alone ranked top by mistake.
 */
export function skillCatalog(listed: ListedSkill[]): CatalogEntry[] {
  const plain = (name: string) => name.slice(name.lastIndexOf(":") + 1);
  const plainNames = new Set(listed.map((skill) => skill.name).filter((name) => !name.includes(":")));
  const seen = new Set<string>();
  const catalog: CatalogEntry[] = [];
  for (const skill of listed) {
    const description = (skill.description ?? "").trim();
    if (!description || WRITER_BASE_SKILLS.includes(plain(skill.name))) continue;
    if (skill.name.includes(":") && plainNames.has(plain(skill.name))) continue;
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    catalog.push({ name: skill.name, description });
  }
  return catalog;
}

export function kindCacheKey(entry: CatalogEntry): string {
  return sha256Hex(`${entry.name}\n${entry.description}`);
}

const clipDescription = (entry: CatalogEntry) => entry.description.slice(0, SKILL_DESCRIPTION_CHARS);

export function kindQuestion(entry: CatalogEntry): SkillQuestion {
  return {
    instructions: `Skill — ${entry.name}: ${clipDescription(entry)}\nWhat is this skill mainly about?`,
    criteria: {
      domain: "doing real work in a product, codebase, framework, technology, platform, API or content field (for example a specific app, a library, design, SEO, a cloud, a payment API)",
      agent_ops: "how AI agents themselves are run or organised: orchestration, task contracts, lanes, memory, sessions, skills authoring, prompts, BB/agent configuration, sign-in of tools",
    },
  };
}

export function taskQuestion(entry: CatalogEntry): SkillQuestion {
  return {
    instructions: `Skill — ${entry.name}: ${clipDescription(entry)}\nThe agent will edit code for this task. Does this skill teach how to work with the specific product, codebase or technology the task's files and commands belong to? Skills about running agents, orchestration, memory, planning or other products are no.`,
    criteria: {
      yes: "yes: the skill covers the exact product, codebase or technology of this task",
      no: "no",
    },
  };
}

export function skillPickState(task: PickTaskInput, plan: string, projectCwd: string): Record<string, unknown> {
  return { task: {
    title: task.title, objective: task.objective.slice(0, SKILL_OBJECTIVE_CHARS), owns_paths: task.owns_paths,
    expected_outputs: task.expected_outputs, acceptance: task.acceptance, verification_commands: task.verification_commands,
    project_folder: projectCwd, plan: plan.slice(0, SKILL_PLAN_CHARS),
  } };
}

type Chunk = { entries: CatalogEntry[]; questions: Record<string, SkillQuestion> };
type Answered = { entry: CatalogEntry; probabilities: Record<string, number> };

/** The entries cut into calls of at most SKILL_QUESTION_CHUNK questions; each question is keyed by its place in the chunk. */
function chunksOf(entries: CatalogEntry[], question: (entry: CatalogEntry) => SkillQuestion): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < entries.length; start += SKILL_QUESTION_CHUNK) {
    const part = entries.slice(start, start + SKILL_QUESTION_CHUNK);
    chunks.push({ entries: part, questions: Object.fromEntries(part.map((entry, index) => [`q${index}`, question(entry)])) });
  }
  return chunks;
}

/** Asks every chunk at once. A chunk that fails, or a question it did not answer, leaves its entries unanswered. */
async function answerChunks(chunks: Chunk[], state: unknown, ask: SkillAsk): Promise<{ answered: Answered[]; unanswered: number }> {
  const results = await Promise.all(chunks.map(async (chunk) => {
    const answers = await Promise.resolve().then(() => ask(state, chunk.questions)).catch(() => null);
    const answered = chunk.entries.flatMap((entry, index) => {
      const probabilities = answers?.[`q${index}`];
      return probabilities && typeof probabilities === "object" ? [{ entry, probabilities }] : [];
    });
    return { answered, unanswered: chunk.entries.length - answered.length };
  }));
  return { answered: results.flatMap((result) => result.answered), unanswered: results.reduce((sum, result) => sum + result.unanswered, 0) };
}

/** The skills whose kind is «domain» at or above the kind threshold; a skill nobody answered for is not kept. */
async function keptByKind(catalog: CatalogEntry[], ask: SkillAsk, cache: KindCache): Promise<{ kept: CatalogEntry[]; unanswered: number }> {
  const domainOf = new Map<CatalogEntry, number>();
  const unknown: CatalogEntry[] = [];
  const cached = await Promise.all(catalog.map((entry) => cache.get(kindCacheKey(entry)).catch(() => undefined)));
  catalog.forEach((entry, index) => {
    const p = cached[index];
    if (typeof p === "number") domainOf.set(entry, p);
    else unknown.push(entry);
  });
  const { answered, unanswered } = await answerChunks(chunksOf(unknown, kindQuestion), { catalog: "skills an agent can load" }, ask);
  for (const { entry, probabilities } of answered) {
    const p = probabilities.domain;
    if (typeof p !== "number") continue;
    domainOf.set(entry, p);
    // A cache that cannot be written only costs the next pick its Jev call.
    await cache.set(kindCacheKey(entry), p).catch(() => undefined);
  }
  return { kept: catalog.filter((entry) => (domainOf.get(entry) ?? 0) >= SKILL_KIND_THRESHOLD), unanswered };
}

/** The skills whose «yes» reaches the threshold, the most probable first, at most `top`. */
export function pickByYes(answered: Answered[], threshold: number, top: number): Array<{ name: string; p: number }> {
  return answered.flatMap(({ entry, probabilities }) => {
    const p = probabilities.yes;
    return typeof p === "number" && p >= threshold ? [{ name: entry.name, p }] : [];
  }).sort((a, b) => b.p - a.p).slice(0, top);
}

/** A plain skill (no `plugin:`) of at least six characters whose name is in the last two folders of the project's path. */
export function projectFolderSkills(projectCwd: string, catalog: CatalogEntry[]): string[] {
  const folder = projectCwd.split("/").filter(Boolean).slice(-2).join("/");
  return catalog
    .filter((entry) => !entry.name.includes(":") && entry.name.length >= 6 && folder.includes(entry.name))
    .map((entry) => entry.name);
}

/** The PM's hints that name a skill of the catalog, at most SKILL_HINT_LIMIT: a hint outside the catalog is not added. */
export function hintedSkills(catalog: CatalogEntry[], hints: string[]): string[] {
  const names = new Set(catalog.map((entry) => entry.name));
  return [...new Set(hints)].filter((name) => names.has(name)).slice(0, SKILL_HINT_LIMIT);
}

/**
 * The writer's extra skills for one task. With the pick off only the hints are added. A failed call or chunk adds nothing
 * (it is counted in `unanswered`), so the role's own skills and the hints are always there.
 */
export async function pickWriterSkills(input: SkillPickInput): Promise<SkillPick> {
  const hints = hintedSkills(input.catalog, input.hints);
  const base = { catalog: input.catalog.length, picked: [], projectFolder: [], hints, unanswered: 0 };
  if (!input.enabled) return { ...base, skills: hints, kept: 0 };
  const { kept, unanswered: kindMissed } = await keptByKind(input.catalog, input.ask, input.kindCache);
  const state = skillPickState(input.task, input.plan, input.projectCwd);
  const { answered, unanswered } = await answerChunks(chunksOf(kept, taskQuestion), state, input.ask);
  const picked = pickByYes(answered, input.threshold ?? SKILL_PICK_THRESHOLD, input.top ?? SKILL_PICK_TOP);
  const projectFolder = projectFolderSkills(input.projectCwd, input.catalog);
  const skills = [...new Set([...projectFolder, ...picked.map((pick) => pick.name), ...hints])];
  return { ...base, skills, picked, projectFolder, kept: kept.length, unanswered: kindMissed + unanswered };
}
