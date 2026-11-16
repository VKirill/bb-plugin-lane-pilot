// Region 16 (slash commands and workflows), batch f: phase list commands, settings, the discussion command and its stage (n1298 … n1329).
// The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_f_probe.ts) share. Each `observeF.<smaId>()` runs the REAL code of the node (the phase
// driver on a scratch database and a fake host whose file store is a map, the real workflow engine with fake executors on the real graph files, the settings store, the phase
// gates and stage rubrics) and returns plain data. No vitest import: the probe loads this file under vite-node. No model, no hub, nothing outside the machine.
// Batch a's, b's, c's and d's observations are in r16-world.ts, r16-world-b.ts, r16-world-c.ts and r16-world-d.ts (not edited here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { PHASE_STAGES, RISK_KINDS, contextSignature, discussionGate, type PhaseRecord } from "../../src/rooms/phase/logic";
import { STAGE_RUBRICS, rubricLine, specText, stageInit } from "../../src/rooms/phase/stages";
import { getPhase, listParts, listPhases, resolvePhaseRef, savePhase } from "../../src/rooms/phase/store";
import { phaseFolder } from "../../src/rooms/phase/logic";
import { registerPhaseTool, phaseToolParams } from "../../src/rooms/phase/server/tool";
import { createAutoStages, contextDoc } from "../../src/rooms/phase/server/auto-stages";
import { installDocs } from "../../src/rooms/phase/server/driver-docs";
import { registeredTools } from "../../src/rooms/platform/server";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { loadProjectSettings } from "../../src/rooms/storage/settings-store";
import { effectiveGroup, parseRoleAccess, ROLE_PROFILES } from "../../src/rooms/contracts/helper-context";
import { UNLISTED_SWITCHES } from "../../src/rooms/settings/switches";
import { AdvancedRows } from "../../src/rooms/ui-shell/ui/setting-controls";
import { runSim } from "../workflow/chain-harness";
import { phase } from "./r16-world";

type Row = Record<string, unknown>;
type Sim = Awaited<ReturnType<typeof runSim>>;
const pathOf = (r: Sim) => r.path.join(" ");
const outOf = (r: Sim) => (r.summary.output ?? {}) as Row;
const base = (path: string) => path.split("/").at(-1)!;
const refusal = (fn: () => unknown): string | null => { try { fn(); return null; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
const refusalAsync = async (fn: () => Promise<unknown>): Promise<string | null> => { try { await fn(); return null; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
const hide = (text: string | null, id: string) => (text === null ? null : text.split(id).join("<id>"));

// ---------------------------------------------------------------- the phase driver on a fake host (the files are a map, the commits are listed) and the PM tool over it
export function fWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const commits: Array<{ paths: string[]; message: string }> = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string }>;
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: String(input.message) }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "readBoundedFile") {
      if (!texts.has(String(input.relativePath))) throw new Error("ENOENT: no such file or directory");
      return { path: input.relativePath, content: texts.get(String(input.relativePath)), truncated: false };
    }
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("ENOENT: no such file or directory"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; },
    dispatchWriter: async () => ({ taskId: "t", runId: "run1" }),
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, services).phases;
  registerPhaseTool(ctx, { phases } as never);
  const tool = registeredTools(bb.agents).get("lane_pilot_phase")!;
  const call = async (args: Record<string, unknown>) => JSON.parse(String(await tool.execute(phaseToolParams.parse(args), { threadId: "thr_pm", projectId: "projA", signal: new AbortController().signal } as never))) as Row;
  const open = (title: string, goal: string, roadmapRow?: string) => phases.open({ projectId: "projA", pmThreadId: "thr_pm", title, goal, ...(roadmapRow ? { roadmapRow } : {}) });
  return { phases, db, bb, ctx, services, texts, commits, call, open };
}
type World = ReturnType<typeof fWorld>;
const snap = (w: World, id: string) => { const row = getPhase(w.db, id)!; return { stage: row.stage, state: row.state, title: row.title, goal: row.goal, row: row.record.roadmapRow ?? null }; };

// ---------------------------------------------------------------- the analysis' CONTEXT.md written and committed through the real docs layer
const RISKS = { value: "v", usability: "u", feasibility: "f", viability: "b" };
async function analysisRun(opts: { earlier?: string; commitDocs?: false; output: Row }) {
  const w = fWorld();
  const made = await w.open("Hud", "a hud for the stats page");
  const id = made.id;
  const path = `${phaseFolder(id)}/CONTEXT.md`;
  if (opts.commitDocs === false) savePhase(w.db, id, { record: { ...getPhase(w.db, id)!.record, commitDocs: false } as never, at: 2 });
  if (opts.earlier) w.texts.set(path, opts.earlier);
  const docs = installDocs({ ctx: w.ctx, services: w.services, db: w.db, bb: w.bb, now: () => 1000, reactions: {} as never });
  const booked: string[] = [], contexts: Row[] = [], questions: string[] = [];
  const get = () => getPhase(w.db, id)!;
  const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
    api: { context: async (input: Row) => { contexts.push(input); return get(); }, plan: () => get(), planCheck: async () => get(), question: (input: { text: string }) => { questions.push(input.text); return get(); },
      waveReview: () => get(), goalAudit: () => get(), lessons: () => get(), drawing: async () => get(), returnTo: () => get() } as never,
    exhausted: async () => undefined, get, save: (_id, record) => savePhase(w.db, id, { record, at: 9 }),
    book: (_phase, _section, kind, text) => booked.push(`${kind}: ${text}`),
    writeDocs: docs.writeDocs, readText: docs.readText, runtime: () => null, pmIdle: async () => true, now: () => 10,
  });
  await auto.apply(get(), { kind: "analyze", wfRunId: "w1", startedAt: 1 } as never, opts.output);
  return {
    id, path, content: w.texts.get(path) ?? null, security: w.texts.get(`${phaseFolder(id)}/SECURITY.md`) ?? null, booked: booked.map((line) => hide(line, id)!), contexts, questions,
    commits: w.commits.map((commit) => ({ files: commit.paths.map(base), message: hide(commit.message, id) })),
  };
}

// ---------------------------------------------------------------- the PM signs the context: discussion -> planning, STATE.md and SPEC.md follow
async function contextRun(opts: { ownerWords: boolean; docFiles: boolean }) {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = opts.ownerWords ? "on" : "off";
  try {
    const w = fWorld();
    const made = await w.open("Hud", "a hud for the stats page", "1");
    const id = made.id;
    const path = `${phaseFolder(id)}/CONTEXT.md`;
    w.texts.set(path, "# Context\n\nD1: the hud reads the stats table.\n");
    w.texts.set(".agents/planning/ROADMAP.md", "# Roadmap\n\n- [ ] 1 Hud\n");
    if (opts.docFiles) savePhase(w.db, id, { record: { ...getPhase(w.db, id)!.record, docFiles: true } as never, at: 2 });
    const after = await w.phases.context({ phaseId: id, docs: [path], risks: RISKS, appetite: "one wave", noGos: ["none"], requirements: ["R1"], decisions: ["D1"], by: "pm" });
    await w.phases.stateDone();
    const live = getPhase(w.db, id)!;
    return {
      id, stage: after.stage, liveStage: live.stage, signed: !!live.record.context?.sha,
      parts: listParts(w.db, id).filter((part) => ["stage", "awaits_signature", "signed"].includes(part.kind)).map((part) => `${part.kind}: ${hide(part.text, id)!.replace(/[0-9a-f]{12}/, "<sha>")}`),
      commits: w.commits.map((commit) => ({ files: commit.paths.map(base), message: hide(commit.message, id) })),
      state: w.texts.get(".agents/planning/STATE.md") ?? null, spec: w.texts.get(`${phaseFolder(id)}/SPEC.md`) ?? null,
    };
  } finally { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; }
}

// ---------------------------------------------------------------- workflow runs
const ANALYZE_STUBS = { gather: { anchors: [{ file: "src/stats.ts", line: 12, note: "the table" }], modules: ["stats"], conventions: ["AGENTS.md"], summary: "s", stack: ["ts"], features: ["f"] },
  assess: { decisions: [{ id: "D1", text: "reuse the table" }], risks: [], scores_min: 3, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: ["auth?", "cache?"], residual_risks: [], appetite: "s", no_gos: [], pitfalls: [] },
  advise: { area: "a?", options: [], pick: "one", advice: [{ option: "one" }] } };
const lpAnalyze = (input: Row, stubs: Row = {}, humans?: Record<string, Row>) => runSim("lp.analyze", { input: { goal: "g", ...input }, stubs: { ...ANALYZE_STUBS, ...stubs } as never, ...(humans ? { humans } : {}) });
const SHIP_STUBS = { "lp.integration_gate_status": { ok: true, failing: [] }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://example/pr/7" }, "lp.post_ship_hooks": { count: 1, files: [".agents/planning/hooks/post-ship.md"] }, post_ship: { hooks_run: ["notify"], hooks_failed: ["tag"] } };
const ship = (input: Row, stubs: Row = {}) => runSim("ship", { input: { phase_id: "ph_a", ...input }, stubs: { ...SHIP_STUBS, ...stubs } as never });
const wfNode = (name: string, id: string) => (JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { nodes: Array<Row & { id: string }> }).nodes.find((row) => row.id === id)!;

export const observeF = {
  // ---- the phase list: add, insert, remove, edit
  /** n1298: a new phase is a record in the book: its own id, its folder, a roadmap row address, at discussion and active; the earlier phase is untouched. */
  async k_c_addphase() {
    const w = fWorld();
    const a = await w.open("Hud", "a hud for the stats page");
    const b = await w.open("Export", "export the stats as CSV", "2");
    const row = getPhase(w.db, b.id)!;
    const first = listParts(w.db, b.id)[0];
    return {
      ids: [/^ph_[0-9a-f]{10}$/.test(a.id), /^ph_[0-9a-f]{10}$/.test(b.id), a.id !== b.id],
      row: { stage: row.stage, state: row.state, title: row.title, goal: row.goal, projectId: row.projectId, pmThreadId: row.pmThreadId, run: row.runId, roadmapRow: row.record.roadmapRow ?? null },
      folder: phaseFolder(b.id).replace(b.id, "<id>"),
      book: first ? [first.section, first.kind, first.text.startsWith("phase opened: Export")] : null,
      byRow: resolvePhaseRef(w.db, "projA", "2").id === b.id,
      live: listPhases(w.db, { projectId: "projA", live: true }).map((phase) => phase.title).sort(),
    };
  },

  /** n1299: an urgent phase takes a decimal row between two phases at any moment; the others keep their id, row and stage, nothing is renumbered. */
  async k_c_insertphase() {
    const w = fWorld();
    const one = await w.open("Login", "the login page", "1");
    const two = await w.open("Billing", "the billing page", "2");
    savePhase(w.db, one.id, { stage: "planning", at: 5 });
    const before = [snap(w, one.id), snap(w, two.id)];
    const urgent = await w.open("Hotfix", "stop the double charge", "1.1");
    const after = [snap(w, one.id), snap(w, two.id)];
    return {
      before, unchanged: JSON.stringify(before) === JSON.stringify(after), urgent: snap(w, urgent.id), distinct: new Set([one.id, two.id, urgent.id]).size,
      resolved: ["1", "1.1", "2"].map((row) => resolvePhaseRef(w.db, "projA", row).title),
    };
  },

  /** n1300: a future phase is removed by closing it with the words why: the record and its book stay as history, nothing else moves; without words it is refused. */
  async k_c_removephase() {
    const w = fWorld();
    const a = await w.open("Hud", "a hud for the stats page", "3");
    const b = await w.open("Stats", "the stats page", "4");
    const noWords = refusal(() => w.phases.setState({ phaseId: a.id, state: "close" }));
    const blank = refusal(() => w.phases.setState({ phaseId: a.id, state: "close", words: "   " }));
    const kept = snap(w, a.id);
    const closed = w.phases.setState({ phaseId: a.id, state: "close", words: "dropped: the owner moved the hud to next quarter", by: "owner" });
    const row = getPhase(w.db, a.id)!;
    return {
      noWords, blank, kept: [kept.stage, kept.state],
      closed: { stage: closed.stage, state: closed.state, closing: row.record.closing ? { by: row.record.closing.by, words: row.record.closing.words } : null, title: row.title },
      book: listParts(w.db, a.id).filter((part) => part.kind === "close").map((part) => part.text),
      live: listPhases(w.db, { projectId: "projA", live: true }).map((phase) => phase.title),
      resume: hide(refusal(() => w.phases.setState({ phaseId: a.id, state: "resume" })), a.id),
      other: snap(w, b.id),
    };
  },

  /** n1301: the goal of a phase is edited where it stands (id, title, row stay); each edit counts; a phase past planning or closed refuses it. */
  async k_c_editphase() {
    const w = fWorld();
    const a = await w.open("Hud", "a hud", "5");
    const edited = w.phases.revise({ phaseId: a.id, goal: "a hud with a CSV export", note: "the owner added the export" });
    const again = w.phases.revise({ phaseId: a.id, goal: "a hud with a PDF export", note: "the owner changed his mind" });
    const row = getPhase(w.db, a.id)!;
    savePhase(w.db, a.id, { stage: "execution", at: 6 });
    const running = hide(refusal(() => w.phases.revise({ phaseId: a.id, goal: "x", note: "y" })), a.id);
    const afterRun = snap(w, a.id);
    savePhase(w.db, a.id, { stage: "closed", state: "closed", at: 7 });
    const closed = refusal(() => w.phases.revise({ phaseId: a.id, goal: "x", note: "y" }));
    return {
      same: edited.id === a.id, first: { goal: edited.goal, title: edited.title, stage: edited.stage, revisions: edited.record.scope?.revisions },
      second: { goal: again.goal, revisions: row.record.scope?.revisions }, roadmapRow: row.record.roadmapRow,
      book: listParts(w.db, a.id).filter((part) => part.kind === "revised").map((part) => part.text),
      running, goalAfterRefusal: afterRun.goal, closed,
    };
  },

  // ---- settings
  /** n1302: the settings a phase and its agents run on: the hub row, the project row over it, a section's row over both; a project with no row of its own reads the hub's. */
  async k_c_settings() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const put = (projectId: string, bindingId: string, key: string, value: string) => db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES(?,?,?,?,1,1)").run(projectId, bindingId, key, value);
    put(GLOBAL_SETTINGS_PROJECT_ID, "", "quality_mode", JSON.stringify("quick"));
    put(GLOBAL_SETTINGS_PROJECT_ID, "", "plan_critique.enabled", JSON.stringify(false));
    put(GLOBAL_SETTINGS_PROJECT_ID, "", "specialist.enabled", JSON.stringify(true));
    put("projA", "", "quality_mode", JSON.stringify("full"));
    put("projA", "", "note", "plain words");
    put("projA", "sec1", "quality_mode", JSON.stringify("standard"));
    put("projA", "sec1", "plan_critique.enabled", JSON.stringify(true));
    return {
      project: loadProjectSettings(db, "projA"),
      section: loadProjectSettings(db, "projA", ["sec1"]),
      other: loadProjectSettings(db, "projB"),
      hub: loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID),
    };
  },

  /** n1303: the power knobs sit under «Advanced»: their rows are in the page either way and hidden until it is shown; the plan bounce is one such switch. */
  k_c_settingsadv() {
    const knob = createElement("span", null, "knob");
    const shown = renderToStaticMarkup(createElement(AdvancedRows, { show: true, testId: "adv", children: knob }));
    const hidden = renderToStaticMarkup(createElement(AdvancedRows, { show: false, testId: "adv", children: knob }));
    const hiddenAttr = (html: string) => /<div[^>]*\shidden=""/.test(html);
    return { shown: { hidden: hiddenAttr(shown), keepsRow: shown.includes("<span>knob</span>"), testId: shown.includes('data-testid="adv"') },
      hidden: { hidden: hiddenAttr(hidden), keepsRow: hidden.includes("<span>knob</span>"), testId: hidden.includes('data-testid="adv"') },
      planBounce: UNLISTED_SWITCHES["phase.plan_bounce"]?.slice(0, 2) ?? null };
  },

  /** n1304: the search key and the external reviewer: the search specialist carries Env Catalog and the tavily skill; the reviewer does not until the owner grants it. */
  k_c_settingsint() {
    const reviewer = (names?: string[]) => effectiveGroup("specialist-reviewer", "bbPlugins", names ? parseRoleAccess({ bbPlugins: { mode: "allow", names } }) : undefined).names;
    return {
      tavily: ROLE_PROFILES["specialist:tavily"],
      reviewer: { before: reviewer()!.includes("env-catalog"), granted: reviewer(["env-catalog"])!.includes("env-catalog"), source: effectiveGroup("specialist-reviewer", "bbPlugins", parseRoleAccess({ bbPlugins: { mode: "allow", names: ["env-catalog"] } })).source },
      designer: ROLE_PROFILES["specialist:design-lead"].skills,
    };
  },

  // ---- the profile, discussion and spec commands (workflow graphs)
  /** n1306: consent first (sessions, a questionnaire or nothing), the record, the card; no answer is cancel and nothing is written. */
  async k_c_profileuser() {
    const stubs = { sessions: { loaded: 12 }, record: { recorded: 8 }, card: { card: "Kirill: a marketer who writes code" } };
    const sessions = await runSim("profile-user", { input: {}, stubs, humans: { consent: { answer_kind: "sessions" } } });
    const form = await runSim("profile-user", { input: {}, stubs, humans: { consent: { answer_kind: "questionnaire" }, interview: { answer_kind: "answered", answer: "{}" } } });
    const silent = await runSim("profile-user", { input: {}, stubs, humans: { consent: { answer_kind: "questionnaire" }, interview: { answer_kind: "timeout" } } });
    const cancel = await runSim("profile-user", { input: {}, stubs, humans: { consent: { answer_kind: "cancel" } } });
    const none = await runSim("profile-user", { input: {}, stubs, humans: { consent: { answer_kind: "timeout" } } });
    return {
      sessions: [pathOf(sessions), outOf(sessions), sessions.called("interview").length, sessions.called("record").length],
      form: [pathOf(form), outOf(form), form.called("sessions").length, form.called("record").length],
      silent: [pathOf(silent), outOf(silent), silent.called("record").length],
      cancel: [pathOf(cancel), outOf(cancel), cancel.called("sessions").length + cancel.called("record").length + cancel.called("card").length],
      none: [pathOf(none), outOf(none).status],
    };
  },

  /** n1307: the discussion ends in a signed CONTEXT: the gate names what is missing (no files, an empty file, a changed file, unnamed risks, no appetite, no no-gos) and passes a complete one. */
  k_c_discuss() {
    const docs = [{ path: "c.md", sha256: "a", bytes: 10 }, { path: "e.md", sha256: "b", bytes: 0 }];
    const risks = Object.fromEntries(RISK_KINDS.map((kind) => [kind, "named"]));
    const whyOf = (record: PhaseRecord) => { const check = discussionGate(record); return check.ok ? [] : check.why; };
    const good = [{ path: "c.md", sha256: "a", bytes: 10 }];
    const full: PhaseRecord = { context: { docs: good, sha: contextSignature(good), signedAt: 1, risks, appetite: "one wave", noGos: ["none"] } } as never;
    return {
      none: whyOf({} as PhaseRecord),
      empty: whyOf({ context: { docs, sha: contextSignature(docs), signedAt: 1, risks, appetite: "x", noGos: ["none"] } } as never),
      changed: whyOf({ context: { ...full.context!, sha: "stale" } } as never),
      risks: whyOf({ context: { ...full.context!, risks: { value: "named" } } } as never),
      bare: whyOf({ context: { ...full.context!, appetite: " ", noGos: [" "] } } as never),
      legacy: whyOf({ context: { docs: good, sha: contextSignature(good), signedAt: 1, risks, legacy: true } } as never),
      complete: whyOf(full), ok: discussionGate(full).ok,
    };
  },

  /** n1308: the assumptions come from the code: a question without file:line sends the walk round once more; what the code cannot answer is open and the run says so. */
  async k_c_discuss_assume() {
    const synth = { locked: ["GET only"], open: ["invalidation on write"], deferred: ["ttl per route"], risk_register: [{ risk: "stale reads", severity: "high", file_line: "src/cache.ts:12" }] };
    const walk = { branches_walked: 5, questions_without_anchor: 0, terminology: [{ term: "hit" }] };
    const anchored = await runSim("grill-plan", { input: { goal: "cache the API", plan: "cache GET by URL" }, stubs: { walk, synth } });
    const unanchored = await runSim("grill-plan", { input: { goal: "cache the API", plan: "cache GET by URL" }, stubs: { walk: [{ ...walk, questions_without_anchor: 2 }, { ...walk, branches_walked: 6 }], synth } });
    const never = await runSim("grill-plan", { input: { goal: "cache the API" }, stubs: { walk: { ...walk, questions_without_anchor: 3 }, synth } });
    const clear = await runSim("grill-plan", { input: { goal: "cache the API" }, stubs: { walk, synth: { ...synth, open: [] } } });
    return {
      anchored: [pathOf(anchored), outOf(anchored)],
      unanchored: [pathOf(unanchored), unanchored.called("walk").length, outOf(unanchored).branches_walked],
      never: [pathOf(never), never.called("walk").length],
      clear: [pathOf(clear), outOf(clear).status, outOf(clear).locked],
      prompt: String(wfNode("grill-plan", "walk").prompt).includes("EVERY question cites file:line"),
    };
  },

  /** n1309: every open question goes into the file at once (more than the five the owner is asked in chat), each on its own line, the ones the owner left for later marked. */
  async k_c_discuss_power() {
    const questions = Array.from({ length: 7 }, (_, index) => `q${index + 1}: which way for area ${index + 1}?`);
    const doc = contextDoc(phase({}, "discussion"), { open_questions: questions, deferred_by_owner: ["q7: which way for area 7?"], appetite: "s", no_gos: ["none"] });
    const lines = doc.content.split("\n");
    const start = lines.indexOf("## Open questions");
    const listed = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line === ""));
    const applied = await analysisRun({ output: { open_questions: questions, appetite: "s", no_gos: ["none"] } });
    return { listed, returned: doc.questions.length, askedInChat: applied.questions.length, inFile: applied.content!.split("\n").filter((line) => line.startsWith("- q")).length };
  },

  /** n1310: the phase's assumptions are listed before planning, with their evidence, and nothing is written. */
  async k_c_listassume() {
    const assumptions = [{ statement: "users table exists", evidence: "db.ts:4", confidence: 80 }, { statement: "tokens expire in a day", evidence: "none", confidence: 30 }];
    const r = await runSim("phase-assumptions", { input: { phase_id: "ph_a" }, stubs: { assumptions: { assumptions } } });
    const wf = JSON.parse(readFileSync(join(process.cwd(), "workflows", "phase-assumptions.json"), "utf8")) as { nodes: Array<Row> };
    return { path: pathOf(r), out: outOf(r), asked: r.called("assumptions").length, writes: wf.nodes.filter((node) => node.action === "fs.write" || node.type === "human").length };
  },

  /** n1311: what the phase delivers: ambiguity is scored, a person answers while it is above 0.2 (three scores at most), then SPEC.md; a spec written under doubt says low confidence. */
  async k_c_spec() {
    const run = (score: Row | Row[], humans?: Record<string, Row>) => runSim("spec-phase", { input: { phase_id: "ph_a", goal: "export" }, stubs: { score: score as never, spec: { content: "# SPEC\n" }, "fs.write": { spec_path: ".agents/phases/ph_a/SPEC.md" } }, ...(humans ? { humans } : {}) });
    const asked = await run([{ ambiguity: 0.6, weakest: "goal", questions: ["which stats?"] }, { ambiguity: 0.15, weakest: "", questions: [] }], { ask: { answer_kind: "answered" } });
    const clear = await run({ ambiguity: 0.1, weakest: "", questions: [] });
    const edge = await run({ ambiguity: 0.2, weakest: "", questions: [] });
    const doubt = await run({ ambiguity: 0.6, weakest: "goal", questions: ["q"] }, { ask: { answer_kind: "answered" } });
    return { asked: [pathOf(asked), outOf(asked)], clear: pathOf(clear), edge: [pathOf(edge), outOf(edge).status], doubt: [pathOf(doubt), outOf(doubt)], role: wfNode("spec-phase", "spec").role };
  },

  /** n1312: the UI contract: the drawing and its checker go round until the checker passes; the result names the contract paths, feasibility, the contradiction and the verdict. */
  async k_c_uiphase() {
    const input = { goal: "a stats screen", pieces: "p1: the stats screen", folder: ".agents/phases/ph_a", requirements: "actions, screens_states, texts" };
    const first = { paths: [".agents/phases/ph_a/design/UI-SPEC.md"], feasible: false, contradiction: "the plan wants two screens on one route" };
    const second = { paths: [".agents/phases/ph_a/design/UI-SPEC.md", ".agents/phases/ph_a/design/stats.html"], feasible: true, contradiction: "" };
    const r = await runSim("lp.draw", { input, stubs: { draw: [first, second], check: [{ verdict: "rework", scores: { hierarchy: 2 }, notes: "no empty state" }, { verdict: "pass", scores: { hierarchy: 4 }, notes: "states drawn" }] } });
    const once = await runSim("lp.draw", { input, stubs: { draw: second, check: { verdict: "pass", scores: { hierarchy: 5 }, notes: "ok" } } });
    const ran = (x: Sim) => x.path.filter((id) => !x.skipped.includes(id)).join(" ");
    return { loop: [ran(r), outOf(r)], draws: r.called("draw").length, once: [ran(once), outOf(once)], role: wfNode("lp.draw", "check").role };
  },

  /** n1313: the AI-SPEC: four roles in order, a check gate: gaps send the spec back once, a spec still short is blocked; the result names the framework and the spec path. */
  async k_c_aiphase() {
    const stubs = { select: { framework: "langchain", options: [] }, research: { notes: "n", quick_reference: "q", implementation_notes: "i", domain_notes: "d" }, eval_plan: { eval_plan: "e" }, spec: { spec_path: "x/AI-SPEC.md" } };
    const run = (check: Row | Row[]) => runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...stubs, check } as never });
    const clean = await run({ ok: true, gaps: [] });
    const rework = await run([{ ok: false, gaps: ["no eval"] }, { ok: true, gaps: [] }]);
    const blocked = await run({ ok: false, gaps: ["no guards"] });
    return { clean: [pathOf(clean), outOf(clean)], rework: [pathOf(rework), outOf(rework).status, rework.called("spec").length], blocked: [pathOf(blocked), outOf(blocked)], roles: ["select", "research", "eval_plan", "spec", "check"].map((id) => wfNode("ai-integration-phase", id).role) };
  },

  /** n1314: a user story (who, what, why) and an MVP cut; the splitting check sends a story that is not vertical back once, then hands it to planning. */
  async k_c_mvp() {
    const story = { who: "the owner", what: "sees the stats", why: "to decide", slice: "one report page", out_of_scope: ["pdf"] };
    const run = (check: Row | Row[]) => runSim("mvp-phase", { input: { goal: "export stats" }, stubs: { story, split_check: check as never } });
    const once = await run([{ verdict: "rework", notes: "not vertical" }, { verdict: "pass", notes: "ok" }]);
    const clean = await run({ verdict: "pass", notes: "ok" });
    const stuck = await run({ verdict: "rework", notes: "still not vertical" });
    const brief = (r: Sim) => { const out = outOf(r), made = (out.story ?? {}) as Row; return { status: out.status, who: made.who, what: made.what, why: made.why, slice: made.slice, outOfScope: made.out_of_scope, goal: out.goal }; };
    return { once: [pathOf(once), brief(once)], clean: pathOf(clean), stuck: [pathOf(stuck), stuck.called("story").length] };
  },

  // ---- the discussion stage
  /** n1315: the stage order is set here: the seven stages in order, and the discussion's seven steps the PM reads with `rubric`. */
  async k_wdi_rubric() {
    const w = fWorld();
    const made = await w.open("Hud", "a hud");
    const byPhase = await w.call({ action: "rubric", phaseId: made.id });
    const byStage = await w.call({ action: "rubric", stage: "discussion" });
    return { stages: Object.keys(STAGE_RUBRICS), phaseStages: PHASE_STAGES.filter((stage) => stage !== "closed"), order: byStage.order, same: JSON.stringify(byPhase) === JSON.stringify(byStage), line: rubricLine("discussion").split(" Blocking: ")[0] };
  },

  /** n1316: before the discussion the PM reads the roadmap, the requirements and the discussion file; a closed phase reads only its book. */
  k_wdi_init() {
    const at = (stage: string, record: Row = {}) => stageInit({ id: "ph_sma", stage, record } as never);
    return { discussion: at("discussion"), closed: at("closed"), signedDiscussion: at("discussion", { context: { docs: [{ path: "a.md" }], sha: "s", signedAt: 1 } }) };
  },

  /** n1317: what blocks the discussion before the questions: the four antipatterns, read with the order through `rubric` and in the stage line the PM gets. */
  async k_wdi_anti() {
    const w = fWorld();
    const byStage = await w.call({ action: "rubric", stage: "discussion" });
    return { antipatterns: byStage.antipatterns, line: rubricLine("discussion").split(" Blocking: ")[1] };
  },

  /** n1318: a clarified «what» is written down and not asked again: the signed context becomes SPEC.md (goal, requirements, locked decisions, appetite, no-gos) and planning reads it. */
  async k_wdi_spec() {
    const run = await contextRun({ ownerWords: false, docFiles: true });
    const planning = stageInit({ id: "ph_sma", stage: "planning", record: { context: { docs: [{ path: ".agents/phases/ph_sma/CONTEXT.md" }], sha: "s", signedAt: 1 } } } as never);
    const text = specText({ id: "ph_sma", title: "Hud", goal: "a hud", record: { context: { docs: [], sha: "s", signedAt: 1, requirements: ["R1"], decisions: ["D1", "D2"], appetite: "one wave", noGos: ["pdf"] } } } as never);
    return { written: (run.spec ?? "").replace(run.id, "<id>").split("\n").slice(0, 12), planning, text: text.split("\n") };
  },

  /** n1319: a CONTEXT.md that exists is found and its decisions kept under «Earlier decisions (kept)», the book says so; without one the new document stands alone. */
  async k_wdi_existing() {
    const output = { decisions: [{ id: "D2", text: "new decision" }], risks: [], open_questions: [], appetite: "small", no_gos: ["none"] };
    const kept = await analysisRun({ earlier: "D1: keep this decision always\n", output });
    const fresh = await analysisRun({ output });
    const tail = (content: string | null) => (content ?? "").split("\n").slice(-4);
    return { kept: { tail: tail(kept.content), booked: kept.booked.filter((line) => line.startsWith("context_existing")) }, fresh: { has: (fresh.content ?? "").includes("Earlier decisions"), booked: fresh.booked.filter((line) => line.startsWith("context_existing")) } };
  },

  /** n1320: the code is scouted before any question: gather runs first and read-only, its anchors and conventions reach the result; a thin scout is repeated. */
  async k_wdi_scout() {
    const done = await lpAnalyze({});
    const thin = await lpAnalyze({}, { assess: [{ ...ANALYZE_STUBS.assess, confidence: 40, stalled: false }, { ...ANALYZE_STUBS.assess, confidence: 90 }] });
    return { path: pathOf(done), anchors: outOf(done).anchors, again: [pathOf(thin), thin.called("gather").length], role: wfNode("lp.analyze", "gather").role, readOnly: String(wfNode("lp.analyze", "gather").prompt).includes("Write nothing into the repository") };
  },

  /** n1322: the person picks which gray areas to settle: with ask_owner the open questions go to him and the rest are deferred; without it the choice step is not visited. */
  async k_wdi_gray() {
    const asked = await lpAnalyze({ ask_owner: true, owner_card: "card" }, {}, { choose: { answer: "auth?", answer_kind: "chosen", chosen: ["auth?"], deferred: ["cache?"] } });
    const plain = await lpAnalyze({ owner_card: "card" });
    const noQuestions = await lpAnalyze({ ask_owner: true }, { assess: { ...ANALYZE_STUBS.assess, open_questions: [] } });
    const doc = contextDoc(phase({}, "discussion"), { open_questions: ["auth?", "cache?"], deferred_by_owner: ["cache?"], chosen: ["auth?"], appetite: "s", no_gos: ["none"] });
    return { asked: [pathOf(asked), outOf(asked).deferred_by_owner], plain: [pathOf(plain), plain.called("choose").length], noQuestions: [pathOf(noQuestions), noQuestions.skipped], marked: doc.content.split("\n").filter((line) => line.startsWith("- ") && line.includes("?")) };
  },

  /** n1323: the deep-dive goes on until clear: a low-confidence assessment sends the scout round again; the rubric names one advisor per chosen area and each area gets one. */
  async k_wdi_deep() {
    const w = fWorld();
    const rubric = await w.call({ action: "rubric", stage: "discussion" });
    const three = ["auth?", "cache?", "limits?"];
    const advised = await lpAnalyze({ ask_owner: true, owner_card: "senior dev" }, { assess: { ...ANALYZE_STUBS.assess, open_questions: three } }, { choose: { answer: "all", answer_kind: "all" } });
    const loop = await lpAnalyze({}, { assess: [{ ...ANALYZE_STUBS.assess, confidence: 40, stalled: false }, { ...ANALYZE_STUBS.assess, confidence: 50, stalled: false }, { ...ANALYZE_STUBS.assess, confidence: 90 }] });
    return { step: (rubric.order as string[])[3], advisors: advised.called("advise:child").length, loop: [pathOf(loop), loop.called("assess").length] };
  },

  /** n1324: with a developer profile an advisor compares the options of each chosen area (at most six, the rest are cut); without one no advisor runs and the advice stays empty. */
  async k_wdi_advisor() {
    const choose = { choose: { answer: "all", answer_kind: "all" } };
    const profile = await lpAnalyze({ ask_owner: true, owner_card: "senior dev" }, {}, choose);
    const bare = await lpAnalyze({ ask_owner: true, owner_card: "" }, {}, choose);
    const many = Array.from({ length: 8 }, (_, index) => `q${index}?`);
    const wide = await lpAnalyze({ ask_owner: true, owner_card: "c" }, { assess: { ...ANALYZE_STUBS.assess, open_questions: many } }, choose);
    return { profile: [pathOf(profile), profile.called("advise:child").length, (outOf(profile).advice as unknown[]).length], bare: [bare.called("advise:child").length, outOf(bare).advice], wide: [wide.summary.status, wide.called("advise:child").length], fanOut: wfNode("lp.analyze", "advise").max_fan_out };
  },

  /** n1325: CONTEXT.md is written by the machine from the analysis: decisions locked / free / deferred, the risks, the open questions; the rubric names the step. */
  async k_wdi_write() {
    const w = fWorld();
    const rubric = await w.call({ action: "rubric", stage: "discussion" });
    const doc = contextDoc(phase({}, "discussion"), { decisions: [{ id: "D1", status: "locked", text: "reuse the table" }, { id: "D2", status: "free", text: "the chart library" }, { id: "D3", kind: "deferred", text: "pdf export" }, { text: "no id and no status" }],
      risks: [{ text: "user tokens leave the box", kind: "security" }], open_questions: ["which cache?"], appetite: "two days", no_gos: ["pdf"], scope_verdict: "small", recommendation: "go", confidence: 80 });
    const lines = doc.content.split("\n");
    const from = lines.indexOf("## Decisions");
    return { step: (rubric.order as string[])[4], decisions: lines.slice(from + 1, lines.indexOf("", from + 1)), ids: doc.decisions, head: lines.slice(0, 4), sections: lines.filter((line) => line.startsWith("## ")) };
  },

  /** n1326: the decisions are committed and the state is marked: CONTEXT.md (and SECURITY.md) go in one commit of exactly those files; STATE.md follows the move to planning; a project that does not commit docs gets the files and no commit. */
  async k_wdi_commit() {
    const plain = await analysisRun({ output: { decisions: [{ id: "D1", text: "reuse the table" }], risks: [], open_questions: [], appetite: "s", no_gos: ["none"] } });
    const secure = await analysisRun({ output: { decisions: [], risks: [{ text: "user tokens leave the box", kind: "security" }], open_questions: [], appetite: "s", no_gos: ["none"] } });
    const quiet = await analysisRun({ commitDocs: false, output: { decisions: [], risks: [], open_questions: [], appetite: "s", no_gos: ["none"] } });
    const signed = await contextRun({ ownerWords: false, docFiles: true });
    return {
      plain: { commits: plain.commits, written: !!plain.content }, secure: { commits: secure.commits, security: (secure.security ?? "").split("\n")[0] },
      quiet: { commits: quiet.commits, written: !!quiet.content },
      signed: { commits: signed.commits, state: (signed.state ?? "").split("\n").filter((line) => /^(stage|phase|## )/i.test(line) || line.includes("stage")).slice(0, 6) },
    };
  },

  /** n1327: only with auto-advance on: a signed context moves the phase to planning at once; with the owner's word asked the phase waits for it at discussion. */
  async k_wdi_advance() {
    const auto = await contextRun({ ownerWords: false, docFiles: false });
    const asked = await contextRun({ ownerWords: true, docFiles: false });
    return { auto: [auto.stage, auto.liveStage, auto.parts], asked: [asked.stage, asked.liveStage, asked.signed, asked.parts] };
  },

  // ---- ship and the clean PR branch
  /** n1328: the gates (the integration gate, the preflight, the optional review), a PR from the phase's artifacts, the post-ship hooks; each gate that holds says by what. */
  async k_c_ship() {
    const shipped = await ship({});
    const gate = await ship({}, { "lp.integration_gate_status": { ok: false, failing: ["npm test red on the head"] } });
    const held = await ship({}, { preflight: { ready: false, held_by: ["no full-gate marker", "untriaged vendor bump"] } });
    const reviewed = await ship({ review: true }, { "code-review": { status: "rework" } });
    return {
      shipped: [pathOf(shipped), outOf(shipped)], gate: [pathOf(gate), outOf(gate)], held: [pathOf(held), outOf(held), held.called("open_pr").length],
      reviewed: [pathOf(reviewed), outOf(reviewed).status, reviewed.called("open_pr").length], skippedReview: shipped.skipped.includes("review"),
    };
  },

  /** n1329: a clean branch for the PR: review/<phase> from the base without the planning bookkeeping commits; a conflict stops it and says so. */
  async k_c_prbranch() {
    const run = (split: Row) => runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split } as never });
    const clean = await run({ branch: "review/ph_a", commits: 3, conflict: false });
    const conflict = await run({ branch: "review/ph_a", commits: 1, conflict: true });
    const prompt = String(wfNode("pr-branch", "split").prompt);
    return { clean: [pathOf(clean), outOf(clean)], conflict: [pathOf(conflict), outOf(conflict)], drops: prompt.includes(".agents/planning/**") && prompt.includes(".agents/phases/**"), stops: prompt.includes("Stop on a conflict") };
  },
};
