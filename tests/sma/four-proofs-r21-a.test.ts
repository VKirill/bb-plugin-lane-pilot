// Region 21 · sma-tools: project queries. Each test seeds a scratch database / fixture folder with a known state and checks the whole answer the
// tool gives (full lines, parsed values), the «nothing there» case included. The card's CLI verbs are run through the real verb function.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { casUpsertSettings, loadProjectSettings } from "../../src/rooms/storage";
import { validateSettingValue } from "../../src/rooms/settings/setting-validation";
import { openDatabase } from "../../src/rooms/plugin-db";
import { createCore } from "../../src/rooms/core/server/core";
import { createLearning } from "../../src/rooms/learning/service";
import { runLearningCli } from "../../src/rooms/learning/cli";
import { runCapabilityCli } from "../../src/rooms/capability/server/cli";
import { commitDocs } from "../../src/rooms/docs/git-docs";
import { declaredSkills, projectFolderSkills } from "../../src/rooms/writer/server/skill-pick";
import { pieceProblems } from "../../src/rooms/phase/logic/gates";
import { issuable, wavesOf, piecesOfWave } from "../../src/rooms/phase/logic/waves";
import { autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { templateFill } from "../../src/rooms/phase/stages";
import { featureRegistry, featureRegistryGaps } from "../../src/rooms/native-install/feature-registry";
import { bundledAgents } from "../../src/rooms/contracts";
import { ROLE_MODEL_EFFORTS, ROLE_MODEL_OPTIONS, ROLE_TABLE, resolveRoleModel, roleModelKey } from "../../packages/models/src/role-models";
import { cliCommands, cliUsageText } from "../../src/rooms/tools/server/cli-commands";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { migrations } from "../../src/rooms/plugin-db";
import type { Phase, PlanItem, TaskFact } from "../../src/rooms/phase/logic";
import { phaseWorld, seedPhase, livePhase, ROADMAP, STATE } from "./r21-world";

const item = (id: string, wave: number, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});

describe("region 21 · project queries: the phase verbs", () => {
  it("[sma:k_t_entry] the one entry bb lane-pilot: an unknown verb exits 1 with a usage that names every registered command on its own line, and the help of a verb the hand list forgot is built from the registry", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    registerCli(createCore(bb, openDatabase(bb)), {} as never, migrations);
    const out = await harness.behavior.runCli(["no-such-verb"]);
    expect(out.exitCode).toBe(1);
    const verbs = cliCommands.map((command) => command.name);
    expect(verbs.length).toBeGreaterThan(40);
    for (const name of verbs) expect(out.stderr, name).toMatch(new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m"));
    // A verb that is registered but absent from the hand-written list is appended as «<usage>   (<summary>)»: nothing is left out of the help.
    const regress = cliCommands.find((command) => command.name === "regress")!;
    expect(cliUsageText.split("\n")).toContain(`${regress.usage.split("\n")[0]}   (${regress.summary})`);
    // The phase verbs this region's cards describe are all in it.
    for (const word of ["bb lane-pilot phase list", "show <phase-id> [--book]", "state <phase-id|--project id>", "roadmap <phase-id|--project id> [row]", "validate <phase-id|--project id>", "uat [--project <id>]"]) expect(cliUsageText, word).toContain(word);
  });

  it("[sma:k_t_shim] every call is a new run that starts from the stored state alone: the launcher is registered as lane-pilot, and a switch set in one call is read by the next", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    registerCli(createCore(bb, openDatabase(bb)), {} as never, migrations);
    expect(harness.registrations.cli?.name).toBe("lane-pilot");
    const status = async () => JSON.parse((await harness.behavior.runCli(["conveyor", "status"])).stdout!) as { on: boolean; reason?: string };
    const before = await status();
    expect(before.on).toBe(true);
    const off = await harness.behavior.runCli(["conveyor", "off", "deploy window"]);
    expect(off.exitCode).toBe(0);
    expect(await status()).toMatchObject({ on: false, reason: "deploy window" });
    expect(JSON.parse((await harness.behavior.runCli(["conveyor", "on"])).stdout!)).toMatchObject({ on: true });
    expect((await status()).on).toBe(true);
  });

  it("[sma:k_t_phase] a phase opened is one row in the book at discussion, listed by `phase list` with its stage, state and title; an empty book says so", async () => {
    const w = phaseWorld();
    expect(await w.cli("list")).toEqual({ exitCode: 0, stdout: "no phases" });
    const first = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Add the footer", goal: "a footer" });
    const second = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Fix the header", goal: "a header" });
    const listed = await w.cli("list");
    const line = (id: string, title: string) => `${id}  ${"discussion".padEnd(12)} ${"active".padEnd(15)} ${title}`;
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout!.split("\n").sort()).toEqual([line(first.id, "Add the footer"), line(second.id, "Fix the header")].sort());
    expect(livePhase(w, first.id)).toMatchObject({ stage: "discussion", state: "active", title: "Add the footer", goal: "a footer", projectId: "projA" });
    // A credential in a title is masked on the way into the book.
    const secret = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Use key sk-abcdefghijklmnopqrstuvwxyz0123", goal: "g" });
    expect(livePhase(w, secret.id).title).not.toContain("sk-abcdefghijklmnop");
  });

  it("[sma:k_t_uat] a UAT written before the numbered lines is judged by its checkboxes: the owner's yes is refused with the counts while a line is open or failed, and accepted when every line is ticked", async () => {
    const w = phaseWorld();
    const path = ".agents/phases/ph_r21/UAT.md";
    const id = seedPhase(w, { stage: "acceptance", record: { uat: { path, sha256: "s", at: 1 } } });
    const yes = () => w.phases.word({ phaseId: id, turn: "uat", decision: "yes", text: "да", by: "owner" });
    w.texts.set(path, "- [x] 1. login: works\n- [ ] 2. logout: not tried\n- [!] 3. reset: breaks\n");
    await expect(yes()).rejects.toThrow("UAT is not complete: 1 open, 1 failed of 3");
    w.texts.set(path, "- [x] 1. login: works\n- [x] 2. logout: works\n");
    await yes();
    expect(livePhase(w, id).record.words?.at(-1)).toMatchObject({ turn: "uat", decision: "yes" });
    // No UAT.md at all: refused, saying so.
    const bare = seedPhase(w, { id: "ph_bare", stage: "acceptance", record: { uat: { path: ".agents/phases/ph_bare/UAT.md", sha256: "s", at: 1 } } });
    await expect(w.phases.word({ phaseId: bare, turn: "uat", decision: "yes", text: "да", by: "owner" })).rejects.toThrow("UAT is not complete: no UAT.md");
  });

  it("[sma:k_t_verif] `phase show` names the verification state and the next command: a failed verdict says why and how to go back, a passed one asks for the goal audit, none yet says the checks run", async () => {
    const w = phaseWorld();
    const next = async (id: string) => (JSON.parse((await w.cli("show", id)).stdout!) as { next: { text: string; waitsForPm: boolean } }).next;
    const failed = seedPhase(w, { id: "ph_f", stage: "verification", record: { verification: { verdict: { state: "failed", detail: "npm test red", inputSha: "abc", mainSha: null } } } as never });
    const f = await next(failed);
    expect(f.waitsForPm).toBe(true);
    expect(f.text.startsWith("Phase ph_f «Sum» — stage 5, verification failed: npm test red.")).toBe(true);
    expect(f.text).toContain('{action:"return", phaseId:"ph_f", to:"planning", note');
    const passed = seedPhase(w, { id: "ph_p", stage: "verification", record: { verification: { verdict: { state: "passed", detail: "3 checks green", inputSha: "abc", mainSha: null } } } as never });
    const p = await next(passed);
    expect(p.waitsForPm).toBe(true);
    expect(p.text.startsWith("Phase ph_p «Sum» — stage 5, verification: the blind check passed (3 checks green). Run the goal audit")).toBe(true);
    const none = seedPhase(w, { id: "ph_n", stage: "verification" });
    expect(await next(none)).toMatchObject({ waitsForPm: false, text: "Phase ph_n «Sum» — stage 5, verification: Lane Pilot runs every piece's checks together on main." });
  });

  it("[sma:k_t_init] the inputs a stage's workflow starts with carry the phase's goal, folder, flag and pieces, and the stage's read-first paths are its own folder's files", () => {
    const phase = {
      id: "ph_draw", projectId: "p", pmThreadId: "thr", runId: "r", title: "T", goal: "g", stage: "design", state: "active", edition: 1, createdAt: 0, updatedAt: 0,
      record: { design: { decision: "needed", requirements: ["actions", "texts"] }, plan: { items: [item("p1", 1)] } },
    } as unknown as Phase;
    const off = autoInputs(phase, { kind: "draw" });
    expect(off).toMatchObject({ goal: "g", folder: ".agents/phases/ph_draw", material: false, requirements: "actions, texts" });
    expect(String(off.pieces)).toContain("p1");
    expect(autoInputs({ ...phase, record: { ...phase.record, drawMaterial: "on" } } as Phase, { kind: "draw" })).toMatchObject({ material: true });
    // The goal of an analysis carries the owner's «no» to the last context.
    const said = { ...phase, record: { words: [{ turn: "context", decision: "no", text: "too vague", by: "owner", at: 1 }] } } as unknown as Phase;
    expect(autoInputs(said, { kind: "analyze" }).goal).toBe("g\n\nThe owner said no to the last context: too vague");
    expect(autoInputs({ ...phase, record: {} } as Phase, { kind: "analyze" }).goal).toBe("g");
  });

  it("[sma:k_t_template] the prefilled plan names every piece under its wave with its promise, owned paths and checks; the verification sheet marks a piece whose latest fact failed", () => {
    const phase = { id: "ph_t", title: "Sum", goal: "sums", record: { plan: { items: [item("a", 1), item("b", 2)] } } } as unknown as Pick<Phase, "id" | "title" | "goal" | "record">;
    const plan = templateFill("PLAN", phase, new Map());
    const lines = plan.split("\n");
    expect(lines).toContain("# Plan — phase ph_t: Sum");
    expect(lines).toContain("Goal: sums");
    expect(lines.indexOf("### Wave 1")).toBeLessThan(lines.indexOf("- a: given g; when w; then then-a"));
    expect(lines.indexOf("- a: given g; when w; then then-a")).toBeLessThan(lines.indexOf("### Wave 2"));
    expect(lines).toContain("  owns: src/**");
    expect(lines).toContain("  checks: npm test");
    const facts = new Map<string, TaskFact>([["a", { taskId: "a", state: "accepted", planFact: "passed", verification: "failed", codeCritique: "passed", browserQa: "passed", qaPlanned: false }]]);
    const verification = templateFill("VERIFICATION", phase, facts);
    expect(verification).toContain("a");
    expect(verification).not.toBe(templateFill("VERIFICATION", phase, new Map()));
  });

  it("[sma:k_t_verify] `phase show` reports the plan gate: a piece whose task id differs, with no owned paths or no check is named line by line; a sound plan has none of these lines", async () => {
    const w = phaseWorld();
    const bad: PlanItem = { ...item("p1", 1), task: { id: "other", verification: [], acceptance: [] } };
    const id = seedPhase(w, { stage: "planning", record: { plan: { items: [bad, item("p2", 1)], contextSha: "ctx", sha: "x", objective: "o", premortem: ["a", "b", "c"] } } as never });
    const gates = async () => (JSON.parse((await w.cli("show", id)).stdout!) as { gates: { plan: { ok: boolean; why: string[] } } }).gates.plan;
    const plan = await gates();
    expect(plan.ok).toBe(false);
    expect(plan.why).toEqual(expect.arrayContaining([
      "p1: the task id must equal the piece id",
      "p1: no owns_paths — the piece cannot become a work",
      "p1: no verification command — nothing proves the promise",
    ]));
    expect(plan.why.filter((line) => line.startsWith("p2:"))).toEqual([]);
    expect(pieceProblems(item("p2", 1))).toEqual([]);
    expect(pieceProblems({ ...item("p3", 1), promise: { given: "g", when: " ", then: "t" } })).toEqual(["p3: the promise has no «when»"]);
    expect(pieceProblems({ ...item("p4", 1), task: { ...item("p4", 1).task, acceptance: ["`npm run lint` is clean"] } }).join("\n")).toContain("names `npm run lint`, which is not a verification command");
  });

  it("[sma:k_t_phase_index] the plan inventory: the waves are the distinct wave numbers in order, each with its pieces in plan order, and the pieces to issue come earliest wave first", () => {
    const items = [item("c", 3), item("a", 1), item("b", 2), item("a2", 1)];
    expect(wavesOf(items)).toEqual([1, 2, 3]);
    expect(wavesOf([])).toEqual([]);
    expect(piecesOfWave(items, 1).map((piece) => piece.id)).toEqual(["a", "a2"]);
    expect(piecesOfWave(items, 4)).toEqual([]);
    expect(issuable(items, {}, new Map()).map((piece) => piece.id)).toEqual(["a", "a2", "b", "c"]);
  });

  it("[sma:k_t_workstream] parallel streams: two phases on different roadmap rows run side by side and are listed; a third on a held row is refused by name; pausing one leaves the other active", async () => {
    const w = phaseWorld();
    const one = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "One", goal: "g1", roadmapRow: "row-1" });
    const two = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Two", goal: "g2", roadmapRow: "row-2" });
    const row = (id: string, state: string, title: string) => `${id}  ${"discussion".padEnd(12)} ${state.padEnd(15)} ${title}`;
    expect((await w.cli("list")).stdout!.split("\n").sort()).toEqual([row(one.id, "active", "One"), row(two.id, "active", "Two")].sort());
    await expect(w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Three", goal: "g3", roadmapRow: "row-1" }))
      .rejects.toThrow(`roadmap row row-1 already has a live phase: ${one.id} «One» — work with that one, or close it first`);
    // The refusal reaches the CLI-free caller as the same sentence; a different row is free.
    await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Three", goal: "g3", roadmapRow: "row-3" });
    await w.cli("pause", one.id);
    const after = (await w.cli("list")).stdout!.split("\n");
    expect(after).toContain(row(one.id, "paused", "One"));
    expect(after).toContain(row(two.id, "active", "Two"));
    await w.cli("resume", one.id);
    expect((await w.cli("list")).stdout!.split("\n")).toContain(row(one.id, "active", "One"));
  });

  it("[sma:k_t_state] `phase state` prints STATE.md as written; a flag adds one command-owned line and the answer counts the position, decisions and blockers; nothing is invented where no planning files live", async () => {
    const w = phaseWorld();
    const id = seedPhase(w);
    expect(await w.cli("state", id)).toEqual({ exitCode: 0, stdout: "no STATE.md" });
    expect(await w.cli("state", id, "--decision", "x")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("no planning STATE.md and no ROADMAP.md") });
    expect(w.texts.has(STATE)).toBe(false);
    const hand = "---\nphase: 1\nstage: execution\n---\n# State\n\n## Decisions\n- chose sqlite, do not change\n";
    w.texts.set(STATE, hand);
    expect(await w.cli("state", id)).toEqual({ exitCode: 0, stdout: hand });
    const first = await w.cli("state", id, "--decision", "use WAL", "--blocker", "waits on api");
    expect(first.exitCode).toBe(0);
    const lines = (text: string) => text.split("\n");
    expect(lines(first.stdout!)).toEqual(expect.arrayContaining(["- chose sqlite, do not change", "## Decisions (Lane Pilot)", "- manual: use WAL", "## Blockers", "- manual: waits on api"]));
    const second = await w.cli("state", id, "--decision", "second");
    expect(lines(second.stdout!)).toEqual(expect.arrayContaining(["- chose sqlite, do not change", "- manual: use WAL", "- manual: second", "- manual: waits on api"]));
    expect((await w.cli("state", id)).stdout).toBe(second.stdout);
    // The person's own lines are never rewritten: the file still starts with them.
    expect(w.texts.get(STATE)!.startsWith("---\nphase: 1\nstage: execution\n")).toBe(true);
    expect(await w.cli("state", id, "--set", "bad key=1")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--set takes key=value") });
  });

  it("[sma:k_t_roadmap] `phase roadmap` prints one row's section, or the rows ticked without SUMMARY.md, the phase folders with no row and the next open row; a missing row exits 1, a missing file is refused", async () => {
    const w = phaseWorld();
    const id = seedPhase(w, { record: { roadmapRow: "1" } });
    expect(await w.cli("roadmap", id)).toMatchObject({ exitCode: 1, stderr: "the project has no .agents/planning/ROADMAP.md" });
    w.texts.set(ROADMAP, "- [x] 1 First — g1\n  - note a\n  - note b\n- [ ] 2 Second — g2\n");
    expect(await w.cli("roadmap", id, "1")).toEqual({ exitCode: 0, stdout: "- [x] 1 First — g1\n  - note a\n  - note b" });
    expect(await w.cli("roadmap", id, "9")).toEqual({ exitCode: 1, stdout: "no row 9" });
    expect(await w.cli("roadmap", id)).toEqual({ exitCode: 0, stdout: `ticked without SUMMARY.md: 1 First (phase ${id})\nphase folders with no row: none\nnext open row: 2 Second` });
    w.texts.set(`.agents/phases/${id}/SUMMARY.md`, "done");
    expect((await w.cli("roadmap", id)).stdout!.split("\n")[0]).toBe("ticked without SUMMARY.md: none");
  });

  it("[sma:k_t_audit_uat] `phase uat` lists every open and failed acceptance line of every phase, one per line, and exits 1 while any remain; nothing open exits 0", async () => {
    const w = phaseWorld();
    expect(await w.cli("uat")).toEqual({ exitCode: 0, stdout: "no open acceptance lines" });
    const a = seedPhase(w, { id: "ph_a", stage: "acceptance", record: { uat: { path: ".agents/phases/ph_a/UAT.md", sha256: "s", at: 1 } } });
    w.texts.set(".agents/phases/ph_a/UAT.md", "- [ ] 1. p1: line open\n- [!] 2. p2: line failed\n- [x] 3. p3: done\n");
    const b = seedPhase(w, { id: "ph_b", stage: "acceptance", record: { uat: { path: ".agents/phases/ph_b/UAT.md", sha256: "s", at: 1 } } });
    w.texts.set(".agents/phases/ph_b/UAT.md", "- [x] 1. p1: done\n");
    const out = await w.cli("uat");
    expect(out.exitCode).toBe(1);
    expect(out.stdout!.split("\n").sort()).toEqual([`${a}  open   1. p1: line open`, `${a}  failed 2. p2: line failed`].sort());
    expect(out.stdout).not.toContain(b);
    w.texts.set(".agents/phases/ph_a/UAT.md", "- [x] 1. p1: ok\n- [x] 2. p2: ok\n");
    expect(await w.cli("uat")).toEqual({ exitCode: 0, stdout: "no open acceptance lines" });
  });

  it("[sma:k_t_validate] `phase validate` names each finding on its own line: a duplicated or skipped roadmap row, a ticked row with no SUMMARY.md, a phase folder with no row; a roadmap that agrees is healthy up to the agents", async () => {
    const w = phaseWorld();
    const id = seedPhase(w, { record: { roadmapRow: "1" } });
    const agents = Object.keys(bundledAgents).map((name) => `bundled agent not installed: ${name}`);
    const healthy = () => { for (const name of Object.keys(bundledAgents)) w.texts.set(`.claude/agents/${name}.md`, "agent\n"); };
    expect(await w.cli("validate", id)).toEqual({ exitCode: 1, stdout: ["the project has no .agents/planning/ROADMAP.md", ...agents].join("\n") });
    healthy();
    w.texts.set(ROADMAP, "- [ ] 1 first\n- [ ] 2 second\n- [x] 2 second again\n- [ ] 4 fourth\n");
    expect(await w.cli("validate", id)).toEqual({ exitCode: 1, stdout: ["duplicate roadmap row 2", "skipped roadmap row(s) between 2 and 4"].join("\n") });
    w.texts.set(ROADMAP, "- [ ] 1 first\n- [ ] 2 second\n");
    expect(await w.cli("validate", id)).toEqual({ exitCode: 0, stdout: "planning files healthy" });
    w.texts.set(ROADMAP, "- [x] 1 first\n");
    expect(await w.cli("validate", id)).toEqual({ exitCode: 1, stdout: `ticked without SUMMARY.md: 1 first (phase ${id})` });
  });

  it("[sma:k_t_learnings] a lesson the owner applies to a phase goes through the memory door as a note of its project and is listed from another project's question; one that does not match is not", async () => {
    const w = phaseWorld();
    const id = seedPhase(w, { stage: "lessons", record: { lessons: { why: "closed", draft: { text: "keep the migrations small and reversible", state: "staged", at: 1 } } } as never });
    const learning = createLearning(w.core as never, {} as never);
    expect(JSON.stringify(await learning.run("lessons", { text: "migrations small" }))).not.toContain("projA");
    await w.phases.word({ phaseId: id, turn: "lesson", decision: "yes", text: "да", by: "owner" });
    expect(livePhase(w, id).record.lessons?.draft).toMatchObject({ state: "applied" });
    const row = w.db.prepare("SELECT project_id, kind, origin, content FROM lane_pilot_memory WHERE origin = 'phase-lessons'").all();
    expect(row).toEqual([{ project_id: "projA", kind: "note", origin: "phase-lessons", content: "keep the migrations small and reversible" }]);
    const found = JSON.parse((await runLearningCli(learning, ["lessons", "migrations", "small"])).stdout!);
    expect(JSON.stringify(found)).toContain("keep the migrations small and reversible");
    expect(JSON.stringify(found)).toContain("projA");
    expect(JSON.stringify(JSON.parse((await runLearningCli(learning, ["lessons", "kubernetes"])).stdout!))).not.toContain("projA");
    // A declined draft writes nothing more.
    const other = seedPhase(w, { id: "ph_no", stage: "lessons", record: { lessons: { why: "closed", draft: { text: "never store this", state: "staged", at: 1 } } } as never });
    await w.phases.word({ phaseId: other, turn: "lesson", decision: "no", text: "нет", by: "owner" });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory WHERE origin = 'phase-lessons'").get()).toEqual({ n: 1 });
  });
});

describe("region 21 · project queries: models, skills, config, capabilities, files", () => {
  it("[sma:k_t_resolve] the model of a role: the owner's table row wins, then a legacy stage selection, then the built-in default; a selection below the role's least tier is passed over for the default", () => {
    expect(resolveRoleModel("code-critic", {})).toEqual({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium", source: "default", sourceKey: null });
    expect(resolveRoleModel("auditor", {})).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", effort: "high", source: "default" });
    const row = resolveRoleModel("code-critic", { [roleModelKey("code-critic")]: { model: "claude-opus-5-5", reasoning_effort: "xhigh" } });
    expect(row).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", effort: "xhigh", source: "table", sourceKey: "role_model.code-critic" });
    const stage = { "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra", "code_critique.reasoning_effort": "low" };
    expect(resolveRoleModel("code-critic", stage)).toEqual({ providerId: "codex", model: "gpt-6.1-terra", effort: "low", source: "stage", sourceKey: "code_critique.model" });
    expect(resolveRoleModel("code-critic", { ...stage, [roleModelKey("code-critic")]: { model: "claude-sonnet-5-5" } })).toMatchObject({ model: "claude-sonnet-5-5", source: "table" });
    expect(resolveRoleModel("code-critic", { "code_critique.provider": "codex", "code_critique.model": "gpt-6-luna" })).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", source: "default", escalated: true });
  });

  it("[sma:k_t_catalog] the catalog of the table: every role has a built-in model that is one of the offered models and an effort the table offers; the offered models are listed with provider, family and tier", () => {
    const ids = new Set(ROLE_MODEL_OPTIONS.map((option) => option.id));
    expect(ROLE_TABLE.length).toBeGreaterThan(20);
    for (const row of ROLE_TABLE) {
      expect(ids.has(row.default.model), row.id).toBe(true);
      expect((ROLE_MODEL_EFFORTS as readonly string[]).includes(row.default.effort), row.id).toBe(true);
      expect(row.default.why.length, row.id).toBeGreaterThan(10);
    }
    const defaults = Object.fromEntries(["analyst", "planner", "copy-lead", "code-critic", "auditor"].map((role) => { const row = ROLE_TABLE.find((entry) => entry.id === role)!; return [role, `${row.default.model}:${row.default.effort}`]; }));
    expect(defaults).toEqual({ analyst: "claude-opus-5-5:high", planner: "claude-opus-5-5:high", "copy-lead": "claude-sonnet-5-5:high", "code-critic": "router9/ag/gemini-3.8-flash-high:medium", auditor: "gpt-6.1-sol:high" });
    expect(ROLE_MODEL_OPTIONS.map((option) => `${option.id}|${option.providerId}|${option.family}|${option.tier}`)).toEqual([
      "claude-fable-5-1|claude-code|claude|strong", "claude-opus-5-5|claude-code|claude|strong", "claude-sonnet-5-5|claude-code|claude|standard", "claude-haiku-5-5|claude-code|claude|light",
      "gpt-6.1-sol|codex|gpt|strong", "gpt-6.1-terra|codex|gpt|standard", "gpt-6-astra|codex|gpt|strong", "gpt-6-luna|codex|gpt|light",
      "router9/ag/gemini-3.8-flash-high|opencode2|google|standard", "gemini-4-hydrogen|acp-antigravity|google|standard", "gemini-4-argon|acp-antigravity|google|strong",
      "glm-5.3-flash-free|zcode|glm|light",
    ]);
  });

  it("[sma:k_t_agent_skills] the skills a writer is given for a task: a name the BB list holds, once, at most eight; a name outside the list and a repeat are dropped; a project folder's own skill is added", () => {
    const catalog = ["alpha-skill", "beta-skill", "gamma-skill", "delta-skill", "eps-skill", "zeta-skill", "eta-skill", "theta-skill", "iota-skill", "plugin:alpha-skill", "lane-pilot"].map((name) => ({ name, description: "d" }));
    expect(declaredSkills(catalog, ["alpha-skill", "ghost-skill", "alpha-skill", "beta-skill"])).toEqual(["alpha-skill", "beta-skill"]);
    expect(declaredSkills(catalog, [])).toEqual([]);
    expect(declaredSkills(catalog, ["ghost-skill"])).toEqual([]);
    const nine = ["alpha-skill", "beta-skill", "gamma-skill", "delta-skill", "eps-skill", "zeta-skill", "eta-skill", "theta-skill", "iota-skill"];
    expect(declaredSkills(catalog, nine)).toEqual(nine.slice(0, 8));
    expect(projectFolderSkills("/home/u/BB-service/lane-pilot", catalog)).toEqual(["lane-pilot"]);
    expect(projectFolderSkills("/home/u/other/place", catalog)).toEqual([]);
  });

  it("[sma:k_t_commit] the phase documents are committed by an explicit list of paths: only those files enter the commit, a second call with nothing changed commits nothing, an empty list commits nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-r21-commit-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    mkdirSync(join(root, ".agents/planning"), { recursive: true });
    writeFileSync(join(root, "README.md"), "base\n"); git("add", "."); git("commit", "-q", "-m", "base");
    writeFileSync(join(root, ".agents/planning/STATE.md"), "state\n");
    writeFileSync(join(root, "other.ts"), "not mine\n");
    expect(await commitDocs({ projectCwd: root, paths: [], message: "docs: none" })).toEqual({ status: "nothing", commit: null, reason: null });
    const done = await commitDocs({ projectCwd: root, paths: [".agents/planning/STATE.md"], message: "docs: state" });
    expect(done).toEqual({ status: "committed", commit: git("rev-parse", "HEAD"), reason: null });
    expect(git("log", "-1", "--format=%s")).toBe("docs: state");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe(".agents/planning/STATE.md");
    expect(git("status", "--short")).toBe("?? other.ts");
    expect(await commitDocs({ projectCwd: root, paths: [".agents/planning/STATE.md"], message: "docs: again" })).toEqual({ status: "nothing", commit: null, reason: null });
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("[sma:k_t_config] a setting is read back as saved and written only when the value passes: an out-of-range or stale write is refused and the stored value stays; an unset key reads nothing", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const key = "code_critique.max_rounds";
    expect(loadProjectSettings(db, "p")[key]).toBeUndefined();
    for (const [value, problem] of [[0, "integer 1-3"], [4, "integer 1-3"], ["x", "integer 1-3"], [1.5, "integer 1-3"]] as const) expect(validateSettingValue(key, value), String(value)).toEqual({ code: "invalid_choice", key, params: [key, problem] });
    for (const value of [1, 2, 3, "2"]) expect(validateSettingValue(key, value), String(value)).toBeNull();
    const refused = casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 4, expectedVersion: 0 }] });
    expect(refused).toMatchObject({ ok: false, validation: { code: "invalid_choice" } });
    expect(loadProjectSettings(db, "p")[key]).toBeUndefined();
    expect(casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 2, expectedVersion: 0 }] }).ok).toBe(true);
    expect(loadProjectSettings(db, "p")[key]).toBe(2);
    expect(casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 3, expectedVersion: 0 }] })).toMatchObject({ ok: false, conflict: true });
    expect(loadProjectSettings(db, "p")[key]).toBe(2);
  });

  it("[sma:k_t_capreg] the registry lists one feature per bundled agent with its own agent and skills for each runtime, plus the session guard with its hook streams; every name in it is shipped", () => {
    const registry = featureRegistry();
    const agents = bundledAgents as Record<string, { skills?: string[] }>;
    expect(registry.map((feature) => feature.id)).toEqual([...Object.keys(agents), "session-guard"]);
    for (const [id, agent] of Object.entries(agents)) {
      const feature = registry.find((entry) => entry.id === id)!;
      expect(feature.agents, id).toEqual({ claude: [id], opencode: [id] });
      expect(feature.skills, id).toEqual({ claude: agent.skills ?? [], opencode: agent.skills ?? [] });
      expect(feature.hooks, id).toEqual({});
    }
    const guard = registry.find((feature) => feature.id === "session-guard")!;
    expect(guard.agents).toEqual({});
    expect(guard.hooks.claude?.length).toBeGreaterThan(0);
    expect(guard.hooks.opencode?.length).toBeGreaterThan(0);
    expect(featureRegistryGaps(registry)).toEqual([]);
    expect(featureRegistryGaps([...registry, { id: "made-up", agents: { claude: ["no-such-agent"] }, skills: { opencode: ["no-such-skill"] }, hooks: { claude: ["no-such-hook"] } }]))
      .toEqual(["made-up: unknown agent no-such-agent", "made-up: unknown hook no-such-hook", "made-up: unknown skill no-such-skill"]);
  });

  it("[sma:k_t_capstate] `bb lane-pilot capabilities` prints the provider table as written and exits 1 when any capability is not supported; an all-proven or unproven table exits 0; extra words are refused", async () => {
    const table = (state: string) => [{ providerId: "codex", version: "0.1.0", capabilities: { answers: "supported", pause: state } }];
    const api = (rows: unknown) => ({ table: async () => rows, sweep: async () => [{ providerId: "codex", capability: "answers", state: "supported" }] }) as never;
    const ok = await runCapabilityCli(api(table("supported")), []);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout!)).toEqual({ table: table("supported") });
    expect((await runCapabilityCli(api(table("unproven")), [])).exitCode).toBe(0);
    const red = await runCapabilityCli(api(table("not_supported")), []);
    expect(red.exitCode).toBe(1);
    expect(JSON.parse(red.stdout!)).toEqual({ table: table("not_supported") });
    const probed = await runCapabilityCli(api(table("supported")), ["--probe"]);
    expect(JSON.parse(probed.stdout!)).toEqual({ probed: [{ providerId: "codex", capability: "answers", state: "supported" }], table: table("supported") });
    expect((await runCapabilityCli(api([]), ["--bogus"])).exitCode).toBe(1);
    expect(JSON.parse((await runCapabilityCli(api([]), [])).stdout!)).toEqual({ table: [] });
  });

  it("[sma:k_t_frontmatter] the verb `frontmatter` reads a file's header as values and writes only the keys it is told to, keeping every other byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-r21-front-"));
    const file = join(dir, "page.md");
    writeFileSync(file, "---\ntitle: \"A: b\"\n# why\ntags: [x]\n---\n\n# Body\n");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const { savePrototypeConfig } = await import("../../src/rooms/storage");
    savePrototypeConfig(db, { projectId: "p1", hostId: "h", pmWorkspacePath: dir, writerWorkspacePath: dir, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
    const core = createCore(bb, db) as unknown as { host: unknown };
    const { runCommandOnHost } = await import("../../src/rooms/writer/cli-run");
    core.host = { call: async (_method: string, input: Parameters<typeof runCommandOnHost>[0]) => runCommandOnHost(input) };
    registerCli(core as never, {} as never, migrations);
    const run = (...args: string[]) => harness.behavior.runCli(["frontmatter", "p1", ...args]);
    const read = await run("page.md");
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout!)).toEqual({ title: "A: b", tags: ["x"] });
    expect((await run("page.md", "--set", "status=done", "--merge", "tags=y")).exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("---\ntitle: \"A: b\"\n# why\ntags: [x, y]\nstatus: done\n---\n\n# Body\n");
    expect((await run("../x.md", "--set", "a=b")).exitCode).toBe(1);
  });
});
