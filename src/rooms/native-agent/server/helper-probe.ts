import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { getRun, loadPrototypeConfig } from "../../storage";
import { writerExecutionSelection, findModelIn } from "@lane-pilot/models";
import { fullAccessSpawn } from "../../core/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server/run-routing";
import { stringAt } from "../../core/server";
import type { ServerCore } from "../../core/server";

/**
 * One helper on one provider, started the way the pm-read stage starts its helper (same placement, session policy, execution
 * selection and plugin metadata, so the `contributeEnv` hooks and the provider's own start-up run exactly as for a real helper)
 * with a prompt that asks for one word. The drill starts one per provider in use and asserts each started and answered
 * (audit 2026-10-08 round 3, P0-7: 0.1.194 broke every OpenCode helper for about six minutes and the drill, which only ran
 * Codex writers, stayed green).
 */
export type HelperProbeResult = {
  ok: boolean; providerId: string; model: string; started: boolean; answered: boolean;
  threadId: string | null; output: string | null; reason: string | null; ms: number;
};

const PROMPT = "Lane Pilot helper probe. Reply with the single word OK and do nothing else: no tools, no files.";
const WAIT_MS = 150_000;

/**
 * The probes of a capability (src/rooms/capability): answers — one word; documentary — a read-only helper reads the workspace and reports
 * without writing (SMA: Documentary role cells, Claude documentary drill); pause — a helper waits in a long command and goes on in the same
 * turn (SMA: Pause drill on the stand, Claude/Codex pause drill). Each names what its answer must hold.
 */
export const PROBES = {
  answers: { prompt: PROMPT, expect: /\S/ },
  documentary: { prompt: "Lane Pilot documentary probe. Read only: list the names of the top-level entries of the workspace folder, comma-separated, then end with the word LISTED. Do not create, change or delete any file.", expect: /LISTED/ },
  pause: { prompt: "Lane Pilot pause probe. Run the shell command `sleep 40`; when it has finished, reply with the single word RESUMED. Do not create or change any file.", expect: /RESUMED/ },
} as const;
export type ProbeKind = keyof typeof PROBES;

export function createHelperProbe(ctx: Pick<ServerCore, "bb" | "db">) {
  const { bb, db } = ctx;

  async function startHelperProbe(projectId: string, runId: string, providerId: string, modelId: string, kind: ProbeKind = "answers"): Promise<HelperProbeResult> {
    const began = Date.now();
    let threadId: string | null = null;
    let started = false;
    const result = (patch: Partial<HelperProbeResult>): HelperProbeResult => ({
      ok: false, providerId, model: modelId, started, answered: false, threadId, output: null, reason: null, ms: Date.now() - began, ...patch,
    });
    try {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error(`helper_probe_project_not_configured:${projectId}`);
      const run = getRun(db, runId);
      if (!run || run.project_id !== projectId || !run.pm_thread_id) throw new Error(`helper_probe_run_unusable:${runId}`);
      const [providers, catalog] = await Promise.all([
        bb.sdk.providers.list({ hostId: config.hostId }),
        bb.sdk.providers.models({ providerId, hostId: config.hostId }),
      ]);
      if (!providers.some((row) => row.id === providerId && row.available)) throw new Error(`helper_probe_provider_unavailable:${providerId}`);
      const model = findModelIn(catalog.models, modelId);
      if (!model) throw new Error(`helper_probe_model_unavailable:${providerId}/${modelId}`);
      const efforts = model.supportedReasoningEfforts.map((row) => row.reasoningEffort);
      const effort = efforts.includes("low") ? "low" : efforts.includes("medium") ? "medium" : efforts[0] ?? "none";
      const helperPolicy = requireHelperSpawn({ bb, db, projectId, runId });
      const placement = await helperChildPlacement({ bb, db, projectId, runId, role: "pm-reader", taskTitle: "helper probe" });
      const spawned = await fullAccessSpawn(bb, {
        ...placement,
        ...requiredPolicyField(bb, helperPolicy, providerId, "pm-reader"),
        ...writerExecutionSelection(providerId, modelId, effort, "default"),
        prompt: PROBES[kind].prompt,
        environment: { type: "host", hostId: config.hostId, workspace: { type: "unmanaged", path: config.writerWorkspacePath } },
        pluginMetadata: { role: "pm-reader", lanePilotRunId: runId, lanePilotTaskId: `helper-probe-${kind}-${providerId}`, stageId: "pm-read", parentPmThreadId: run.pm_thread_id, helperMode: helperPolicy.mode, helperRequired: helperPolicy.policy?.required === true, helperProbe: true },
      });
      threadId = stringAt(spawned, "id");
      if (!threadId) throw new Error("helper_probe_thread_id_missing");
      started = true;
      await waitThreadIdle(bb, threadId, "helper_probe_timeout", WAIT_MS);
      const output = (await bb.sdk.threads.output({ threadId })).output;
      if (typeof output !== "string" || !output.trim()) throw new Error("helper_probe_output_empty");
      if (!PROBES[kind].expect.test(output)) return result({ answered: true, output: output.trim().slice(0, 200), reason: `helper_probe_${kind}_unexpected: the answer lacks what the ${kind} probe asks for` });
      return result({ ok: true, answered: true, output: output.trim().slice(0, 200) });
    } catch (cause) {
      return result({ reason: (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 300) });
    } finally {
      if (threadId) {
        const id = threadId;
        await bb.sdk.threads.stop({ threadId: id }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: id }).catch(() => undefined);
      }
    }
  }

  return { startHelperProbe };
}
