import { dirname } from "node:path";
import { pickWriterSkills, skillCatalog, type CatalogEntry, type KindCache, type ListedSkill, type SkillAsk, type SkillPick, type PickTaskInput } from "@lane-pilot/jev/judgments/skill-pick";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../core/server";

/** A writer spawn never waits longer than this for the pick; a pick that runs out gives the writer its role skills only. */
export const SKILL_PICK_DEADLINE_MS = 15_000;
/** BB's skill list changes rarely: a list is reused for this long per project. */
export const SKILL_LIST_TTL_MS = 10 * 60_000;
const JUDGE_TIMEOUT_MS = 6_000;
const KIND_KEY_PREFIX = "writer-skill-kind:";

/** `writer.skill_pick` is on unless the owner set it to off, in the same words the other switches read as off. */
export function skillPickOn(value: unknown): boolean {
  return !(value === "off" || value === false || value === "false" || value === 0 || value === "0");
}

/** The skills a writer's attempt was given, as its dispatch recorded them: code-repair gives the same ones to its repair thread. */
export function recordedWriterSkills(dispatchContext: unknown): string[] {
  const skills = (dispatchContext as { skillPick?: { skills?: unknown } } | null | undefined)?.skillPick?.skills;
  return Array.isArray(skills) ? skills.filter((name): name is string => typeof name === "string") : [];
}

/** What the writer of one attempt gets: the picked names with their p(yes), kept in the attempt's dispatch for the code-repair. */
export type WriterSkillPick = {
  enabled: boolean; skills: string[]; picked: Array<{ name: string; p: number }>; projectFolder: string[]; hints: string[];
  /** Why the pick gave no picks: a timeout or an error (the writer keeps its role skills); null when the pick ran. */
  reason: string | null;
};

export type WriterSkillPickInput = {
  attemptId: string; projectId: string; hostId: string; projectCwd: string; task: TaskV2; plan: string; settings: Record<string, unknown>;
};

const pickTask = (task: TaskV2): PickTaskInput => ({
  title: task.title, objective: task.objective, owns_paths: task.owns_paths, expected_outputs: task.expected_outputs,
  acceptance: task.acceptance, verification_commands: task.verification.map((check) => check.command),
});

const noPick = (enabled: boolean, reason: string): WriterSkillPick => ({ enabled, skills: [], picked: [], projectFolder: [], hints: [], reason });

/** The description of a skill in its SKILL.md frontmatter, for a skill the BB list gives without one. */
async function frontmatterDescription(bb: ServerCore["bb"], hostId: string, path: string): Promise<string | null> {
  const file = await bb.sdk.files.read({ hostId, rootPath: dirname(path), path }).catch(() => null);
  const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
  if (typeof content !== "string") return null;
  const frontmatter = content.split(/^---\s*$/m)[1] ?? "";
  return /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
}

/**
 * Picks the extra skills of each writer spawn with Jev (see `@lane-pilot/jev/judgments/skill-pick`). The catalog and the kinds are
 * cached, the pick is bounded by SKILL_PICK_DEADLINE_MS, and a failure gives the writer its role skills, never a blocked spawn.
 */
export function createWriterSkillPick(ctx: Pick<ServerCore, "bb" | "host">, options: { deadlineMs?: number; log?: (message: string) => void } = {}) {
  const { bb, host } = ctx;
  const deadlineMs = options.deadlineMs ?? SKILL_PICK_DEADLINE_MS;
  const log = options.log ?? ((message: string) => bb.log.info(message));
  const lists = new Map<string, { at: number; catalog: Promise<CatalogEntry[]> }>();

  async function listCatalog(projectId: string, hostId: string): Promise<CatalogEntry[]> {
    const listed = await bb.sdk.skills.list({ projectId, environmentId: null });
    const rows: ListedSkill[] = await Promise.all(listed.skills.map(async (skill) => {
      const row = skill as { name: string; description?: unknown; path?: unknown };
      const description = typeof row.description === "string" && row.description.trim() ? row.description
        : typeof row.path === "string" ? await frontmatterDescription(bb, hostId, row.path) : null;
      return { name: row.name, description };
    }));
    return skillCatalog(rows);
  }

  /** The catalog of a project, listed again after the TTL; a failed listing is not kept, so the next pick asks BB again. */
  function catalogOf(projectId: string, hostId: string): Promise<CatalogEntry[]> {
    const key = `${hostId}\n${projectId}`;
    const cached = lists.get(key);
    if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) return cached.catalog;
    const catalog = listCatalog(projectId, hostId).catch((cause: unknown) => {
      lists.delete(key);
      throw cause;
    });
    lists.set(key, { at: Date.now(), catalog });
    return catalog;
  }

  /** One councilJudge call (System One, 8 questions at most); the answers are null when the host did not judge. */
  const askJev = (hostId: string): SkillAsk => async (state, questions) => {
    const judged = await host.call("councilJudge", {
      requestedHostId: hostId, state: JSON.stringify(state).slice(0, 60_000), questions,
    }, { hostId, timeoutMs: JUDGE_TIMEOUT_MS });
    return judged.status === "ok" ? judged.probabilities ?? null : null;
  };

  const kindCache: KindCache = {
    get: async (key) => {
      const value = await bb.storage.kv.get(`${KIND_KEY_PREFIX}${key}`);
      return typeof value === "number" ? value : undefined;
    },
    set: async (key, domainP) => {
      await bb.storage.kv.set(`${KIND_KEY_PREFIX}${key}`, domainP);
    },
  };

  async function pick(input: WriterSkillPickInput): Promise<WriterSkillPick> {
    const enabled = skillPickOn(input.settings["writer.skill_pick"]);
    const run = async (): Promise<SkillPick> => pickWriterSkills({
      enabled,
      catalog: await catalogOf(input.projectId, input.hostId),
      hints: input.task.skills ?? [],
      task: pickTask(input.task),
      plan: input.plan,
      projectCwd: input.projectCwd,
      ask: askJev(input.hostId),
      kindCache,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run().then((result) => ({ result }), (cause: unknown) => ({ cause })),
      new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs); }),
    ]).finally(() => clearTimeout(timer));
    if ("timedOut" in outcome) {
      log(`Lane Pilot writer skill pick ${input.attemptId}: no answer in ${deadlineMs} ms; the writer gets its role skills only`);
      return noPick(enabled, "pick_timeout");
    }
    if ("cause" in outcome) {
      const reason = outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause);
      log(`Lane Pilot writer skill pick ${input.attemptId} not made (${reason}); the writer gets its role skills only`);
      return noPick(enabled, `pick_error:${reason}`);
    }
    const result = outcome.result;
    log(`Lane Pilot writer skill pick ${JSON.stringify({ attemptId: input.attemptId, enabled, catalog: result.catalog, kept: result.kept, unanswered: result.unanswered, picked: result.picked, projectFolder: result.projectFolder, hints: result.hints })}`);
    return { enabled, skills: result.skills, picked: result.picked, projectFolder: result.projectFolder, hints: result.hints, reason: null };
  }

  return { pick };
}
