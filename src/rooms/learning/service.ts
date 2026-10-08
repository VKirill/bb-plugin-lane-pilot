import { z } from "zod";
import { anamnesisFor } from "../anamnesis/wiring";
import { TURN_REQUESTED, type EventLike, type OwnerMessage } from "../anamnesis/owner-messages";
import { getRunSettingsScopes } from "../storage/database";
import { jev } from "@lane-pilot/jev";
import { relayFor } from "../relay/server/relay";
import { scheduleIsolated } from "../../server/schedules";
import { memorySettingsFor } from "../self-repair/server/insights";
import { registerObservedTool } from "../../server/tool-result";
import type { ServerCore } from "../../server/core";
import type { Services } from "../../server/services";
import { DEFAULT_CONFIG, loadConfig, type LearningConfig } from "./config";
import { createDecisions } from "./decide";
import { createDigest } from "./digest";
import { createExtractor, type ExtractResult } from "./extract";
import { recordFrustration } from "./frustration";
import { memoryFill } from "./housekeeping";
import { envCatalogKey } from "./keys";
import { createLiveFeed } from "./live";
import { createObserver } from "./observe";
import { createOps, type Kv } from "./ops";
import { KEY_NAME, createDecisionsClient } from "./opinion";
import { pmRulesBlock, pmRulesOf, relevantPmRules } from "./pm-rules";
import { ruleBudget, setRuleBudgets } from "./rule-budget";
import { lpNotesPort, lpRulesPort } from "./rules-port";
import { complexityReport, noteOwnerQuestion, scanComplexity, scanPromises } from "./signals";
import { DAY_MS, projectsWithCandidates, purgeStaleBodies, startOfDay, type ItemKind, type ItemState } from "./store";

/**
 * The learning room, wired (src/learning). `createLearning` builds the pieces on the plugin's database and key-value store;
 * `mountLearning` connects them: the observer subscribes to the owner-message hub of the anamnesis room, the live feed listens to
 * BB's thread events, the PM gets its rules, the schedules run the extractor, the daily report and the signal scans, and the one
 * PM tool (an action of `lane_pilot_memory`) and the CLI `bb lane-pilot learning` reach the same operations.
 */
const EXTRACT_AFTER_MS = 10 * 60_000;
const EXTRACT_AT_COUNT = 5;

export const OPS = ["status", "review", "label", "items", "accept", "reject", "drop", "digest", "rules", "agreement", "signals", "config", "extract"] as const;
export type LearningOp = (typeof OPS)[number];

export function createLearning(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const kv = bb.storage.kv as unknown as Kv;
  let config: LearningConfig = DEFAULT_CONFIG;
  const refresh = async (): Promise<LearningConfig> => { config = await loadConfig(kv); setRuleBudgets({ pm: config.pmRulesTokens, writer: config.writerRulesTokens }); return config; };
  void refresh();

  const decisionsClient = createDecisionsClient({ apiKey: envCatalogKey(bb, KEY_NAME) });
  const rules = lpRulesPort(db), notes = lpNotesPort(db);
  const log = (line: string) => ctx.log(line);

  const pmThread = (projectId: string): string | null =>
    (db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(projectId) as { pm_thread_id: string } | undefined)?.pm_thread_id ?? null;

  /** The agent's last reply before an owner message: the nearest finished agent message under its sequence. */
  async function prevReply(message: OwnerMessage): Promise<string> {
    const seq = Number(message.id.split(":")[1]);
    if (!Number.isFinite(seq)) return "";
    const events = await bb.sdk.threads.events.list({ threadId: message.threadId, types: ["item/completed"], order: "desc", beforeSeq: String(seq), limit: "40" } as never) as unknown as EventLike[];
    for (const event of events) {
      const item = (event.data as { item?: { type?: string; text?: unknown } }).item;
      if ((item?.type === "agentMessage" || item?.type === "assistantMessage") && typeof item.text === "string" && item.text.trim()) return item.text.slice(-1_200);
    }
    return "";
  }

  const observer = createObserver({
    db, config: async () => config, jev, decisions: decisionsClient, prevReply, log,
    onFrustration: async ({ observation, message, quote, agentSaid }) => {
      const run = db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(message.threadId) as { id: string } | undefined;
      await recordFrustration(kv, { at: Date.now(), projectId: message.projectId, threadId: message.threadId, messageId: message.id, p: observation.frustration ?? 0, quote, agentSaid, pmThreadId: run ? message.threadId : null, runId: run?.id ?? null });
    },
  });

  const live = createLiveFeed({
    hub: anamnesisFor(ctx).ownerMessages, log,
    readEvents: async (threadId, limit) => await bb.sdk.threads.events.list({ threadId, types: [TURN_REQUESTED], order: "desc", limit: String(limit) } as never) as unknown as EventLike[],
  });

  /** The owner's global BB preferences, for comparing an owner-wide statement; empty where the memory plugin cannot be reached. */
  async function globalPreferences(): Promise<Array<{ id: string; text: string }>> {
    const callRpc = (bb.sdk as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown> } }).plugins?.callRpc;
    const answer = await callRpc?.({ pluginId: "memory", method: "listMemories", input: null,
      outputSchema: z.object({ memories: z.array(z.object({ name: z.string(), scope: z.string(), kind: z.string(), summary: z.string() }).passthrough()) }).passthrough() }) as { memories: Array<{ name: string; scope: string; kind: string; summary: string }> } | undefined;
    return (answer?.memories ?? []).filter((row) => row.scope === "global" && row.kind === "preference").map((row) => ({ id: row.name, text: row.summary }));
  }

  /** One run of the short model on a prompt: the project's rule analyzer (a hidden thread of the model the owner chose for rules). */
  async function runModel(prompt: string, projectId: string, label: string): Promise<string> {
    const place = await services.resolveProjectWriterHost({ projectId }).catch(() => null);
    if (!place || place.status !== "resolved" || !place.hostId) throw new Error("no_host");
    const analyzer = await services.ruleScan.analyzerFor(projectId);
    if (!analyzer) throw new Error("no_analyzer_model");
    return await services.ruleScan.runAnalyzer(projectId, `Learning from owner messages · ${label}`.slice(0, 160), prompt, { hostId: place.hostId, path: place.path }, analyzer, { learning: true });
  }

  const extractor = createExtractor({
    db, jev, rules, notes, globalPreferences, runModel,
    locale: async (projectId) => {
      const stored = await bb.storage.kv.get<string>(`rules-locale:${projectId}`), preferred = await bb.storage.kv.get<string>("preferences:locale");
      return stored === "ru" || stored === "en" ? stored : preferred === "ru" ? "ru" : "en";
    },
    log,
  });

  const decisions = createDecisions({
    db, rules, notes,
    remind: async (item) => {
      const minutes = Math.max(1, Math.round(((item.dueAt ?? Date.now()) - Date.now()) / 60_000));
      const reminder = await relayFor(ctx).remind({ projectId: item.projectId, threadId: item.threadId, note: `The owner asked to be reminded: ${item.text} (${item.evidence})`, inMinutes: minutes }) as { id?: string };
      return reminder.id ?? "set";
    },
  });

  const digest = createDigest({
    db, pmThread, log,
    send: async (threadId, text) => { await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never); },
  });

  const ops = createOps({
    db, kv, onConfig: (next) => { config = next; setRuleBudgets({ pm: next.pmRulesTokens, writer: next.writerRulesTokens }); },
    memoryFill: () => memoryFill(db, (projectId) => { const s = memorySettingsFor(db, projectId); return { noteBudget: s.noteBudget, coreBudget: s.coreBudget }; }).slice(0, 12),
  });

  const signalDeps = {
    db, jev, log,
    finalAnswer: async (threadId: string) => {
      const output = await bb.sdk.threads.output({ threadId }).catch(() => null);
      const text = output && typeof output === "object" ? (output as { text?: unknown; lastAssistantText?: unknown }).text ?? (output as { lastAssistantText?: unknown }).lastAssistantText : null;
      return typeof text === "string" ? text : null;
    },
  };

  /* ---- extraction ---- */

  const runsKey = () => `learning:extractor-runs:${new Date(startOfDay(Date.now())).toISOString().slice(0, 10)}`;
  async function extractNow(projectId: string): Promise<ExtractResult> {
    const empty: ExtractResult = { state: "nothing", read: 0, items: 0, adopted: 0, waiting: 0, duplicates: 0, dropped: 0, noted: 0 };
    if (config.mode !== "active") return { ...empty, state: "observe_mode" };
    const runs = (await kv.get<number>(runsKey()).catch(() => 0)) ?? 0;
    if (runs >= config.extractorRunsPerDay) return { ...empty, reason: `the cap of ${config.extractorRunsPerDay} extractor runs a day is spent` };
    const result = await extractor.run(projectId, { batch: config.extractorBatch, active: true });
    if (result.state === "ran" || result.state === "no_model") await kv.set(runsKey(), (runs + 1) as never);
    if (result.items) ctx.realtime?.notify(projectId, "rules");
    return result;
  }

  async function extractTick(): Promise<void> {
    purgeStaleBodies(db, Date.now());
    if (config.mode !== "active") return;
    for (const waiting of projectsWithCandidates(db)) {
      if (ctx.isDisposed()) return;
      if (Date.now() - waiting.oldest < EXTRACT_AFTER_MS && waiting.waiting < EXTRACT_AT_COUNT) continue;
      const result = await extractNow(waiting.projectId).catch((cause: unknown) => ({ state: "error", reason: cause instanceof Error ? cause.message : String(cause) }));
      if (result.state !== "nothing") log(`learning: extraction for ${waiting.projectId}: ${JSON.stringify(result)}`);
    }
  }

  /* ---- operations (the PM's action and the CLI) ---- */

  async function run(op: LearningOp, args: { id?: string | undefined; correct?: boolean | undefined; state?: string | undefined; kind?: string | undefined; projectId?: string | undefined; limit?: number | undefined; days?: number | undefined; text?: string | undefined; settings?: string[] | undefined; send?: boolean | undefined }): Promise<unknown> {
    const needId = () => { if (!args.id) throw new Error(`op "${op}" needs the id of a learned item`); return args.id; };
    switch (op) {
      case "status": return await ops.status();
      case "review": return { cases: ops.review(args.limit ?? 10), how: 'Show the owner each case and mark it with op "label": id and correct true (the decision was right) or false.' };
      case "label": if (!args.id || args.correct === undefined) throw new Error('op "label" needs id and correct'); return ops.label(args.id, args.correct);
      case "items": return ops.items({ ...(args.projectId ? { projectId: args.projectId } : {}), ...(args.state ? { states: [args.state as ItemState] } : {}), ...(args.kind ? { kinds: [args.kind as ItemKind] } : {}), limit: args.limit ?? 30 });
      case "accept": return await decisions.accept(needId());
      case "reject": return await decisions.reject(needId());
      case "drop": return await decisions.drop(needId());
      case "digest": return await digest.run({ dryRun: !args.send, ...(args.projectId ? { projectId: args.projectId } : {}) });
      case "rules": {
        if (!args.projectId) throw new Error('op "rules" needs a project');
        const all = pmRulesOf(db, args.projectId);
        const picked = args.text ? await relevantPmRules(jev(), all, args.text) : all;
        return { projectId: args.projectId, rules: picked.map((rule) => ({ id: rule.id, rule: rule.rule })), of: all.length };
      }
      case "agreement": return ops.agreement(args.days ?? 7);
      case "signals": return { counts: ops.signals(args.kind, args.limit ?? 30), complexity: complexityReport(db, Date.now() - 30 * DAY_MS) };
      case "config": return await ops.configure(args.settings ?? []);
      case "extract": { if (!args.projectId) throw new Error('op "extract" needs a project'); return await extractNow(args.projectId); }
    }
  }

  return { observer, live, extractor, decisions, digest, ops, run, extractNow, extractTick, refresh, signalDeps, config: () => config, pmThread, noteQuestion: (input: { projectId: string; threadId: string; question: string; detail?: string | undefined }) => noteOwnerQuestion(signalDeps, input) };
}
export type Learning = ReturnType<typeof createLearning>;

export function mountLearning(ctx: ServerCore, services: Services): Learning | null {
  const { bb, db } = ctx;
  let learning: Learning | null = null;

  // The tool is registered first and whatever happens: the memory family names it, and a family whose action is missing stops the plugin.
  registerObservedTool(bb.agents, {
    name: "lane_pilot_learned",
    description: "What Lane Pilot learned from the owner's own messages: status and evidence, cases to check, learned items, the owner's yes or no, PM rules for a text, settings.",
    instructions: `op: status (is it ready to act, cost, agreement), review (cases to mark), label {id, correct}, items {state?, kind?, projectId?}, accept/reject/drop {id}, digest {send?}, rules {projectId, text?}, agreement {days?}, signals {kind?}, config {settings:["key=value"]}, extract {projectId}. Learning is observing until the owner switches it on: ask him, then config {settings:["mode=active"]}. Ask the owner before accept; a global preference accept returns a bb memory add command to run.`,
    parameters: z.object({
      op: z.enum(OPS), id: z.string().min(1).optional(), correct: z.boolean().optional(), state: z.string().optional(), kind: z.string().optional(),
      projectId: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional(), days: z.number().int().min(1).max(90).optional(),
      text: z.string().max(4000).optional(), settings: z.array(z.string().max(80)).max(12).optional(), send: z.boolean().optional(),
    }).strict(),
    execute: async (params, context) => {
      if (!learning) throw new Error("learning_unavailable: the learning room did not start; see the plugin log");
      const projectId = params.projectId ?? (["rules", "extract"].includes(params.op) ? context.projectId : undefined);
      const { op, ...rest } = params;
      const result = await learning.run(op, { ...rest, ...(projectId ? { projectId } : {}) });
      ctx.realtime?.notify(context.projectId, "rules");
      return JSON.stringify(result, null, 2);
    },
  });

  // A fault in the room must not stop the plugin: it logs, and the rest of Lane Pilot starts as before.
  try {
    const room = createLearning(ctx, services);
    learning = room;

    // One collector of the owner's messages: this is a subscriber to the hub of the anamnesis room, and the live feed is what fills it.
    bb.onDispose(anamnesisFor(ctx).ownerMessages.subscribe(room.observer.consumer));
    const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
    if (events && typeof events.on === "function" && process.env.LANE_PILOT_THREAD_SIGNALS !== "0") {
      const threadOf = (payload: unknown) => (payload && typeof payload === "object" ? Reflect.get(payload, "thread") : undefined) as Parameters<typeof room.live.heard>[0];
      for (const [name, force] of [["thread.active", true], ["thread.idle", true], ["experimental_thread.events", false]] as const) {
        try { events.on(name, async (payload) => { if (!ctx.isDisposed() && room.config().enabled) await room.live.heard(threadOf(payload), { force }); }); }
        catch (cause) { bb.log.info(`Lane Pilot learning does not listen to ${name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    }

    // A PM session that starts or resumes gets the project's current PM rules (the first prompt carries them too, see activation.ts).
    try {
      bb.agents.contributeInstructions(({ threadId, projectId }) => {
        const run = db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? AND closed_at IS NULL LIMIT 1").get(threadId) as { id: string } | undefined;
        if (!run) return null;
        const block = pmRulesBlock(pmRulesOf(db, projectId, getRunSettingsScopes(db, run.id)), ruleBudget("pm"));
        return block.text.trim().slice(0, 4_000) || null;
      });
    } catch (cause) { bb.log.info(`Lane Pilot learning cannot contribute instructions: ${cause instanceof Error ? cause.message : String(cause)}`); }

    // A question an agent puts to the owner is read once for the routing signal (observation only); the question itself is not touched.
    const asking = ctx.ownerAsk as unknown as { ask: (threadId: string, request: { source?: string; question: string; detail?: string }, options?: unknown) => Promise<unknown> };
    const originalAsk = asking.ask.bind(ctx.ownerAsk);
    asking.ask = (threadId, request, options) => {
      if (request.source === "pm" && room.config().enabled) {
        const row = db.prepare("SELECT project_id FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId) as { project_id: string } | undefined;
        if (row) void room.noteQuestion({ projectId: row.project_id, threadId, question: request.question, detail: request.detail }).catch(() => undefined);
      }
      return originalAsk(threadId, request, options);
    };

    // Cron, off the quarter-hours (BB starts at most 8 isolated runs at once).
    scheduleIsolated(bb, "learning-extract", "11,41 * * * *", async () => { if (!ctx.isDisposed()) await room.extractTick(); }, { timeoutMs: 30 * 60_000 });
    scheduleIsolated(bb, "learning-digest", "20 18 * * *", async () => {
      if (ctx.isDisposed() || room.config().mode !== "active") return;
      const sent = await room.digest.run();
      if (sent.length) bb.log.info(`Lane Pilot learning report sent for ${sent.filter((row) => row.sent).length} project(s)`);
    }, { timeoutMs: 10 * 60_000 });
    scheduleIsolated(bb, "learning-signals", "40 4 * * *", async () => {
      if (ctx.isDisposed() || !room.config().enabled) return;
      const promises = await scanPromises(room.signalDeps, 20).catch(() => ({ read: 0, found: 0 }));
      const sizes = await scanComplexity(room.signalDeps, 20).catch(() => ({ read: 0 }));
      if (promises.read || sizes.read) bb.log.info(`Lane Pilot learning signals: ${promises.read} answers read (${promises.found} with an unkept promise), ${sizes.read} contracts sized`);
    }, { timeoutMs: 20 * 60_000 });
    mounted.set(ctx, room);
    return room;
  } catch (cause) {
    bb.log.warn(`Lane Pilot learning did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    return learning;
  }
}

const mounted = new WeakMap<object, Learning>();
/** The learning room of a mounted plugin instance, or undefined before it is mounted. */
export const learningFor = (ctx: ServerCore): Learning | undefined => mounted.get(ctx);
