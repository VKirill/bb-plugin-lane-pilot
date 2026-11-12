import { basename, dirname } from "node:path";
import { skillCatalog, type CatalogEntry, type ListedSkill } from "../../platform/server";
import { taskNeedsBrowser } from "./writer-task";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../contracts/server";

/** BB's skill list changes rarely: a list is reused for this long per project. */
export const SKILL_LIST_TTL_MS = 10 * 60_000;
/** The task's declared skills that reach the writer: a name outside the BB list is not added. */
export const SKILL_HINT_LIMIT = 8;

/** The skills a writer's attempt was given, as its dispatch recorded them: code-repair gives the same ones to its repair thread. */
export function recordedWriterSkills(dispatchContext: unknown): string[] {
  const skills = (dispatchContext as { skillPick?: { skills?: unknown } } | null | undefined)?.skillPick?.skills;
  return Array.isArray(skills) ? skills.filter((name): name is string => typeof name === "string") : [];
}

/** What the writer of one attempt gets on top of its role skills, by rule: the project-folder skills, the task's declared skills, the browser skill for a task checked on a page. */
export type WriterSkillPick = {
  skills: string[]; projectFolder: string[]; hints: string[];
  /** The folder of each skill in `skills` the BB list gives one for; a skill without a folder is not materialized. */
  sources: Record<string, string>;
  /** Why the BB list could not be read (the writer keeps its role skills); null when it was. */
  reason: string | null;
};

export type WriterSkillPickInput = {
  attemptId: string; projectId: string; hostId: string; projectCwd: string; task: TaskV2;
};

/** The folder a skill lives in, from the path the BB list gives (its SKILL.md, or the folder itself). */
export function skillFolder(filePath: string): string {
  return basename(filePath) === "SKILL.md" ? dirname(filePath) : filePath;
}

/** A plain skill (no `plugin:`) of at least six characters whose name is in the last two folders of the project's path. */
export function projectFolderSkills(projectCwd: string, catalog: CatalogEntry[]): string[] {
  const folder = projectCwd.split("/").filter(Boolean).slice(-2).join("/");
  return catalog
    .filter((entry) => !entry.name.includes(":") && entry.name.length >= 6 && folder.includes(entry.name))
    .map((entry) => entry.name);
}

/** The names the task declares (`skills`) that the catalog lists, at most SKILL_HINT_LIMIT. */
export function declaredSkills(catalog: CatalogEntry[], hints: readonly string[]): string[] {
  const names = new Set(catalog.map((entry) => entry.name));
  return [...new Set(hints)].filter((name) => names.has(name)).slice(0, SKILL_HINT_LIMIT);
}

type Listing = { catalog: CatalogEntry[]; folders: Map<string, string> };

/**
 * The extra skills of each writer spawn, by rule and without a model: the skills of the project folder, the skills the task declares
 * (the PM names them in the contract) and the built-in browser skill for a task checked on a page. The BB list is cached; a failed
 * listing gives the writer its role skills and never blocks a spawn.
 */
export function createWriterSkillPick(ctx: Pick<ServerCore, "bb">, options: { log?: (message: string) => void } = {}) {
  const { bb } = ctx;
  const log = options.log ?? ((message: string) => bb.log.info(message));
  const lists = new Map<string, { at: number; listing: Promise<Listing> }>();

  async function listCatalog(projectId: string): Promise<Listing> {
    const listed = await bb.sdk.skills.list({ projectId, environmentId: null });
    const rows = listed.skills.map((skill) => {
      const row = skill as { name: string; description?: unknown; filePath?: unknown };
      const filePath = typeof row.filePath === "string" && row.filePath ? row.filePath : null;
      return { name: row.name, description: typeof row.description === "string" ? row.description : null, filePath };
    });
    const folders = new Map(rows.flatMap((row) => (row.filePath ? [[row.name, skillFolder(row.filePath)] as const] : [])));
    return { catalog: skillCatalog(rows as ListedSkill[]), folders };
  }

  /** The catalog of a project, listed again after the TTL; a failed listing is not kept, so the next call asks BB again. */
  function listingOf(projectId: string, hostId: string): Promise<Listing> {
    const key = `${hostId}\n${projectId}`;
    const cached = lists.get(key);
    if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) return cached.listing;
    const listing = listCatalog(projectId).catch((cause: unknown) => {
      lists.delete(key);
      throw cause;
    });
    lists.set(key, { at: Date.now(), listing });
    return listing;
  }

  async function pick(input: WriterSkillPickInput): Promise<WriterSkillPick> {
    let listing: Listing | null = null;
    let reason: string | null = null;
    try { listing = await listingOf(input.projectId, input.hostId); } catch (cause) {
      reason = `list_error:${cause instanceof Error ? cause.message : String(cause)}`;
      log(`Lane Pilot writer skills ${input.attemptId}: the skill list could not be read (${reason}); the writer gets its role skills only`);
    }
    const catalog = listing?.catalog ?? [];
    const hints = declaredSkills(catalog, input.task.skills ?? []);
    const projectFolder = projectFolderSkills(input.projectCwd, catalog);
    // The browser skill is built-in, not chosen: a task checked on a page gets it (sma ap_skills).
    const named = [...new Set([...projectFolder, ...hints])];
    const skills = taskNeedsBrowser(input.task) && !named.includes("browser-automation") ? [...named, "browser-automation"] : named;
    const folders = listing?.folders ?? new Map<string, string>();
    const sources = Object.fromEntries(skills.flatMap((name) => (folders.has(name) ? [[name, folders.get(name)!] as const] : [])));
    log(`Lane Pilot writer skills ${JSON.stringify({ attemptId: input.attemptId, catalog: catalog.length, projectFolder, hints, skills })}`);
    return { skills, projectFolder, hints, sources, reason };
  }

  return { pick };
}
