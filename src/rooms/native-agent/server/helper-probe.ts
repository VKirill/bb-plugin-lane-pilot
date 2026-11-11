import { listThreadEventsPaged, waitThreadIdle } from "@lane-pilot/thread-observe";
import { getRun, listAttemptRowsForProject, loadPrototypeConfig } from "../../storage";
import { writerExecutionSelection, findModelIn } from "@lane-pilot/models";
import { fullAccessSpawn } from "../../platform/server";
import { confirmWriterStopped } from "../../runs/server";
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
/** The longest the documentary.role probe waits for the thread's plugin metadata. */
const METADATA_READ_MS = 5_000;
type ProbeCheck = (args: ProbeCheckArgs) => Promise<{ ok: boolean; reason?: string }>;

/** The thread's own events as JSON text (newest 200): where a guard refusal shows, not on the model's word. */
async function threadEventsText(bb: BbPluginApi, threadId: string): Promise<string> {
  const listed = await listThreadEventsPaged(bb, { threadId, order: "desc", limit: "200" }).catch(() => [] as unknown[]);
  return JSON.stringify(Array.isArray(listed) ? listed : []);
}

/** What the session's tools were actually asked to do (newest 200 events): commands and tool arguments only — never the
 * prompt or the model's reply, which both repeat the probe's own words. */
export function toolCallsText(events: readonly unknown[]): string {
  return events.map((event) => (event as { data?: { item?: { type?: unknown; command?: unknown; arguments?: unknown; input?: unknown } } })?.data?.item)
    .filter((item) => item?.type === "commandExecution" || item?.type === "toolCall")
    .map((item) => `${String(item!.command ?? "")} ${JSON.stringify(item!.arguments ?? item!.input ?? "")}`).join("\n");
}

/** The events show a guard refusal: a deny/refuse verdict, ideally on the marker file the probe asked for. */
function guardRefused(eventsText: string, marker: string): boolean {
  return /denied|deny|refus|forbid|blocked|not allowed|permission/i.test(eventsText) && eventsText.includes(marker);
}

/**
 * The workspace as `git status --porcelain` sees it, asked of the machine it is on (the sandbox check of the probe:
 * the helper may write only its own `.lp-probe-*` files there). Null when the machine did not answer.
 */
export async function workspacePorcelain(bb: BbPluginApi, hostId: string, workspace: string): Promise<Set<string> | null> {
  const host = await Promise.resolve().then(() => bb.hosts.experimental_client({ contract: hostContract })).catch(() => null);
  if (!host) return null;
  const ran = await Promise.resolve().then(() => host.call("gateRun", { requestedHostId: hostId, basePath: workspace, command: "git status --porcelain", timeoutSec: 15 }, { hostId, timeoutMs: 30_000 })).catch(() => null);
  const text = (ran as { stdout?: unknown } | null)?.stdout;
  if (typeof text !== "string") return null;
  return new Set(text.split("\n").filter((line) => line.trim()).map((line) => line.replace(/^[ MADRCUT?!]{1,2} /, "").trim().replace(/^"|"$/g, "").split(" -> ").pop()!));
}

/** The paths that appeared in the workspace during the probe, minus the probe's own marker files. */
export function probeForeignWrites(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((path) => !before.has(path) && !/(^|\/)\.lp-probe-/.test(path));
}

/** How long the pause drill waits for the helper to pick the long command up before it stops the thread. */
export const PAUSE_PROBE_ACTIVE_MS = 60_000;

/** The thread reports itself active or running (status or the running list), asked for up to `waitMs`. */
export async function waitThreadActive(bb: BbPluginApi, threadId: string, waitMs = PAUSE_PROBE_ACTIVE_MS): Promise<boolean> {
  const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const observed = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const status = stringAt(observed, "status");
    const running = listRunning ? await listRunning({}).catch(() => [] as Array<{ id: string }>) : [];
    if (status === "active" || status === "running" || running.some((thread) => thread.id === threadId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * The pause drill's proof (SMA «Claude pause drill», the same for every provider): the thread is stopped in the middle
 * of its long command — no wait for a turn boundary —, the exit is confirmed (neither active nor listed running), then a
 * follow-up on the same thread id must answer RESUMED. Each failed step names itself in the reason.
 */
export async function pauseProbeCheck(bb: BbPluginApi, threadId: string, waitMs = WAIT_MS): Promise<{ ok: boolean; reason?: string }> {
  await bb.sdk.threads.stop({ threadId });
  const confirm = await confirmWriterStopped(bb as never, threadId, { waitMs, pollMs: 500 });
  if (!confirm.stopped) return { ok: false, reason: `pause:stop: the thread is still running ${confirm.waitedMs}ms after threads.stop (status ${confirm.status ?? "unknown"})` };
  await bb.sdk.threads.send({ threadId, input: [{ type: "text", mentions: [], text: "Reply with the single word RESUMED. Nothing else." }] } as never);
  await waitThreadIdle(bb, threadId, "helper_probe_timeout", waitMs);
  const output = (await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }))).output;
  return typeof output === "string" && /RESUMED/.test(output) ? { ok: true } : { ok: false, reason: "pause:resume: the same thread never answered RESUMED after the stop" };
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
/** A provider whose usage event carries a breakdown owes all four numbers (SMA m_tl_codex_lane): the missing one is named. */
export function accountingPartsProblem(parts: { input?: unknown; output?: unknown; cached?: unknown; total?: unknown } | undefined): string | null {
  if (!parts) return null;
  for (const key of ["input", "output", "cached", "total"] as const) {
    if (typeof parts[key] !== "number" || !Number.isFinite(parts[key])) return `accounting: the usage event is missing a numeric ${key} count`;
  }
  return null;
}

export const PROBES = {
  answers: { prompt: PROMPT, expect: /\S/ },
  "documentary.nested": {
    prompt: "Lane Pilot documentary probe. Run the read-only command `bb lane-pilot status` through your bb shim, quote the first line of its answer, then end with the word NESTED. Do not create, change or delete any file.",
    expect: /NESTED/,
    // The cell is proved by the session's trace, not by the model's word: the events must show the tool call itself.
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      const listed = await listThreadEventsPaged(bb, { threadId, order: "desc", limit: "200" }).catch(() => [] as unknown[]);
      return toolCallsText(Array.isArray(listed) ? listed : []).includes("lane-pilot status") ? { ok: true } : { ok: false, reason: "documentary.nested: the answer claims NESTED but the thread's events show no `bb lane-pilot status` tool call" };
    },
  },
  "documentary.role": {
    prompt: "Lane Pilot documentary probe. Reply with the single word ROLE and do nothing else: no tools, no files.",
    // A session is never told the name of its role: no brief carries it, the role acts through the session policy and the guard,
    // and both key on the thread's spawn metadata. So the proof is that metadata, read back from BB. Until 0.1.521 the probe asked
    // the model to recite the name; every provider answered «no role was given» and the cell was red on all of them
    // (live hub, 2026-11-11: claude-code, codex, acp-antigravity), which the documentary gate then held every stage on.
    expect: /ROLE/,
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      // Only a read that succeeds and shows another role says the cell is not supported. A missing method, a throw, a timeout or a
      // shape without a role is the probe's own setup failing (probeSetupFailed): unproven, never a red receipt.
      const unreadable = (why: string) => ({ ok: false, reason: `helper_probe_metadata_unreadable: documentary.role could not read the thread's spawn metadata (${why})` });
      const read = (bb.sdk?.threads as { getPluginMetadata?: (query: { threadId: string }) => unknown } | undefined)?.getPluginMetadata;
      if (typeof read !== "function") return unreadable("no getPluginMetadata on this host");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let metadata: unknown;
      try {
        metadata = await Promise.race([
          Promise.resolve().then(() => read.call(bb.sdk.threads, { threadId })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), METADATA_READ_MS); }),
        ]);
      } catch (cause) {
        return unreadable((cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 120));
      } finally { clearTimeout(timer); }
      const role = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).role : undefined;
      if (typeof role !== "string" || !role) return unreadable("the answer carries no role");
      return role === "pm-reader" ? { ok: true } : { ok: false, reason: `documentary.role: the thread's spawn metadata does not carry the pm-reader role (role=${role})` };
    },
  },
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
  pause: { prompt: "Lane Pilot pause probe. Run the shell command `sleep 600`. Do not create or change any file.", expect: /RESUMED/ },
  accounting: {
    prompt: "Lane Pilot accounting probe. Reply with the single word COUNTED and do nothing else: no tools, no files.",
    expect: /COUNTED/,
    check: async ({ bb, threadId }: ProbeCheckArgs) => {
      const usage = await threadUsage(bb, threadId);
      if (!usage.known || usage.tokens <= 0) return { ok: false, reason: `accounting: the turn's spend is not on the books (known=${usage.known}, tokens=${usage.tokens})` };
      const parts = accountingPartsProblem(usage.parts);
      return parts ? { ok: false, reason: parts } : { ok: true };
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
      // The sandbox check (SMA «Codex probe sandbox»): the workspace as it was, so anything the probe wrote that is not
      // its own `.lp-probe-*` marker shows up afterwards.
      const porcelainBefore = await workspacePorcelain(bb, config.hostId, config.writerWorkspacePath);
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
      if (kind === "pause") {
        // The pause drill: the helper runs `sleep 600`; we stop it mid-command, confirm the exit, resume the same thread.
        if (!(await waitThreadActive(bb, threadId))) return result({ reason: "helper_probe_pause_not_supported: the thread never picked the command up" });
        const pause = await pauseProbeCheck(bb, threadId);
        if (!pause.ok) return result({ answered: true, reason: `helper_probe_pause_check_failed: ${pause.reason}` });
        return result({ ok: true, answered: true, output: "RESUMED" });
      }
      await waitThreadIdle(bb, threadId, "helper_probe_timeout", WAIT_MS);
      const output = (await bb.sdk.threads.output({ threadId })).output;
      if (typeof output !== "string" || !output.trim()) throw new Error("helper_probe_output_empty");
      if (!PROBES[kind].expect.test(output)) return result({ answered: true, output: output.trim().slice(0, 200), reason: `helper_probe_${kind}_unexpected: the answer lacks what the ${kind} probe asks for` });
      const check = "check" in PROBES[kind] ? (PROBES[kind] as { check?: ProbeCheck }).check : undefined;
      if (check) {
        const verdict = await check({ bb, threadId, hostId: config.hostId, workspace: config.writerWorkspacePath, output });
        if (!verdict.ok) return result({ answered: true, output: output.trim().slice(0, 200), reason: verdict.reason ?? `helper_probe_${kind}_check_failed` });
      }
      // The sandbox check: anything the probe wrote outside its own marker files fails the probe with the paths named.
      // Only when nothing else works in this project: with a writer running, a new path cannot be laid on the probe.
      if (porcelainBefore !== null && !listAttemptRowsForProject(db, { projectId, states: ["running"], limit: 1 }).length) {
        const porcelainAfter = await workspacePorcelain(bb, config.hostId, config.writerWorkspacePath);
        const foreign = porcelainAfter === null ? [] : probeForeignWrites(porcelainBefore, porcelainAfter);
        if (foreign.length) return result({ answered: true, output: output.trim().slice(0, 200), reason: `helper_probe_wrote:${foreign.join(",")}` });
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
