import { runOnHost } from "@lane-pilot/host-calls";
import { PROVIDER_CAPABILITIES } from "@lane-pilot/models";
import { LANE_PILOT_SURFACE } from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import { ensureExcludeLinesCommand, EXCLUDE_NOT_GIT } from "../../verification";
import { getBenchProject } from "../../bench";
import { attemptHarnessTreeId, countHarnessArmAttempts, latestAttemptIdForThread } from "../../storage";
import { shellQuote, writeFileCommands } from "./evidence";
import { ANY_WRITER, activeHarness, assignAttemptHarness, getHarness, listHarnesses, trialHarness } from "./store";
import { HARNESS_DIR, briefParts, checkCommands, hooksSettings, type BriefParts } from "./parts";
import type { HarnessConfig } from "./config";

const EXCLUDE_LINES = [".lane-pilot/", ".opencode/skills/", ".claude/skills/"];

/** The tree an attempt runs under (its arm when a trial is open), what it writes into the worktree, the checks it adds. */
export function createAttemptTrees(ctx: ServerCore, deps: { config: (projectId: string) => Promise<HarnessConfig> }) {
  const { db, host } = ctx;
  const { config } = deps;

  /**
   * The tree an attempt runs under. With a trial open for the key the arms alternate by the order attempts are assigned,
   * so both arms see the same stream of tasks; without one the active tree (adopted or base) is recorded with no arm.
   */
  async function forAttempt(input: { projectId: string; area: string | null | undefined; writerKey: string; attemptId: string }): Promise<BriefParts | null> {
    // A bench sandbox project runs under the tree its arm names (none, the source project's active tree, or one tree id), never under live alternation.
    const bench = getBenchProject(db, input.projectId);
    if (bench) return forBenchAttempt(bench, input);
    const cfg = await config(input.projectId);
    if (!cfg.enabled) return null;
    const area = (input.area ?? "").trim();
    const keys = [input.writerKey, ANY_WRITER];
    for (const writerKey of keys) {
      const trial = trialHarness(db, input.projectId, area, writerKey);
      if (trial) {
        const active = activeHarness(db, input.projectId, area, writerKey);
        const assigned = countHarnessArmAttempts(db, trial.trialStartedAt ?? 0, [trial.id, active.id]);
        const arm: "new" | "old" = assigned % 2 === 0 ? "new" : "old";
        const chosen = arm === "new" ? trial : active;
        assignAttemptHarness(db, input.attemptId, chosen.id, arm);
        return briefParts(chosen, arm);
      }
    }
    const own = listHarnesses(db, input.projectId, { area, writerKey: input.writerKey, states: ["adopted"] })[0];
    const any = own ? null : listHarnesses(db, input.projectId, { area, writerKey: ANY_WRITER, states: ["adopted"] })[0];
    const active = own ?? any ?? activeHarness(db, input.projectId, area, input.writerKey);
    assignAttemptHarness(db, input.attemptId, active.id, null);
    return briefParts(active, null);
  }

  /** The tree a bench arm names: `none` gives the writer no tree, `tree` the source project's adopted or base tree for the task's area, anything else is a tree id. */
  function forBenchAttempt(bench: NonNullable<ReturnType<typeof getBenchProject>>, input: { projectId: string; area: string | null | undefined; writerKey: string; attemptId: string }): BriefParts | null {
    if (bench.harness === "none") return null;
    // The bench gives every task an area of its own (`<area>~b<position><arm>r<n>`); the tree belongs to the original area.
    const area = (input.area ?? "").trim().replace(/~b\d+[a-z0-9-]*r\d+$/, "");
    if (bench.harness === "tree") {
      const sourceId = bench.sourceProjectId ?? input.projectId;
      const own = listHarnesses(db, sourceId, { area, writerKey: input.writerKey, states: ["adopted"] })[0];
      const any = own ? null : listHarnesses(db, sourceId, { area, writerKey: ANY_WRITER, states: ["adopted"] })[0];
      const chosen = own ?? any ?? activeHarness(db, sourceId, area, input.writerKey);
      assignAttemptHarness(db, input.attemptId, chosen.id, null);
      return briefParts(chosen, null);
    }
    const tree = getHarness(db, bench.harness);
    if (!tree) return null;
    assignAttemptHarness(db, input.attemptId, tree.id, null);
    return briefParts(tree, null);
  }

  /** Writes a tree's skills and checks into the worktree (git-excluded) and links the skills where the writer's runtime looks. */
  async function materialize(input: { attemptId: string; hostId: string; workspacePath: string; live: boolean; providerId?: string; parts: BriefParts }): Promise<{ written: string[]; reason: string | null }> {
    const { tree } = input.parts;
    const files = Object.fromEntries(Object.entries(tree).filter(([rel]) => rel.startsWith(`${LANE_PILOT_SURFACE.skillDir}/`) || rel.startsWith(`${LANE_PILOT_SURFACE.checksDir}/`)));
    if (Object.keys(files).length === 0 && !(LANE_PILOT_SURFACE.hooksFile in tree)) return { written: [], reason: null };
    if (input.live) return { written: [], reason: "live_folder" };
    const excluded = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: ensureExcludeLinesCommand(EXCLUDE_LINES), timeoutSec: 30 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId }));
    if (excluded.exitCode !== 0 || excluded.stdout.includes(EXCLUDE_NOT_GIT)) return { written: [], reason: excluded.exitCode !== 0 ? "exclude_failed" : "not_git" };
    for (const command of writeFileCommands(HARNESS_DIR, files)) {
      const wrote = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command, timeoutSec: 60 })
        .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId }));
      if (wrote.exitCode !== 0 || !wrote.stdout.includes("@@WRITTEN")) {
        ctx.log(`harness ${input.attemptId}: tree not materialized: ${wrote.stderr.trim() || `exit ${wrote.exitCode}`}`);
        return { written: [], reason: "write_failed" };
      }
    }
    const links = input.parts.skillNames.flatMap((name) => [".opencode/skills", ".claude/skills"].map((dir) =>
      `mkdir -p ${shellQuote(dir)} && ln -sfn ${shellQuote(`../../${HARNESS_DIR}/skills/${name}`)} ${shellQuote(`${dir}/${name}`)}`));
    const chmod = input.parts.checkNames.map((rel) => `chmod +x ${shellQuote(`${HARNESS_DIR}/${rel}`)}`);
    // hooks.json fires only where the writer's runtime reads Claude Code hooks: a Claude Code writer gets it as the
    // worktree's .claude/settings.local.json (git-excluded); other runtimes ignore the file, as the surface table says.
    const hooks = tree[LANE_PILOT_SURFACE.hooksFile];
    const hookLines = hooks && PROVIDER_CAPABILITIES[input.providerId ?? ""]?.supportsHookSettings ? [`mkdir -p .claude && printf '%s' ${shellQuote(hooksSettings(hooks))} > .claude/settings.local.json`] : [];
    if (links.length || chmod.length || hookLines.length) await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: [...links, ...chmod, ...hookLines, "true"].join("\n"), timeoutSec: 30 }).catch(() => undefined);
    return { written: [...Object.keys(files), ...(hookLines.length ? [LANE_PILOT_SURFACE.hooksFile] : [])], reason: null };
  }

  /** The checks the attempt's tree adds to its verification; empty for an attempt without a tree or with a live folder. */
  function checksForAttempt(attemptId: string): Array<{ command: string; timeout_sec: number }> {
    const treeId = attemptHarnessTreeId(db, attemptId);
    if (!treeId) return [];
    const row = getHarness(db, treeId);
    return row ? checkCommands(row.tree) : [];
  }

  function checksForWriterThread(runId: string, taskId: string, writerThreadId: string): Array<{ command: string; timeout_sec: number }> {
    const attemptId = latestAttemptIdForThread(db, runId, taskId, writerThreadId);
    return attemptId ? checksForAttempt(attemptId) : [];
  }

  return { forAttempt, materialize, checksForAttempt, checksForWriterThread };
}
