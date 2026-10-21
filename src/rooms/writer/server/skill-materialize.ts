import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { ensureExcludeLinesCommand, EXCLUDE_NOT_GIT } from "../../verification";

/**
 * OpenCode v2 discovers a project skill at `<cwd>/.opencode/skills/<name>/SKILL.md`, and Lane Stack's opencode-lane guard lets an
 * OpenCode writer load only such skills. The Jev-picked skills are linked there before the writer starts, so OpenCode lists them
 * and the guard lets them through. The links are git-excluded, so the dirt snapshot, the ownership check and the merge never see them, and they are
 * removed when the attempt ends.
 */
export const OPENCODE_WRITER_PROVIDER = "opencode2";
export const OPENCODE_SKILLS_DIR = ".opencode/skills";
export const OPENCODE_SKILLS_EXCLUDE = "**/.opencode/skills/";
/**
 * OpenCode v2 compacts a session on its own unless the session's folder config turns it off (no agent or environment can: the
 * service is shared). Lane Pilot compacts its sticky writers itself, so an opencode2 writer's worktree gets this folder config;
 * a config the project already has is kept and left as it is. Git-excluded, removed at the attempt's end only while unchanged.
 */
export const OPENCODE_CONFIG_FILE = ".opencode/opencode.jsonc";
export const OPENCODE_CONFIG_EXCLUDE = "**/.opencode/opencode.jsonc";
export const COMPACTION_OFF_CONFIG = `// Lane Pilot: its writer is compacted by Lane Pilot, not by OpenCode. Removed when the attempt ends.\n{ "compaction": { "auto": false } }\n`;
const WRITTEN = "lp:config-written";
const LINKED = "lp:linked ";
const KEPT = "lp:kept ";
const MISSING = "lp:missing ";
/** The names go into a shell command, so only the shapes a skill name takes (the guard lowercases the name it looks up). */
const SAFE_NAME = /^[a-z0-9][a-z0-9._:-]{0,199}$/;

export type Materialized = { linked: string[]; kept: string[]; missing: string[]; reason: string | null };
export type MaterializeInput = {
  attemptId: string; hostId: string; workspacePath: string; live: boolean; providerId: string;
  /** The names the writer gets (the pick's skills); only those the sources map to a folder are linked. */
  skills: string[]; sources: Record<string, string>;
};

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * Links each skill folder as `.opencode/skills/<name>`. A real folder already at that path is kept, never replaced; a folder
 * without SKILL.md is reported missing. Prints one `lp:` line per skill, which parseMaterialized reads.
 */
export function materializeSkillsCommand(skills: Array<{ name: string; folder: string }>): string {
  const lines = skills.map(({ name, folder }) => {
    const link = `${OPENCODE_SKILLS_DIR}/${name}`;
    return `if [ ! -f ${quote(`${folder}/SKILL.md`)} ]; then echo ${quote(`${MISSING}${name}`)}
elif [ -e ${quote(link)} ] && [ ! -L ${quote(link)} ]; then echo ${quote(`${KEPT}${name}`)}
else ln -sfn ${quote(folder)} ${quote(link)} && echo ${quote(`${LINKED}${name}`)}; fi`;
  });
  return [`mkdir -p ${quote(OPENCODE_SKILLS_DIR)} || exit 1`, ...lines].join("\n");
}

/** Writes the compaction-off config unless the folder has an OpenCode config of its own; prints WRITTEN when it wrote one. */
export function compactionOffCommand(): string {
  return `if [ -e .opencode/opencode.jsonc ] || [ -e .opencode/opencode.json ]; then true; else mkdir -p .opencode && printf '%s' ${quote(COMPACTION_OFF_CONFIG)} > ${quote(OPENCODE_CONFIG_FILE)} && echo ${WRITTEN}; fi`;
}

/** Removes the links this attempt made and the compaction-off config while it is still Lane Pilot's, nothing else; the folders go only when they are empty. */
export function removeSkillsCommand(names: string[]): string {
  const lines = names.map((name) => `[ -L ${quote(`${OPENCODE_SKILLS_DIR}/${name}`)} ] && rm -f ${quote(`${OPENCODE_SKILLS_DIR}/${name}`)}`);
  const config = `printf '%s' ${quote(COMPACTION_OFF_CONFIG)} | cmp -s - ${quote(OPENCODE_CONFIG_FILE)} && rm -f ${quote(OPENCODE_CONFIG_FILE)}`;
  return [...lines, config, `rmdir ${quote(OPENCODE_SKILLS_DIR)} 2>/dev/null`, "rmdir .opencode 2>/dev/null", "true"].join("\n");
}

export function parseMaterialized(stdout: string): Omit<Materialized, "reason"> {
  const names = (prefix: string) => stdout.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
  return { linked: names(LINKED), kept: names(KEPT), missing: names(MISSING) };
}

/** A skill the writer's attempt got: the names the pick chose, the ones the guard needs, from the folder the BB list gives. */
export function materializableSkills(skills: string[], sources: Record<string, string>): { entries: Array<{ name: string; folder: string }>; skipped: string[] } {
  const entries: Array<{ name: string; folder: string }> = [];
  const skipped: string[] = [];
  for (const name of skills) {
    const folder = sources[name];
    const lower = name.toLowerCase();
    if (!folder || !SAFE_NAME.test(lower)) skipped.push(name);
    else entries.push({ name: lower, folder });
  }
  return { entries, skipped };
}

/** The skills an attempt's dispatch recorded as linked, for the removal at its end. */
export function recordedMaterializedSkills(dispatchContext: unknown): string[] {
  const linked = (dispatchContext as { skillPick?: { materialized?: unknown } } | null | undefined)?.skillPick?.materialized;
  return Array.isArray(linked) ? linked.filter((name): name is string => typeof name === "string") : [];
}

export function createSkillMaterializer(ctx: { host: RunCommandHost }, log: (message: string) => void) {
  const { host } = ctx;

  /** Turns OpenCode's own compaction off in an opencode2 writer's worktree; false when the folder keeps its own config or cannot take one. */
  async function compactionOff(input: { attemptId: string; hostId: string; workspacePath: string; live: boolean; providerId: string }): Promise<boolean> {
    if (input.providerId !== OPENCODE_WRITER_PROVIDER || input.live) return false;
    const failed = (cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId });
    const excluded = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: ensureExcludeLinesCommand([OPENCODE_CONFIG_EXCLUDE]), timeoutSec: 30 }).catch(failed);
    const ran = excluded.exitCode !== 0 || excluded.stdout.includes(EXCLUDE_NOT_GIT) ? null
      : await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: compactionOffCommand(), timeoutSec: 30 }).catch(failed);
    if (ran?.exitCode === 0 && ran.stdout.includes(WRITTEN)) return true;
    const why = excluded.exitCode !== 0 ? `could not git-exclude ${OPENCODE_CONFIG_FILE}: ${excluded.stderr.trim() || `exit ${excluded.exitCode}`}`
      : !ran ? "the workspace is not a git repository"
      : ran.exitCode !== 0 ? ran.stderr.trim() || `exit ${ran.exitCode}` : "the folder has an OpenCode config of its own";
    log(`Lane Pilot writer ${input.attemptId}: OpenCode's own compaction stays on (${why})`);
    return false;
  }

  /** Links the picked skills for an OpenCode writer. The exclude line goes first: without it the links would show as dirt. */
  async function materialize(input: MaterializeInput): Promise<Materialized> {
    if (input.providerId !== OPENCODE_WRITER_PROVIDER || input.skills.length === 0) return { linked: [], kept: [], missing: [], reason: null };
    const names = input.skills.join(", ");
    if (input.live) {
      log(`Lane Pilot writer ${input.attemptId}: skills not materialized (the folder is not a git worktree); the OpenCode guard will block ${names}`);
      return { linked: [], kept: [], missing: [], reason: "live_folder" };
    }
    const excluded = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: ensureExcludeLinesCommand([OPENCODE_SKILLS_EXCLUDE]), timeoutSec: 30 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId }));
    if (excluded.exitCode !== 0) {
      log(`Lane Pilot writer ${input.attemptId}: skills not materialized (could not git-exclude ${OPENCODE_SKILLS_DIR}: ${excluded.stderr.trim() || `exit ${excluded.exitCode}`})`);
      return { linked: [], kept: [], missing: [], reason: "exclude_failed" };
    }
    if (excluded.stdout.includes(EXCLUDE_NOT_GIT)) {
      log(`Lane Pilot writer ${input.attemptId}: skills not materialized (the workspace is not a git repository)`);
      return { linked: [], kept: [], missing: [], reason: "not_git" };
    }
    const { entries, skipped } = materializableSkills(input.skills, input.sources);
    if (skipped.length) log(`Lane Pilot writer ${input.attemptId}: skills without a folder or an allowed name, not materialized: ${skipped.join(", ")}`);
    if (entries.length === 0) return { linked: [], kept: [], missing: [], reason: "no_folders" };
    const ran = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: materializeSkillsCommand(entries), timeoutSec: 30 });
    const result = { ...parseMaterialized(ran.stdout), reason: ran.exitCode === 0 ? null : `exit ${ran.exitCode}` };
    log(`Lane Pilot writer skill materialize ${JSON.stringify({ attemptId: input.attemptId, workspacePath: input.workspacePath, ...result })}`);
    return result;
  }

  /** The end of the attempt: the links and the compaction config it made go; a failure is logged and the attempt's outcome stands. */
  async function remove(input: { attemptId: string; hostId: string; workspacePath: string | null; names: string[]; providerId?: string | null }): Promise<void> {
    if (!input.workspacePath || (input.names.length === 0 && input.providerId !== OPENCODE_WRITER_PROVIDER)) return;
    const failure = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: removeSkillsCommand(input.names), timeoutSec: 30 })
      .then((ran) => (ran.exitCode === 0 ? null : `exit ${ran.exitCode}: ${ran.stderr.trim()}`), (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    if (failure) log(`Lane Pilot writer ${input.attemptId}: could not remove the skill links from ${input.workspacePath}: ${failure}`);
  }

  return { materialize, compactionOff, remove };
}
