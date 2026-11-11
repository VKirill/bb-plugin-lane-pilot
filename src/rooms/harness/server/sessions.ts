import { runOnHost } from "@lane-pilot/host-calls";
import { writerExecutionSelection } from "@lane-pilot/models";
import { stringAt } from "@lane-pilot/kit";
import { LANE_PILOT_SURFACE, type Tree } from "@lane-pilot/harness-core";
import { fullAccessSpawn } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { projectRoleField } from "../../runs/server";
import { HELPER_ROLES, type HelperRole } from "../../contracts/helper-context";
import { latestAreaWriterBinding } from "../../storage";
import { harvestCommand, parseHarvest, shellQuote, writeFileCommands } from "./evidence";
import { runStage, type StageResult, type StageSession } from "./stage";
import { roleSelection, type HarnessConfig, type HarnessRole } from "./config";
import { HARNESS_TUNING, type HarnessStep, type Services } from "./contract";

/** Where a round works (`place`), how its files get there (`writeFiles`), and the helper sessions of a stage. */
export function createSessions(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;

  /**
   * Where the editor works: the folder the key's writers ran in (the newest run's host and workspace), so the evidence and
   * the sessions sit next to the repository they describe. The project binding is the fallback; a binding without a
   * folder (the global override) is no place at all, and a folder that is gone from the host is refused before anything
   * is written there (the first live run failed on `spawn /bin/bash ENOENT`: a missing cwd, 2026-10-18).
   */
  async function place(projectId: string, area = ""): Promise<{ hostId: string; path: string } | null> {
    const candidates: Array<{ hostId: string | null; path: string | null }> = [
      latestAreaWriterBinding(db, projectId, area) ?? { hostId: null, path: null },
      // No «the project's newest run of any area»: it put the night editor of office-studio-prototype into the magicseo replay's live
      // checkout (2026-10-31: `.lane-pilot/harness-edit/feature_office-studio-prototype__project/…` failed the replay's designer). Work of
      // one key stays in that key's folder; the project binding is the only fallback.
    ];
    const resolved = await services.resolveProjectWriterHost({ projectId }).catch(() => null);
    if (resolved && resolved.status === "resolved" && resolved.hostId && resolved.path) candidates.push({ hostId: resolved.hostId, path: resolved.path });
    for (const candidate of candidates) {
      if (!candidate.hostId || !candidate.path) continue;
      const exists = await runOnHost(host, { hostId: candidate.hostId, cwd: "/", command: `test -d ${shellQuote(candidate.path)} && echo @@DIR`, timeoutSec: 15 }).catch(() => null);
      if (exists?.stdout.includes("@@DIR")) return { hostId: candidate.hostId, path: candidate.path };
    }
    return null;
  }

  /** Writes files in commands under the host shell's argument limit (`writeFileCommands`): trajectories are long. */
  async function writeFiles(where: { hostId: string; path: string }, dir: string, files: Record<string, string>): Promise<void> {
    for (const command of writeFileCommands(dir, files)) {
      const ran = await runOnHost(host, { hostId: where.hostId, cwd: where.path, command, timeoutSec: 120 });
      if (ran.exitCode !== 0 || !ran.stdout.includes("@@WRITTEN")) throw new Error(`could not write the evidence under ${dir}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`);
    }
  }

  type Session = StageSession;

  /** A step of a graph run that starts helper threads: its context, the helper runner (workflow/server's, passed in), and the runs it made (for the usage the step reports). */
  type GraphStep = HarnessStep;
  const stopped = (step: GraphStep): boolean => ctx.isDisposed() || step.c.signal.aborted;

  /**
   * One agentic session over a folder, as a helper of the graph step that asked: spawn (a journal effect named by `key`), wait until idle, read the
   * reply and harvest `context/harness/`. A session that fails gives `error` (the stage loop decides what to do), unless the plugin is going away.
   */
  async function session(input: { projectId: string; where: { hostId: string; path: string }; folder: string; title: string; mission: string; role: string; cfg: HarnessConfig; harvest: boolean; model?: HarnessRole; step: GraphStep; key: string }): Promise<Session> {
    const selection = roleSelection(input.cfg, input.model ?? "inv");
    const cwd = `${input.where.path}/${input.folder}`;
    let threadId: string | null = null;
    try {
      // A finished session is a record, not a conversation: it leaves the project's thread list (the owner saw a dozen
      // «Lane Pilot harness editor …» rows on 2026-10-19). The notes, the tree and the decision are stored on the hub.
      const run = await input.step.helper({
        key: input.key, label: "harness_session_timeout", waitMs: input.cfg.waitMinutes * 60_000, projectId: input.projectId, archive: true,
        spawn: async (graph) => {
          const spawned = await fullAccessSpawn(bb, {
            projectId: input.projectId,
            ...projectRoleField(bb, db, input.projectId, selection.providerId, (HELPER_ROLES as readonly string[]).includes(input.role) ? input.role as HelperRole : "harness-editor"),
            environment: { type: "host", hostId: input.where.hostId, workspace: { type: "unmanaged", path: cwd } },
            title: input.title, prompt: input.mission,
            ...writerExecutionSelection(selection.providerId, selection.model, selection.reasoningLevel, "default"),
            pluginMetadata: { role: input.role, lanePilotProjectId: input.projectId, harnessFolder: input.folder, model: `${selection.providerId}/${selection.model}`, ...graph.metadata, spawnId: graph.spawnId },
          } as Parameters<typeof fullAccessSpawn>[1]);
          const id = stringAt(spawned, "id");
          if (!id) throw new Error("spawn returned no thread id");
          threadId = id;
          return id;
        },
      });
      threadId = run.threadId;
      input.step.runs.push(run);
      let tree: Tree | null = null;
      if (input.harvest) {
        const harvested = await runOnHost(host, { hostId: input.where.hostId, cwd, command: harvestCommand(), timeoutSec: 60 });
        tree = parseHarvest(harvested.stdout);
      }
      return { threadId, text: run.text, tree, error: null };
    } catch (cause) {
      if (stopped(input.step)) throw cause;
      return { threadId, text: "", tree: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** A stage with its one retry on a rejected tree and one on a session that ended early (`runStage`); each session of it is a helper named `<label>:<n>`. */
  async function stage(input: Omit<Parameters<typeof session>[0], "harvest" | "key"> & { fallback: Tree; label: string; surface?: typeof LANE_PILOT_SURFACE }): Promise<StageResult> {
    let sessions = 0;
    const { surface, fallback, label, ...rest } = input;
    return runStage({ mission: input.mission, fallback, title: input.title, surface },
      (mission) => session({ ...rest, mission, harvest: true, key: `${label}:${++sessions}` }), (line) => ctx.log(line), HARNESS_TUNING.retryDelayMs);
  }

  return { place, writeFiles, session, stage };
}
