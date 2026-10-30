import { createHash, randomUUID } from "node:crypto";
import { createHandoff, transitionHandoff } from "@lane-pilot/handoff";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { modelFamily, writerExecutionSelection, findModelIn } from "@lane-pilot/models";
import {
  CHAIR_SEAT_ID, IMPULSE_SCORES, MODERATOR_SEAT_ID,
  addCouncilMessage, agendaPrompt, chairPrompt, chooseSpeaker, createCouncilSession, decideRequestedIn, decisionFileName, decisionMarkdown, getCouncilSession,
  lastSeqOf, listCouncilMessages, maxTurnsOf, moderate, parseAgenda, parseDecisionRecord, roomPlan, roundNovelty, roundsPlan, ruleImpulse, seatPrompt, seenBySeat,
  setCouncilAgenda, setCouncilRun, setCouncilState, verdictWritten,
  type CouncilMessage, type CouncilMessageKind, type CouncilSeat, type CouncilSession, type Impulse, type Moderator,
} from "@lane-pilot/council";
import { getRun, getRunSettingsScopes } from "../../storage";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";
import { withUsage } from "../../usage/server";
import { configuredSetting, fullAccessSpawn, graphStepMetadata, findThreadsByMetadata, keyedSpawnSupported, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stringAt } from "../../core/server";
import type { ServerCore, Services } from "../../core/server";
import { councilOwnerForm, ownerLocale } from "../../relay/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { outputText } from "../../writer/server";
import { councilDecisionText, sendCouncilNotice } from "./pm-notice";
import { askOwnerToJoin, configuredSeatPair, councilMemoryBlock, selectionPairs, seatsFor } from "./council";
import type { CouncilApi } from "./council";

/**
 * The council as a graph (workflows/council.json): `open` (the session, its seats, the chair, the project place) -> `agenda` (the chair's agenda)
 * -> loop `next` (code: the owner's words, the stop and decide requests, the judge or the round order pick the next seat or end the talk) <-> `speak`
 * (the seat's thread, on the model the seat was given) -> `chair` (the decision record) -> `decide` (docs/decisions page, handoffs, the state, the PM notice) -> emit.
 * The PM tools lane_pilot_council_{start,status,say,stop} keep their names and replies; `start` starts this graph, `stop` cancels it. The talk itself
 * stays in `lane_pilot_council` and `lane_pilot_council_message` (the Council office reads them), and every step reads it from there: a plugin reload
 * in the middle of a council resumes it where the feed stopped.
 */
export const COUNCIL_WORKFLOW = "council";
const EVIDENCE_FILES = ["PROJECT.md", "docs/index.md", "README.md"];
const EVIDENCE_FILE_CHARS = 12_000;
const MATERIAL_CHARS = 20_000;
const OWNER_WAIT_MS = 10 * 60_000;
const OWNER_POLL_MS = 2_000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const TERMINAL = ["done", "failed", "stopped"];
const isEnded = (session: Pick<CouncilSession, "state">) => TERMINAL.includes(session.state);

export type CouncilStart = {
  projectId: string; runId: string; pmThreadId: string | null; question: string;
  roles?: string[] | undefined; materials?: string[] | undefined; maxRounds?: number | undefined; mode?: "room" | "rounds" | undefined; judge?: boolean | undefined;
};

export type CouncilGraph = {
  start: (input: CouncilStart) => Promise<CouncilSession>;
  cancel: (wfRunId: string, reason: string) => void;
};

type Place = { hostId: string; workspace: string };
type ChairPair = { providerId: string; model: string; effort: string };

export function mountCouncilGraph(ctx: ServerCore, services: Services, council: CouncilApi): void {
  const { bb, db, host, workspaceExecutionEnvironment } = ctx;
  const engine = services.workflowEngine;
  /** The evidence pack of a council, read once; a step that runs after a reload reads it again. */
  const evidenceCache = new Map<string, string>();

  const need = (c: StepContext<ChainRuntime>): ChainRuntime & { runId: string } => {
    if (!c.runtime?.runId) throw new Error("this council has no Lane Pilot run to work under (its PM chat was closed or the plugin lost it); convene it again");
    return c.runtime as ChainRuntime & { runId: string };
  };
  const input = (c: StepContext<ChainRuntime>, name: string) => c.resolve(`$inputs.${name}`);
  const modeOf = (c: StepContext<ChainRuntime>): "room" | "rounds" => (input(c, "mode") === "rounds" ? "rounds" : "room");
  const judgeOn = (c: StepContext<ChainRuntime>): boolean => input(c, "judge") !== false;
  const sessionOf = (id: string): CouncilSession => {
    const found = getCouncilSession(db, id);
    if (!found) throw new Error(`council ${id} is gone`);
    return found;
  };
  const note = (session: CouncilSession, seatId: string, round: number, kind: CouncilMessageKind, body: string): CouncilMessage => {
    const saved = addCouncilMessage(db, { councilId: session.id, seatId, round, kind, text: body });
    council.changed(session.projectId);
    return saved;
  };
  const stopNow = (c: StepContext<ChainRuntime>): string | null => (ctx.isDisposed() ? "plugin_stopped" : c.signal.aborted ? "aborted" : null);

  // ---------------------------------------------------------------- opening: seats, chair, place

  /** The session of a council, made once (the id is the key); the seats, the chair and the project place are worked out from the settings each time they are needed. */
  async function openSession(args: CouncilStart & { id: string }): Promise<{ session: CouncilSession; place: Place; chair: ChairPair }> {
    const run = getRun(db, args.runId);
    const config = await ctx.configForRun(args.projectId, run);
    if (!config?.hostId || !config.writerWorkspacePath) throw new Error("the run has no writer host and workspace yet");
    const settings = (await ctx.effectiveProjectSettings(args.projectId)).values;
    const pairs = selectionPairs(settings, { providerId: config.writerProviderId, model: config.writerModel });
    // The chair is the council row of the role table (a judge of the seats' opinions), unless the owner pinned `council.chair.*`.
    const chairOwn = configuredSeatPair(settings, "chair");
    // The chair judges the seats: when every seat runs in one family and the table's chair is of that family, the chair takes its peer in the
    // other. Seats of mixed (or unknown) families leave the table's pick, and a chair the owner pinned is never moved.
    const existing = getCouncilSession(db, args.id);
    // The seats keep the models they have always been given: the owner's `council.<role>.*`, else distinct stage selections.
    const seats = existing?.seats ?? seatsFor(args.roles, pairs, settings);
    const seatModels = seats.map((seat) => (seat.providerId && seat.model ? { providerId: seat.providerId, model: seat.model } : null));
    const seatFamilies = new Set(seatModels.map((seat) => (seat ? modelFamily(seat.model) : null)));
    const seatAuthor = seatModels.length && seatFamilies.size === 1 && !seatFamilies.has(null) ? seatModels[0]! : null;
    // The one resolver (core/server/spawn-model.ts): the table's chair, passed over for what the machine offers, then judged against the seats.
    const spawnUsage=spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage,config.hostId);
    const chairRole = resolveSpawnModel({ role: "council", settings, author: seatAuthor, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage, hostId: config.hostId,
      ...(chairOwn ? { pinned: { provider: chairOwn.providerId, model: chairOwn.model, reasoning: chairOwn.effort } } : {}) });
    const chair: ChairPair = { providerId: chairRole.providerId, model: chairRole.model, effort: chairRole.reasoningEffort };
    const place = { hostId: config.hostId, workspace: config.writerWorkspacePath };
    if (existing) return { session: existing, place, chair };
    const roundsSetting = configuredSetting(settings, "council.max_rounds");
    const session = createCouncilSession(db, {
      id: args.id, projectId: args.projectId, runId: args.runId, question: args.question, seats,
      maxRounds: args.maxRounds ?? (Number(roundsSetting) >= 1 && Number(roundsSetting) <= 6 ? Number(roundsSetting) : 3),
    });
    addCouncilMessage(db, { councilId: session.id, seatId: "owner", round: 0, kind: "owner", text: args.question });
    council.changed(session.projectId);
    return { session, place, chair };
  }

  function start(args: CouncilStart): Promise<CouncilSession> {
    return (async () => {
      const id = `cncl_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const { session } = await openSession({ ...args, id });
      const workflow = builtinWorkflow(COUNCIL_WORKFLOW);
      if (!workflow) throw new Error(`built-in workflow ${COUNCIL_WORKFLOW} is not loaded`);
      const settings = (await ctx.effectiveProjectSettings(args.projectId)).values;
      const judgeSetting = configuredSetting(settings, "council.judge");
      const runtime: ChainRuntime = { ctx, services, pmThreadId: args.pmThreadId, projectId: args.projectId, runId: args.runId };
      const started = engine.start({
        workflow, key: `council:${id}`, runtime, link: { projectId: args.projectId, runId: args.runId },
        inputs: {
          council_id: id, question: args.question, roles: args.roles ?? [], materials: args.materials ?? [], max_rounds: session.maxRounds,
          mode: args.mode ?? "room", judge: args.judge ?? !(judgeSetting === false || judgeSetting === "false" || judgeSetting === "0"),
        },
      });
      setCouncilRun(db, id, started.runId);
      started.done.catch((cause: unknown) => ctx.log(`Lane Pilot council ${id} run ${started.runId} stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
      council.changed(args.projectId);
      return getCouncilSession(db, id)!;
    })();
  }

  // ---------------------------------------------------------------- evidence, judge, owner

  async function readBounded(place: Place, path: string, max: number): Promise<string | null> {
    const read = await bb.sdk.files.read({ hostId: place.hostId, rootPath: place.workspace, path: `${place.workspace}/${path}` }).catch(() => null);
    const content = read && typeof read === "object" ? Reflect.get(read, "content") : null;
    return typeof content === "string" ? content.slice(0, max) : null;
  }

  async function evidenceFor(session: CouncilSession, place: Place, materials: readonly string[]): Promise<string> {
    const cached = evidenceCache.get(session.id);
    if (cached !== undefined) return cached;
    const parts: string[] = [];
    for (const path of EVIDENCE_FILES) {
      const body = await readBounded(place, path, EVIDENCE_FILE_CHARS);
      if (body) parts.push(`## ${path}\n${body}`);
    }
    for (const path of materials.slice(0, 10)) {
      const body = await readBounded(place, path, MATERIAL_CHARS);
      parts.push(body ? `## Material: ${path}\n${body}` : `## Material: ${path}\n(unreadable)`);
    }
    const memory = councilMemoryBlock(db, session.projectId, session.question, getRunSettingsScopes(db, session.runId));
    if (memory) parts.push(memory);
    const pack = parts.length ? parts.join("\n\n") : "(no project files or materials could be read; say so and reason from the question alone)";
    evidenceCache.set(session.id, pack);
    return pack;
  }

  /** One System One call through the run's host; null when the judge is off or fails, so the rule answers. */
  async function judge(hostId: string, state: unknown, questions: Record<string, { instructions: string; criteria: Record<string, string> }>): Promise<{ answers: Record<string, string>; confidence: Record<string, number> } | null> {
    try {
      const result = await host.call("councilJudge", { requestedHostId: hostId, state: JSON.stringify(state).slice(0, 60_000), questions }, { hostId, timeoutMs: 10_000 });
      return result.status === "ok" ? { answers: result.answers, confidence: result.confidence ?? {} } : null;
    } catch {
      return null;
    }
  }

  const jevModerator = (hostId: string, session: CouncilSession): Moderator => async (state) => {
    const answers = await judge(hostId, { question: session.question, agenda: session.agenda, ...state }, {
      verdict: { instructions: "Should the council keep discussing or is it time for the chair to decide?", criteria: { continue: "the last messages still add new arguments, evidence or unresolved disagreement", synthesize: "the room repeats itself, agrees, or the remaining questions need data nobody has" } },
    });
    const verdict = answers?.answers.verdict;
    return verdict === "continue" || verdict === "synthesize" ? verdict : null;
  };

  async function jevImpulse(hostId: string, session: CouncilSession, seat: CouncilSeat, last: CouncilMessage, own: readonly CouncilMessage[]): Promise<Impulse | null> {
    if (last.seatId === seat.id) return { seatId: seat.id, score: 0, reason: "none" };
    const answers = await judge(hostId, {
      question: session.question, seat: { title: seat.title, role: seat.role, instruction: seat.instruction },
      lastMessage: { from: last.seatId, kind: last.kind, text: last.text.slice(0, 4000) },
      ownLastStatement: own.at(-1)?.text.slice(0, 2000) ?? null,
    }, {
      wants: { instructions: "Does this seat have something worth saying right now in reply to the last message?", criteria: {
        addressed: "the last message asks this seat a question or names its role", disagreement: "this seat would object to a claim in the last message", evidence: "this seat can add a fact or example the room lacks",
        turn: "this seat has been silent while the topic moved into its area", none: "this seat would only repeat itself or agree" } },
    });
    const reason = answers?.answers.wants as Impulse["reason"] | undefined;
    if (!reason || !(reason in IMPULSE_SCORES)) return null;
    // A hesitant judge should not hand out the floor: the score carries its confidence, so a weak
    // "evidence" (0.75 x 0.4) stays under the floor threshold while a sure "addressed" passes.
    const confidence = answers?.confidence.wants;
    const weight = typeof confidence === "number" ? Math.max(0.3, Math.min(1, confidence)) : 1;
    return { seatId: seat.id, score: IMPULSE_SCORES[reason] * weight, reason };
  }

  /** The last few things said in the room, for the owner's form. */
  function lastCouncilWords(councilId: string): string {
    return listCouncilMessages(db, councilId).filter((message) => message.kind !== "status").slice(-3)
      .map((message) => `${message.seatId}: ${message.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n");
  }

  /**
   * The room waits for the owner. Besides the council page, the owner is asked in the PM chat (a form and a push on the phone): a word goes into the
   * feed like one said on the page, «let the chair decide» asks for the decision. The form is withdrawn when the wait ends another way.
   */
  async function waitForOwner(c: StepContext<ChainRuntime>, councilId: string, afterSeq: number, pmThreadId: string | null): Promise<CouncilMessage | null> {
    const deadline = Date.now() + OWNER_WAIT_MS;
    const session = sessionOf(councilId);
    const form = councilOwnerForm(await ownerLocale(bb), session.question);
    const withdraw = pmThreadId ? askOwnerToJoin(ctx.ownerAsk, {
      pmThreadId, question: form.question, decideLabel: form.decideLabel, detail: lastCouncilWords(councilId), timeoutMs: OWNER_WAIT_MS,
      onWords: (words) => { council.say(councilId, words); }, onDecide: () => { council.requestDecision(councilId); },
    }) : () => undefined;
    try {
      while (Date.now() < deadline) {
        const stop = stopNow(c);
        if (stop) throw new Error(`council:${stop}`);
        const feed = listCouncilMessages(db, councilId, afterSeq);
        if (decideRequestedIn(feed) || isEnded(sessionOf(councilId))) return null;
        const fresh = feed.filter((message) => message.kind === "owner");
        if (fresh.length) return fresh[0]!;
        await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_MS));
      }
      return null;
    } finally {
      withdraw();
    }
  }

  // ---------------------------------------------------------------- the pick of the next turn

  type Pick = { done: boolean; seat: string; round: number; reason: string };
  const finished = (reason: string): Pick => ({ done: true, seat: "", round: 0, reason });
  const pickSeat = (seat: CouncilSeat, round: number, reason: string): Pick => ({ done: false, seat: seat.id, round, reason });
  const pct = (value: number) => Math.round(value * 100);

  async function pickRounds(c: StepContext<ChainRuntime>, councilId: string, hostId: string): Promise<Pick> {
    for (;;) {
      const session = sessionOf(councilId);
      const feed = listCouncilMessages(db, councilId);
      if (decideRequestedIn(feed)) return finished("decide_requested");
      const plan = roundsPlan(session, feed);
      if (plan.seat) {
        if (session.round !== plan.round) { setCouncilState(db, councilId, { round: plan.round }); council.changed(session.projectId); }
        return pickSeat(plan.seat, plan.round, "round");
      }
      // Every seat has had its turn in this round: the moderator weighs it (the verdict is written once, a replay reads it back).
      let verdict = verdictWritten(feed, plan.round);
      if (!verdict) {
        const novelty = plan.round === 1 ? 1 : roundNovelty(plan.earlier, plan.said);
        const weighed = await moderate({ round: plan.round, maxRounds: session.maxRounds, novelty, passed: plan.passed, seats: session.seats.length }, judgeOn(c) ? jevModerator(hostId, session) : undefined);
        note(session, MODERATOR_SEAT_ID, plan.round, "status", `${weighed.verdict === "continue" ? "Another round" : "Time to decide"} (${weighed.by}; novelty ${pct(novelty)}%, passed ${plan.passed}/${session.seats.length})`);
        verdict = weighed.verdict;
      }
      if (verdict === "synthesize" || plan.round >= session.maxRounds) return finished(verdict === "synthesize" ? "moderator" : "round_cap");
      setCouncilState(db, councilId, { round: plan.round + 1 });
      council.changed(session.projectId);
    }
  }

  async function pickRoom(c: StepContext<ChainRuntime>, councilId: string, hostId: string, pmThreadId: string | null): Promise<Pick> {
    for (;;) {
      const stop = stopNow(c);
      if (stop) throw new Error(`council:${stop}`);
      const session = sessionOf(councilId);
      const feed = listCouncilMessages(db, councilId);
      if (decideRequestedIn(feed)) return finished("decide_requested");
      const plan = roomPlan(session, feed);
      // Opening lap: every seat states its position once, so the room has something to react to.
      if (plan.opening) return pickSeat(plan.opening, 1, "opening");
      if (plan.replies.length >= session.seats.length) {
        // A lap is over: the moderator weighs it. A verdict that says decide still gives the owner a last word.
        let verdict = verdictWritten(feed, plan.lap);
        if (!verdict) {
          const novelty = roundNovelty(plan.earlier, plan.replies.map((message) => message.text));
          const weighed = await moderate({ round: plan.lap, maxRounds: session.maxRounds, novelty, passed: 0, seats: session.seats.length }, judgeOn(c) ? jevModerator(hostId, session) : undefined);
          note(session, MODERATOR_SEAT_ID, plan.lap, "status", `${weighed.verdict === "continue" ? "The room still adds something" : "Time to decide"} (${weighed.by}; novelty ${pct(novelty)}%)`);
          verdict = weighed.verdict;
        }
        if (verdict === "synthesize" && !(await waitForOwner(c, councilId, lastSeqOf(listCouncilMessages(db, councilId)), pmThreadId))) return finished("moderator");
        setCouncilState(db, councilId, { round: plan.lap + 1 });
        council.changed(session.projectId);
        continue;
      }
      if (plan.turns >= maxTurnsOf(session)) return finished("turn_cap");
      const last = feed.at(-1)!;
      const impulses: Impulse[] = [];
      const judgedBy = new Map<string, "judge" | "rule">();
      for (const seat of session.seats) {
        let impulse: Impulse | null = null;
        if (judgeOn(c)) { try { impulse = await jevImpulse(hostId, session, seat, last, feed.filter((message) => message.seatId === seat.id)); } catch { impulse = null; } }
        judgedBy.set(seat.id, impulse ? "judge" : "rule");
        impulses.push(impulse ?? ruleImpulse({ session, seat, feed, last }));
      }
      const speaker = chooseSpeaker(impulses, feed);
      if (!speaker) {
        note(session, MODERATOR_SEAT_ID, plan.lap, "status", "Nobody asked for the floor; waiting for the owner.");
        const owner = await waitForOwner(c, councilId, lastSeqOf(listCouncilMessages(db, councilId)), pmThreadId);
        if (!owner) {
          if (!decideRequestedIn(listCouncilMessages(db, councilId))) note(session, MODERATOR_SEAT_ID, plan.lap, "status", "The owner did not add anything; time to decide.");
          return finished("room_quiet");
        }
        continue;
      }
      const seat = session.seats.find((item) => item.id === speaker.seatId)!;
      note(session, MODERATOR_SEAT_ID, plan.lap, "status", `Floor: ${seat.title} (${speaker.reason}, ${judgedBy.get(seat.id) ?? "rule"}; ${impulses.map((item) => `${item.seatId} ${pct(item.score)}%`).join(", ")})`);
      return pickSeat(seat, plan.lap, speaker.reason);
    }
  }

  // ---------------------------------------------------------------- executors

  /** A failure of a step ends the council as failed (the feed says why); an interruption (a reload, a stop) leaves the session as it is. */
  function guarded(fn: (c: StepContext<ChainRuntime>) => ReturnType<NodeExecutor<ChainRuntime>["run"]>): NodeExecutor<ChainRuntime>["run"] {
    return async (c) => {
      try {
        return await fn(c);
      } catch (cause) {
        const id = text(c.resolve("open.council_id")) || text(input(c, "council_id"));
        const session = id ? getCouncilSession(db, id) : null;
        if (session && !isEnded(session) && !ctx.isDisposed() && !c.signal.aborted) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          ctx.log(`Lane Pilot council ${id} failed: ${reason}`);
          setCouncilState(db, id, { state: "failed", reason });
          note(session, MODERATOR_SEAT_ID, session.round, "status", `Failed: ${reason}`);
          council.setPresence(id, null);
        }
        throw cause;
      }
    };
  }

  engine.register<ChainRuntime>("council.open", {
    reentrant: true,
    run: guarded(async (c) => {
      const rt = need(c);
      const id = text(input(c, "council_id")) || `cncl_${createHash("sha256").update(c.runId).digest("hex").slice(0, 16)}`;
      const roles = input(c, "roles");
      const materials = input(c, "materials");
      const { session, place, chair } = await openSession({
        id, projectId: rt.projectId, runId: rt.runId, pmThreadId: rt.pmThreadId, question: text(input(c, "question")),
        roles: Array.isArray(roles) && roles.length ? roles.map(String) : undefined, materials: Array.isArray(materials) ? materials.map(String) : undefined,
        maxRounds: Number(input(c, "max_rounds")) || undefined,
      });
      if (!session.wfRunId) setCouncilRun(db, id, c.runId);
      await evidenceFor(session, place, Array.isArray(materials) ? materials.map(String) : []);
      return { output: { council_id: id, seats: session.seats.map((seat) => seat.id), chair_provider: chair.providerId, chair_model: chair.model, chair_effort: chair.effort, host_id: place.hostId, workspace: place.workspace } };
    }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("council.next", {
    reentrant: true,
    run: guarded(async (c) => {
      const rt = need(c);
      const councilId = text(c.resolve("open.council_id"));
      const hostId = text(c.resolve("open.host_id"));
      // The pick writes notes and may wait for the owner; a replay after a reload picks again from the feed.
      const picked = await c.effect<Pick>("pick", "council.pick", () => (modeOf(c) === "rounds" ? pickRounds(c, councilId, hostId) : pickRoom(c, councilId, hostId, rt.pmThreadId)), { reconcile: async () => ({ happened: false }) });
      return { output: { done: picked.done, seat: picked.seat, round: picked.round, reason: picked.reason } };
    }),
  } as NodeExecutor<ChainRuntime>);

  /** The chair's `round` in the feed: one past the last round of the fixed rounds, the lap the room ended in. */
  const chairRound = (session: CouncilSession, mode: "room" | "rounds") => (mode === "rounds" ? session.maxRounds + 1 : roomPlan(session, listCouncilMessages(db, session.id)).lap);

  /** One turn of the agenda, a seat or the chair: a hidden thread on the model of the seat (the chair's own for the agenda and the decision), its answer saved in the feed. */
  engine.register<ChainRuntime>("lp.council-turn", {
    reentrant: true,
    run: guarded(async (c) => {
      const rt = need(c);
      const councilId = text(c.resolve("open.council_id"));
      const place: Place = { hostId: text(c.resolve("open.host_id")), workspace: text(c.resolve("open.workspace")) };
      const chair: ChairPair = { providerId: text(c.resolve("open.chair_provider")), model: text(c.resolve("open.chair_model")), effort: text(c.resolve("open.chair_effort")) };
      const materials = input(c, "materials");
      const mode = modeOf(c);
      const kind = c.nodeId as "agenda" | "speak" | "chair";
      const session = sessionOf(councilId);
      const seat = kind === "speak" ? session.seats.find((item) => item.id === text(c.resolve("next.seat"))) ?? null : null;
      if (kind === "speak" && !seat) throw new Error(`council ${councilId}: the picked seat "${text(c.resolve("next.seat"))}" is not at the table`);
      const round = kind === "agenda" ? 0 : kind === "speak" ? Number(c.resolve("next.round")) || 1 : chairRound(session, mode);
      const who = seat?.id ?? CHAIR_SEAT_ID;
      if (kind === "chair") await c.effect("state", "council.state", async () => { setCouncilState(db, councilId, { state: "synthesis" }); council.changed(session.projectId); }, { reconcile: async () => ({ happened: false }) });

      const spawnId = c.spawnKey;
      const started = await c.effect<{ threadId: string }>("spawn", "council.spawn", async () => {
        const feed = listCouncilMessages(db, councilId);
        const evidence = await evidenceFor(session, place, Array.isArray(materials) ? materials.map(String) : []);
        const live = sessionOf(councilId);
        const prompt = kind === "agenda" ? agendaPrompt({ session: live, evidence, workspace: place.workspace })
          : kind === "chair" ? chairPrompt({ session: live, evidence, feed, workspace: place.workspace })
          : seatPrompt({ session: live, seat: seat!, round, evidence, feed, sinceSeq: seenBySeat(feed, seat!.id), workspace: place.workspace });
        const providerId = seat?.providerId ?? chair.providerId;
        const model = seat?.model ?? chair.model;
        const effort = seat?.effort ?? (seat ? await effortFor(place.hostId, providerId, model) : chair.effort);
        const helperPolicy = requireHelperSpawn({ bb, db, projectId: session.projectId, runId: session.runId });
        const placement = await helperChildPlacement({ bb, db, projectId: session.projectId, runId: session.runId, role: "council-seat", taskTitle: `${seat?.title ?? "Chair"}: ${session.question.slice(0, 60)}` });
        const spawned = await fullAccessSpawn(bb, {
          ...placement,
          ...requiredPolicyField(bb, helperPolicy, providerId, "council-seat"),
          ...writerExecutionSelection(providerId, model, effort, (seat as { serviceTier?: "default" | "fast" } | null)?.serviceTier ?? "default"),
          prompt,
          environment: workspaceExecutionEnvironment(place.hostId, { path: place.workspace, environmentId: null }),
          pluginMetadata: {
            role: "council-seat", spawnId, lanePilotRunId: session.runId, councilId, seatId: who, round, parentPmThreadId: rt.pmThreadId, helperMode: helperPolicy.mode,
            ...graphStepMetadata({ runId: c.runId, stepKey: c.stepKey, nodeId: c.nodeId }), lanePilotWorkflowSpawn: c.spawnKey,
          },
        } as Parameters<typeof fullAccessSpawn>[1]);
        const threadId = stringAt(spawned, "id");
        if (!threadId) throw new Error("council_seat_thread_id_missing");
        return { threadId };
      }, {
        intent: { spawnId },
        // A spawn the process died in is found again by its key (or by the metadata where the core has no keys); one that never happened is made.
        reconcile: async () => {
          if (keyedSpawnSupported(bb)) return { happened: false };
          const found = await findThreadsByMetadata(bb, { lanePilotWorkflowRunId: c.runId, lanePilotWorkflowStep: c.stepKey, lanePilotWorkflowSpawn: c.spawnKey }, session.projectId);
          if (!found) return null;
          return found[0] ? { happened: true, result: { threadId: found[0].id } } : { happened: false };
        },
      });

      if (kind !== "agenda") council.setPresence(councilId, seat?.id ?? CHAIR_SEAT_ID);
      let answer: string;
      try {
        await waitThreadIdle(bb, started.threadId, `council seat ${who}`, undefined, undefined, () => stopNow(c));
        const raw = (await bb.sdk.threads.output({ threadId: started.threadId })).output;
        answer = (typeof raw === "string" ? raw : outputText(raw)).trim();
      } catch (cause) {
        if (c.signal.aborted) await bb.sdk.threads.stop({ threadId: started.threadId }).catch(() => undefined);
        throw cause;
      } finally {
        council.setPresence(councilId, null);
      }
      const usage = await withUsage(bb, started.threadId);

      if (kind === "agenda") {
        const agenda = parseAgenda(answer);
        await c.effect("save", "council.save", async () => {
          setCouncilAgenda(db, councilId, agenda.agenda, agenda.criteria);
          note(session, CHAIR_SEAT_ID, 0, "agenda", `Agenda:\n${agenda.agenda.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nCriteria: ${agenda.criteria.join("; ")}`);
          setCouncilState(db, councilId, { state: "discussion", round: mode === "rounds" ? 0 : 1 });
          council.changed(session.projectId);
        }, { reconcile: async () => ({ happened: false }) });
        return { output: { agenda: agenda.agenda, criteria: agenda.criteria, thread_id: started.threadId, handoff: `agenda of ${agenda.agenda.length} items` }, ...usage };
      }
      if (kind === "chair") {
        const decision = parseDecisionRecord(answer);
        await c.effect("save", "council.save", async () => {
          note(session, CHAIR_SEAT_ID, round, "decision", decision.recommendation);
          setCouncilState(db, councilId, { decision });
          council.changed(session.projectId);
        }, { reconcile: async () => ({ happened: false }) });
        return { output: { recommendation: decision.recommendation, tasks: decision.nextTasks.length, thread_id: started.threadId, handoff: `decision with ${decision.nextTasks.length} next tasks` }, ...usage };
      }
      // A seat after its position may pass; the first round is always a position (as in the fixed rounds).
      const reason = text(c.resolve("next.reason"));
      const passed = round > 1 && /^\s*PASS\.?\s*$/i.test(answer);
      await c.effect("save", "council.save", async () => {
        if (passed) note(session, seat!.id, round, "status", mode === "rounds" ? "PASS" : `PASS (${reason})`);
        else note(session, seat!.id, round, round === 1 ? "position" : "reply", answer);
      }, { reconcile: async () => ({ happened: false }) });
      return { output: { seat: seat!.id, passed, thread_id: started.threadId, handoff: passed ? `${seat!.title}: PASS` : `${seat!.title} spoke` }, ...usage };
    }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("council.decide", {
    reentrant: true,
    run: guarded(async (c) => {
      const rt = need(c);
      const councilId = text(c.resolve("open.council_id"));
      const place: Place = { hostId: text(c.resolve("open.host_id")), workspace: text(c.resolve("open.workspace")) };
      const session = sessionOf(councilId);
      const decision = session.decision;
      if (!decision) throw new Error(`council ${councilId} has no decision to write`);
      const path = decisionFileName(session);
      const feed = listCouncilMessages(db, councilId);
      const written = await c.effect<boolean>("page", "council.page", async () => {
        try {
          await bb.sdk.files.write({ hostId: place.hostId, rootPath: place.workspace, path: `${place.workspace}/${path}`, content: decisionMarkdown({ ...session, state: "done" }, decision, feed), contentEncoding: "utf8", createParents: true, expectedSha256: null });
          return true;
        } catch (cause) {
          ctx.log(`Lane Pilot council ${councilId}: decision page not written: ${cause instanceof Error ? cause.message : String(cause)}`);
          return false;
        }
      }, { reconcile: async () => ({ happened: false }) });
      const handed = await c.effect<number>("handoffs", "council.handoffs", async () => {
        let made = 0;
        for (const [index, task] of decision.nextTasks.entries()) {
          try {
            const stored = createHandoff(db, {
              id: `hnd_${createHash("sha256").update(`${councilId}:${index}`).digest("hex").slice(0, 20)}`, projectId: session.projectId, runId: session.runId, ownerThreadId: rt.pmThreadId,
              draft: { fromAgent: "council", toAgent: task.toAgent ?? "lane-pilot-pm", title: task.title, objective: task.objective, acceptance: task.acceptance, inputs: [{ kind: "path", ref: path, note: "council decision" }], budget: {}, deadlineAt: null },
            });
            // A card for the writer is delivered as a draft into the PM's queue; cards left queued sat 28-30 days unseen (W33).
            if (task.toAgent === "writer" && rt.pmThreadId) transitionHandoff(db, { id: stored.card.id, to: "delivered", actor: "lane-pilot", recipientThreadId: rt.pmThreadId });
            made += 1;
          } catch (cause) {
            ctx.log(`Lane Pilot council ${councilId}: handoff for "${task.title}" not created: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
        return made;
      }, { reconcile: async () => ({ happened: false }) });
      setCouncilState(db, councilId, { state: "done", reason: null, ...(written ? { decisionPath: path } : {}) });
      council.changed(session.projectId);
      if (rt.pmThreadId) {
        await sendCouncilNotice({
          bb, pmThreadId: rt.pmThreadId, councilId, state: "done",
          text: councilDecisionText({ id: councilId, question: session.question, decisionPath: path, nextTasks: decision.nextTasks }),
          log: (message) => ctx.log(message),
        });
      }
      return { output: { decision_path: path, handoffs: handed } };
    }),
  } as NodeExecutor<ChainRuntime>);

  /** The effort a seat without one of its own runs on: the highest the model supports, else its default. */
  async function effortFor(hostId: string, providerId: string, model: string): Promise<string> {
    try {
      const catalog = await bb.sdk.providers.models({ providerId, hostId });
      const entry = findModelIn(catalog.models, model);
      const supported = entry?.supportedReasoningEfforts.map((item) => item.reasoningEffort) ?? [];
      if (supported.includes("high")) return "high";
      return entry?.defaultReasoningEffort ?? supported[0] ?? "medium";
    } catch {
      return "medium";
    }
  }

  // A session an earlier version was driving in memory (no graph run) died with that version's process: it says so instead of looking alive.
  for (const row of db.prepare("SELECT id FROM lane_pilot_council WHERE state IN ('agenda','discussion','synthesis') AND wf_run_id IS NULL").all() as Array<{ id: string }>) {
    const session = sessionOf(row.id);
    setCouncilState(db, row.id, { state: "failed", reason: "interrupted by a plugin reload; convene the council again" });
    note(session, MODERATOR_SEAT_ID, session.round, "status", "Interrupted by a plugin reload. Convene the council again.");
  }

  council.bindGraph({ start, cancel: (wfRunId, reason) => { engine.cancel(wfRunId, reason); } });
}
