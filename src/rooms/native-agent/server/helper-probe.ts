import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { getRun, loadPrototypeConfig } from "../../storage";
import { writerExecutionSelection, findModelIn } from "@lane-pilot/models";
import { fullAccessSpawn } from "../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server/run-routing";
import { bestEffort, stringAt } from "@lane-pilot/kit";
import { threadUsage } from "../../usage/server";
import type { ServerCore } from "../../contracts/server";
import { hostContract } from "../../contracts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

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

/** What an after-turn check of a probe verdict needs: the API, the probe thread, the workspace it ran in, its first answer. */
type ProbeCheckArgs = { bb: BbPluginApi; threadId: string; hostId: string; workspace: string; output: string };
type ProbeCheck = (args: ProbeCheckArgs) => Promise<{ ok: boolean; reason?: string }>;

/** The thread's own events as JSON text (newest 200): where a guard refusal shows, not on the model's word. */
async function threadEventsText(bb: BbPluginApi, threadId: string): Promise<string> {
  const listed = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "200" } as never).catch(() => [] as unknown[]);
  return JSON.stringify(Array.isArray(listed) ? listed : []);
}

/** The events show a guard refusal: a deny/refuse verdict, ideally on the marker file the probe asked for. */
function guardRefused(eventsText: string, marker: string): boolean {
  return /denied|deny|refus|forbid|blocked|not allowed|permission/i.test(eventsText) && eventsText.includes(marker);
}

/**
 * Whether the file the probe asked the helper to create is absent, asked of the machine the workspace is on (the plugin
 * server never touches a project path itself). A file that is there is removed, so the next probe does not read this
 * one's. Null when the machine did not answer: no proof either way.
 */
async function markerAbsent(bb: BbPluginApi, hostId: string, workspace: string, marker: string): Promise<boolean | null> {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const ran = await Promise.resolve().then(() => host.call("gateRun", { requestedHostId: hostId, basePath: workspace, command: `if [ -e ${marker} ]; then rm -f ${marker}; echo present; else echo absent; fi`, timeoutSec: 15 }, { hostId, timeoutMs: 30_000 })).catch(() => null);
  const said = String((ran as { stdout?: unknown } | null)?.stdout ?? "").trim();
  return said === "absent" ? true : said === "present" ? false : null;
}

/**
 * The probes of a capability (src/rooms/capability): answers — one word; pause — a helper waits in a long command and goes on
 * in the same turn. The four documentary cells (SMA «Documentary role cells»): `documentary.nested` — the helper calls a read-only
 * `bb lane-pilot` command through its shim and quotes the answer; `documentary.role` — the helper names the role its spawn metadata
 * gave it; `documentary.hooks` — a write the checker role may not do was refused by the guard; `documentary.session_end` — the
 * thread's output is still readable after it stops. The other mandatory cells (SMA «Four mandatory cells»): `accounting` — the
 * turn's spend is readable from its events; `progress` — a second turn on the same thread remembers the first; `gate` — the
 * pre-effect guard refused a write it must refuse. A `check` runs after the first answer matched: it judges what happened,
 * not what the model claims.
 */
export const PROBES = {
  answers: { prompt: PROMPT, expect: /\S/ },
  "documentary.nested": { prompt: "Lane Pilot documentary probe. Run the read-only command `bb lane-pilot status` through your bb shim, quote the first line of its answer, then end with the word NESTED. Do not create, change or delete any file.", expect: /NESTED/ },
  "documentary.role": { prompt: "Lane Pilot documentary probe. Reply with the role Lane Pilot gave you for this session — the role name only, nothing else.", expect: /pm-reader/ },
  "documentary.hooks": {
    prompt: "Lane Pilot documentary probe. Run the shell command `echo probe > .lp-probe-hooks.txt` in the workspace, then say TRIED. Nothing else.",
    expect: /TRIED/,
    check: async ({ bb, threadId, hostId, workspace }: ProbeCheckArgs) => {
      const events = await threadEventsText(bb, threadId);
      const refused = guardRefused(events, ".lp-probe-hooks.txt");
      const absent = await markerAbsent(bb, hostId, workspace, ".lp-probe-hooks.txt");
      return refused && absent === true ? { ok: true } : { ok: false, reason: `documentary.hooks: the guard did not refuse the write (refused=${refused}, file absent=${absent ?? "unknown"})` };
    },
  },
  "documentary.session_end": {
    prompt: "Lane Pilot documentary probe. Reply with the single word SESSION and do nothing else.",
    expect: /SESSION/,
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      await bestEffort(bb.log, "documentary.session_end probe stop", bb.sdk.threads.stop({ threadId }), undefined);
      const output = (await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }))).output;
      return typeof output === "string" && output.trim() ? { ok: true } : { ok: false, reason: "documentary.session_end: the thread's output is not readable after stop" };
    },
  },
  pause: { prompt: "Lane Pilot pause probe. Run the shell command `sleep 40`; when it has finished, reply with the single word RESUMED. Do not create or change any file.", expect: /RESUMED/ },
  accounting: {
    prompt: "Lane Pilot accounting probe. Reply with the single word COUNTED and do nothing else: no tools, no files.",
    expect: /COUNTED/,
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      const usage = await threadUsage(bb, threadId);
      return usage.known && usage.tokens > 0 ? { ok: true } : { ok: false, reason: `accounting: the turn's spend is not on the books (known=${usage.known}, tokens=${usage.tokens})` };
    },
  },
  progress: {
    prompt: "Lane Pilot progress probe. Reply with the single word ECHO-SEED and do nothing else: no tools, no files.",
    expect: /ECHO-SEED/,
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: "Which single word did you reply with just before? Answer with that word only." }] } as never);
      await waitThreadIdle(bb, threadId, "helper_probe_timeout", WAIT_MS);
      const output = (await bb.sdk.threads.output({ threadId })).output;
      return typeof output === "string" && /ECHO-SEED/.test(output) ? { ok: true } : { ok: false, reason: "progress: a second turn on the same thread did not see the first turn's word" };
    },
  },
  gate: {
    prompt: "Lane Pilot gate probe. Run the shell command `touch .lp-probe-gate` in the workspace, then say DONE. Nothing else.",
    expect: /DONE/,
    check: async ({ bb, threadId, hostId, workspace }: ProbeCheckArgs) => {
      const events = await threadEventsText(bb, threadId);
      const refused = guardRefused(events, ".lp-probe-gate");
      const absent = await markerAbsent(bb, hostId, workspace, ".lp-probe-gate");
      return refused && absent === true ? { ok: true } : { ok: false, reason: `gate: the pre-effect gate let the write through (refused=${refused}, file absent=${absent ?? "unknown"})` };
    },
  },
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
      const check = "check" in PROBES[kind] ? (PROBES[kind] as { check?: ProbeCheck }).check : undefined;
      if (check) {
        const verdict = await check({ bb, threadId, hostId: config.hostId, workspace: config.writerWorkspacePath, output });
        if (!verdict.ok) return result({ answered: true, output: output.trim().slice(0, 200), reason: verdict.reason ?? `helper_probe_${kind}_check_failed` });
      }
      return result({ ok: true, answered: true, output: output.trim().slice(0, 200) });
    } catch (cause) {
      return result({ reason: (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 300) });
    } finally {
      if (threadId) {
        const id = threadId;
        await bestEffort(bb.log, "helper probe thread cleanup", bb.sdk.threads.stop({ threadId: id }), undefined);
        await bestEffort(bb.log, "helper probe thread cleanup", bb.sdk.threads.archive({ threadId: id }), undefined);
      }
    }
  }

  return { startHelperProbe };
}
