import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { pureActionExecutor } from "@lane-pilot/workflow-engine";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { ROLE_TABLE, roleModelOption, tableRowAt } from "@lane-pilot/models";
import { BOOKKEEPING_EXCLUDE_LINES } from "@lane-pilot/settings-catalog";
import { openDatabase, createRun } from "../../src/rooms/plugin-db";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseReactions } from "../../src/rooms/core/server";
import { createPhaseDriver } from "../phase-driver";
import { savePhase } from "../../src/rooms/phase/store";
import { planGate, type Phase, type PhaseRecord } from "../../src/rooms/phase/logic";
import { PLAN_ROUNDS_MAX, STAGE_RUBRICS, piecePlan, stageInit, uiContractGap } from "../../src/rooms/phase/stages";
import { autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { installDocs } from "../../src/rooms/phase/server/driver-docs";
import { lintCitationClaims } from "../../src/rooms/docs/docs-lint";
import { effectiveGroup, ROLE_PROFILES } from "../../src/rooms/contracts/helper-context";
import { hashBytes, transitionOwned, type NativeInstallManifest } from "../../src/rooms/native-install/native-install-owned";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { excludeBookkeeping } from "../../src/rooms/verification/server/bookkeeping-exclude";
import { pmResumeInstructions } from "../../src/rooms/learning/pm-rules";
import { writerBriefSegments, writerToolLine } from "../../src/rooms/writer/server/writer-task";
import { buildCapsule, capsuleRestored, sessionEndDraft, sessionStartText } from "../../src/rooms/session-hooks/logic";
import { buildHandoffBrief } from "../../src/rooms/writer/server/writer-handoff";
import { goalVerdict } from "../../src/rooms/run-goal/logic";
import type { Services } from "../../server";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const WORKSPACE = "/ws";

const workflow = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { entry?: string; nodes?: Array<Record<string, unknown>> | Record<string, Record<string, unknown>> };
const nodes = (name: string): Array<Record<string, unknown>> => {
  const value = workflow(name).nodes;
  return Array.isArray(value) ? value : Object.values(value ?? {});
};
const node = (name: string, id: string) => nodes(name).find((row) => row.id === id)!;

const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind: "feature", title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { bb, harness, db, ctx, phases };
}

type Row = Record<string, unknown>;
/** Runs a code action the way the engine does: the node lists what it reads, `resolve` answers by reference. */
const act = async (action: string, reads: string[], values: Record<string, unknown>) => {
  const ctx = { node: { type: "action", action, reads, params: {} }, resolve: (ref: string) => values[ref], template: (value: unknown) => value } as unknown as StepContext;
  return (await pureActionExecutor(action).run(ctx)) as { output: Row };
};

const hookCli = (payload: Record<string, unknown>, home: string) => spawnSync(
  process.execPath, ["--experimental-strip-types", "src/rooms/session-hooks/cli.ts"],
  { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home } },
);

describe("agent roles and maps (c2)", () => {
  it("[sma:k_ag_uiresearcher] uiContractGap names the missing required sections of UI-SPEC.md and passes when every heading is there", () => {
    const record = (requirements: string[]) => ({
      design: { decision: "needed", drawing: { paths: ["x/design/UI-SPEC.md"], sha256: "s" }, requirements },
    }) as unknown as PhaseRecord;
    const spec = "# Spec\n\n## Actions\n\n## Accessibility notes\n";
    expect(uiContractGap(record(["actions", "accessibility"]), spec)).toBeNull();
    const gap = uiContractGap(record(["actions", "accessibility"]), "# Spec\n\n## Actions\n");
    expect(gap).toContain("misses required section(s): accessibility");
    // A drawing with no contract file at all is refused too.
    const noContract = { design: { decision: "needed", drawing: { paths: ["x/design/a.html"], sha256: "s" }, requirements: [] } } as unknown as PhaseRecord;
    expect(uiContractGap(noContract)).toContain("no contract");
  });

  it("[sma:k_ag_docverifier] lintCitationClaims reads the cited lines of the live code and reports a claim whose identifier is absent, with no model", async () => {
    const page = (text: string) => [{ path: "docs/components/widget.md", content: `---\ntitle: Widget\ntype: component\n---\n\n${text}\n` }];
    const claim = "The `parseThing` helper builds the row src/parser.ts:3-5.";
    const read = (found: boolean) => async () => found ? "line\nconst parseThing = () => 1\nline" : "line\nconst other = 1\nline";
    const findings = await lintCitationClaims(page(claim), read(false));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "docs/components/widget.md", rule: "evidence" });
    expect(findings[0]!.detail).toContain("parseThing");
    expect(await lintCitationClaims(page(claim), read(true))).toEqual([]);
  });

  it("[sma:k_ag_mapper] analyze-code explores one scope and writes the map document itself", () => {
    const analyze = node("analyze-code", "analyze");
    expect(analyze).toMatchObject({ type: "subworkflow", workflow: "lp.analyze" });
    expect((analyze.with as Row).scope).toBe("{{$inputs.scope}}");
    const report = node("analyze-code", "report");
    expect(report).toMatchObject({ action: "fs.write" });
    expect(String(report.path)).toMatch(/^reports\//);
    expect(String(report.template)).toContain("anchors");
  });

  it("[sma:k_ag_assumptions] grill-plan reads the code: every question cites file:line and the synthesis separates locked, open and contradicted", () => {
    const walk = String(node("grill-plan", "walk").prompt);
    expect(walk).toContain("file:line");
    expect(walk).toContain("a question without it is not a question");
    const synth = String(node("grill-plan", "synth").prompt);
    expect(synth).toContain("Locked");
    expect(synth).toContain("Open");
    expect(synth).toContain("assumes that the code contradicts");
  });

  it("[sma:k_ag_synth] web-research merges the parallel researchers into one written report", () => {
    expect(node("web-research", "search").type).toBe("parallel");
    const report = node("web-research", "report");
    expect((report.consumes as Row[])[0]).toMatchObject({ from: "claims" });
    expect(node("web-research", "check").action).toBe("citations.check");
    expect(node("web-research", "deliver").action).toBe("fs.write");
  });

  it("[sma:k_ag_roadmapper] dag.validate refuses requirements mapped to no session or to two, and names a cycle", async () => {
    const { output } = await act("dag.validate", ["roadmap.sessions", "roadmap.requirement_map"], {
      "roadmap.sessions": [
        { id: "s1", depends_on: [] },
        { id: "s2", depends_on: ["s3"] },
        { id: "s3", depends_on: ["s2"] },
      ],
      "roadmap.requirement_map": { R1: [], R2: ["s1", "s2"] },
    });
    expect(output.ok).toBe(false);
    expect(output.errors).toEqual(expect.arrayContaining([
      "requirement R1 maps to no session",
      expect.stringContaining("R2 maps to 2 sessions"),
    ]));
    expect((output.cycles as string[]).some((cycle) => cycle.includes("s2") && cycle.includes("s3"))).toBe(true);
  });

  it("[sma:k_ag_resolve] effectiveGroup gives a role its profile's skills and an owner's allow list wins", () => {
    expect(effectiveGroup("writer", "skills")).toEqual({ names: ROLE_PROFILES.writer.skills, source: "role" });
    expect(effectiveGroup("writer", "skills", { skills: { mode: "allow", names: ["only-this"] } }))
      .toEqual({ names: ["only-this"], source: "owner" });
  });
});

describe("install, memory and rules (c2)", () => {
  it("[sma:k_lib_deleteme] enable then remove leaves the home tree byte-identical, and a changed owned file is preserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-root-"));
    const home = mkdtempSync(join(tmpdir(), "lp-home-"));
    const payload = Buffer.from("payload-bytes");
    writeFileSync(join(root, "tool"), payload);
    const manifest: NativeInstallManifest = {
      schemaVersion: 1, home, sourceSha: "s",
      files: [{ path: "bin/tool", payload: "tool", mode: 0o755, hash: hashBytes(payload) }],
      json: [{ path: "settings.json", key: ["hooks"], value: [{ command: "x" }], array: true, existed: false, parents: [] }],
      blocks: [{ path: "config.txt", text: "managed line" }],
      preserved: [], createdConfigs: ["settings.json", "config.txt"], createdDirs: [], state: "prepared",
    };
    const snapshot = (dir: string) => Object.fromEntries(
      (function walk(base: string, rel: string): string[] {
        return readdirSync(join(base, rel), { withFileTypes: true }).flatMap((entry) => {
          const at = join(rel, entry.name);
          return entry.isDirectory() ? walk(base, at) : [at];
        });
      })(dir, "").map((rel) => [rel, createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex")]),
    );
    const before = snapshot(home);
    await transitionOwned(root, manifest, "enable");
    expect(readFileSync(join(home, "bin/tool"))).toEqual(payload);
    await transitionOwned(root, manifest, "remove");
    expect(snapshot(home)).toEqual(before);
    await transitionOwned(root, manifest, "enable");
    writeFileSync(join(home, "bin/tool"), "the person edited it");
    await expect(transitionOwned(root, manifest, "remove")).rejects.toThrow(/preserved/);
  });

  it("[sma:k_in_hooktable] materializeNativeHookSession covers the session events and every command is an absolute path", async () => {
    const dest = mkdtempSync(join(tmpdir(), "lp-hooks-"));
    const { settingsPath } = await materializeNativeHookSession({ destDir: dest });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const event of ["PreToolUse", "SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStop", "PostToolUse"]) {
      const groups = settings.hooks[event] ?? [];
      expect(groups.length, event).toBeGreaterThan(0);
      for (const group of groups) for (const hook of group.hooks) expect(hook.command, `${event}: ${hook.command}`).toMatch(/(^|\s)['"]?\//);
    }
  });

  it("[sma:k_in_dirs] excludeBookkeeping adds the bookkeeping lines to info/exclude once, and .gitignore stays untouched", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-repo-"));
    execFileSync("git", ["init", "-q", repo]);
    const runCommand = async (input: { command: string; cwd: string }) => {
      const ran = spawnSync("sh", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" });
      return { exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    };
    const first = await excludeBookkeeping(runCommand, "h1", repo, () => undefined);
    expect(first.sort()).toEqual([...BOOKKEEPING_EXCLUDE_LINES].sort());
    expect(await excludeBookkeeping(runCommand, "h1", repo, () => undefined)).toEqual([]);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("[sma:k_in_memory] a fresh database has the memory table and its empty index, and a note survives", () => {
    const { db } = world();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('lane_pilot_memory','lane_pilot_memory_fts')").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(["lane_pilot_memory", "lane_pilot_memory_fts"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory").get() as { n: number }).toEqual({ n: 0 });
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('m1','p','note','owner','keep this','[]','s',1)").run();
    expect((db.prepare("SELECT content FROM lane_pilot_memory WHERE id='m1'").get() as { content: string }).content).toBe("keep this");
  });

  it("[sma:k_in_rules] pmResumeInstructions returns the project's PM rule in the block, null without one, and writes no file", () => {
    const { db } = world();
    const before = readdirSync(process.cwd());
    expect(pmResumeInstructions(db, "proj-rules", [])).toBeNull();
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('mem-pm','proj-rules','','core','subagent','Never plan past the signed context','[\"rule\"]','s',1)").run();
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience)
      VALUES ('r-pm','proj-rules','s','Never plan past the signed context','owner','accepted',1,1,'[]','mem-pm',1,1,1,1,'pm')`).run();
    const text = pmResumeInstructions(db, "proj-rules", []);
    expect(text).toContain("Never plan past the signed context");
    expect(readdirSync(process.cwd())).toEqual(before);
  });

  it("[sma:k_st_claudemd] writerBriefSegments carries rules and project memory as tagged data and touches no CLAUDE.md", () => {
    const segments = writerBriefSegments(contract("seg"), "remember the api", "", undefined, "Lane Pilot writer", "", "lockfile rule");
    const text = segments.map((segment) => segment.text).join("\n");
    expect(text).toContain("<project_memory>");
    expect(text).toContain("remember the api");
    expect(text).toContain("<rules>");
    expect(text).toContain("lockfile rule");
    expect(segments.find((segment) => segment.text.includes("<rules>"))?.hidden).toBe(true);
    expect(text).not.toContain("CLAUDE.md");
  });

  it("[sma:k_lib_scaffold] the scaffold is the memory table with its concepts and the empty full-text index, seeded with nothing", () => {
    const { db } = world();
    const columns = (db.prepare("PRAGMA table_info(lane_pilot_memory)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain("concepts_json");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='lane_pilot_memory_fts'").get()).toBeTruthy();
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts").get() as { n: number }).n).toBe(0);
  });
});

describe("session continuity and phases (c2)", () => {
  it("[sma:k_v_flight] the capsule is restored after compaction and the handoff brief carries stop reason, git status, the failing command and messages within the cap", () => {
    const capsule = buildCapsule({ asks: ["ship it"], files: ["src/a.ts"], claims: ["src/a.ts"], trigger: "precompact" });
    const restored = capsuleRestored(capsule);
    expect(restored).toMatch(/^Capsule restored after compaction:/);
    expect(sessionStartText({ capsule })).toContain(restored);
    const brief = buildHandoffBrief({
      stopReason: "provider limit",
      gitStatus: " M src/a.ts\n src/a.ts | 2 +-",
      events: [
        { data: { item: { type: "agentMessage", text: "almost done" } } },
        { data: { item: { type: "commandExecution", command: "npm test", exitCode: 1, aggregatedOutput: "1 failed" } } },
      ],
    }, 2_000);
    expect(brief).toContain("Stop reason: provider limit");
    expect(brief).toContain("git status --short");
    expect(brief).toContain("Last failing command (exit 1): npm test");
    expect(brief).toContain("almost done");
    expect(brief.length).toBeLessThanOrEqual(2_000);
  });

  it("[sma:k_t_init] autoInputs for draw hands the goal, folder, requirements and pieces, and stageInit lists the stage's read-first paths", () => {
    const phase = {
      id: "ph_draw", projectId: "p", pmThreadId: "thr", runId: "r", title: "T", goal: "g", stage: "design", state: "active", edition: 1, createdAt: 0, updatedAt: 0,
      record: {
        design: { decision: "needed", requirements: ["actions", "texts"] },
        plan: { items: [{ id: "p1", title: "Screen", wave: 1, covers: [], promise: { given: "g", when: "w", then: "t" }, task: {} }] },
      },
    } as unknown as Phase;
    const inputs = autoInputs(phase, { kind: "draw" });
    expect(inputs).toMatchObject({ goal: "g", folder: ".agents/phases/ph_draw", requirements: "actions, texts" });
    expect(String(inputs.pieces)).toContain("p1");
    const reads = stageInit({ id: "ph_draw", stage: "design", record: phase.record });
    expect(reads).toEqual(expect.arrayContaining([".agents/phases/ph_draw/SPEC.md", ".agents/phases/ph_draw/PLAN.md", "DESIGN.md"]));
  });

  it("[sma:k_t_workstream] two live phases on different roadmap rows coexist, a third on a held row is refused, and pausing one keeps the other running", async () => {
    const { phases } = world();
    const first = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "One", goal: "g1", roadmapRow: "row-1" });
    const second = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Two", goal: "g2", roadmapRow: "row-2" });
    const live = phases.list({ projectId: "projA", live: true });
    expect(live.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    await expect(phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Three", goal: "g3", roadmapRow: "row-1" }))
      .rejects.toThrow(/already has a live phase/);
    phases.setState({ phaseId: first.id, state: "pause", by: "owner" });
    expect(phases.status(second.id).phase.state).toBe("active");
  });

  it("[sma:k_pl_handoff] the stop hook writes farewell.md naming the changed files, precompact writes capsule.json and start restores it first", async () => {
    const home = mkdtempSync(join(tmpdir(), "lp-hooks-"));
    expect(hookCli({ hook_event_name: "PreCompact", session_id: "s-hand", files: ["src/a.ts"], claims: [], asks: ["ship"] }, home).status).toBe(0);
    const capsule = JSON.parse(await readFile(join(home, ".lane-pilot/session-hooks/s-hand/capsule.json"), "utf8")) as { files: string[] };
    expect(capsule.files).toEqual(["src/a.ts"]);
    expect(hookCli({ hook_event_name: "SessionEnd", session_id: "s-hand", files: ["src/a.ts", "src/b.ts"] }, home).status).toBe(0);
    const farewell = await readFile(join(home, ".lane-pilot/session-hooks/s-hand/farewell.md"), "utf8");
    expect(farewell).toContain("src/a.ts");
    expect(farewell).toContain("src/b.ts");
    const started = hookCli({ hook_event_name: "SessionStart", session_id: "s-hand" }, home);
    expect(started.status).toBe(0);
    expect(started.stdout).toContain("Capsule restored after compaction");
    // the draft itself names the files
    expect(sessionEndDraft({ files: ["src/a.ts"], at: "now" })).toContain("src/a.ts");
  });

  it("[sma:k_d_ref_gates] three change-requesting rounds give the stop-revising gap, and the planning text names round 2 of 3", async () => {
    const { phases, db } = world();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "R", goal: "g" });
    const record = { context: { docs: [], sha: "ctx", signedAt: 1 }, plan: { items: [{ id: "p1", title: "t", wave: 1, covers: [], promise: { given: "g", when: "w", then: "t" }, task: {} }], sha: "x", contextSha: "ctx", rounds: PLAN_ROUNDS_MAX, critique: { decision: "changes_requested", summary: "still wrong" } } } as unknown as PhaseRecord;
    const gate = planGate(record);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(";")).toContain("stop revising");
    const oneRound = { ...record, plan: { ...record.plan!, rounds: 1 } };
    savePhase(db, phase.id, { stage: "planning", record: oneRound, at: 2 });
    expect(phases.status(phase.id).next.text).toContain(`round 2 of ${PLAN_ROUNDS_MAX}`);
  });
});

describe("reference cards carried by behaviour (c2)", () => {
  it("[sma:k_d_ref_planner] the lp.plan planner prompt holds the task-size, wave-overlap and vertical-slice rules, and the planning rubric names uncovered requirements", () => {
    const prompt = String(node("lp.plan", "plan").prompt);
    expect(prompt).toContain("15-60");
    expect(prompt).toContain("owns_paths must not overlap");
    expect(prompt).toContain("vertical slice");
    expect(STAGE_RUBRICS.planning.antipatterns).toContain("a requirement no piece covers");
  });

  it("[sma:k_d_ref_research] web-research demands two independent sources and counterevidence, and a writer with metamcp gets the context7 line", () => {
    const claims = String(node("web-research", "claims").prompt);
    expect(claims).toContain("two independent sources");
    expect(claims).toContain("counterevidence");
    expect(writerToolLine({ metamcpTools: true })).toContain("context7");
  });

  it("[sma:k_d_ref_exec] piecePlan lists the checks red before the files, and the execution rubric blocks a piece issued before its dependencies", () => {
    const phase = { id: "ph_p", title: "T", record: {} } as unknown as Phase;
    const item = { id: "p1", title: "t", wave: 1, covers: [], promise: { given: "g", when: "w", then: "t" },
      task: { verification: [{ command: "npm test" }], owns_paths: ["a/**"] } } as never;
    const plan = piecePlan(phase, item);
    const checksAt = plan.indexOf("red before the work");
    const filesAt = plan.indexOf("Write the files");
    expect(checksAt).toBeGreaterThan(-1);
    expect(filesAt).toBeGreaterThan(checksAt);
    expect(STAGE_RUBRICS.execution.antipatterns).toContain("issuing a piece before the pieces it depends on are accepted");
    // The worked example of the executor rules rides with the plan only where phase.piece_notes is on (SMA k_ag_animator briefs).
    const brief = piecePlan({ ...phase, record: { pieceNotes: true } } as Phase, item);
    expect(brief).toContain("Example of the executor rules");
    expect(brief.indexOf("Example of the executor rules")).toBeGreaterThan(brief.indexOf("Write the files"));
    expect(piecePlan(phase, item)).not.toContain("Example of the executor rules");
  });

  it("[sma:k_d_ref_worktree] writeDocs sends each file's hash guard and commits only the written paths; the writer setup forbids commit, push and merge", async () => {
    const { bb, db, ctx } = world();
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    bb.hosts.experimental_client = (() => ({
      call: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === "writePhaseBook") return { writes: (input.edits as Array<{ path: string }>).map((edit) => ({ path: edit.path, status: "applied" })) };
        if (method === "gitCommitDocs") return { commit: "c0ffee" };
        return {};
      },
    })) as never;
    createRun(db, "run-wd", "projA", "bb", WORKSPACE, "none", undefined, "h1");
    const services = { readWriterWorkspaceFile: async () => ({ content: "current text" }) } as unknown as Services;
    const docs = installDocs({ ctx, services, db, bb, now: () => 1, reactions: createPhaseReactions(db, bb) });
    const phase = { id: "ph_wd", projectId: "projA", pmThreadId: "thr", runId: "run-wd", record: {} } as unknown as Phase;
    const result = await docs.writeDocs(phase, [{ path: "docs/SPEC.md", content: "new" }, { path: "docs/UAT.md", content: "uat" }], "msg");
    const write = calls.find((call) => call.method === "writePhaseBook")!;
    const edits = write.input.edits as Array<{ path: string; expectedSha256: string | null }>;
    expect(edits.find((edit) => edit.path === "docs/SPEC.md")).toMatchObject({ expectedSha256: sha256("current text") });
    expect(edits.find((edit) => edit.path === "docs/UAT.md")).toMatchObject({ expectedSha256: sha256("current text") });
    const commit = calls.find((call) => call.method === "gitCommitDocs")!;
    expect(commit.input.paths).toEqual(result.written);
    expect(result.written).toEqual(["docs/SPEC.md", "docs/UAT.md"]);
  });

  it("[sma:k_d_ref_discuss] the grill walk requires file:line on every question, one at a time, and the discussion rubric scouts the code first", () => {
    const walk = String(node("grill-plan", "walk").prompt);
    expect(walk).toContain("One question at a time");
    expect(walk).toContain("file:line");
    expect(STAGE_RUBRICS.discussion.order.join(";")).toContain("scout the code");
  });

  it("[sma:k_d_ref_models] every role row resolves to a model of a known tier, and role_model.<role> overrides the default", () => {
    for (const row of ROLE_TABLE) {
      const option = roleModelOption(row.default.model);
      expect(option, `${row.id} -> ${row.default.model}`).toBeTruthy();
      expect(["strong", "standard", "light"]).toContain(option!.tier);
    }
    const picked = tableRowAt({ "role_model.analyst": { model: "gpt-6-luna" } }, "analyst");
    expect(picked?.option.id).toBe("gpt-6-luna");
    expect(picked?.option.providerId).toBe("codex");
  });

  it("[sma:k_d_ref_verify] a red check of another run's commit passes the goal listed aside, and the PM and nyquist-auditor carry lane-pilot", () => {
    const verdict = goalVerdict({
      tasks: [{ taskId: "t1", checks: [{ command: "npm test", state: "green" }, { command: "npm lint", state: "red" }] }],
      findings: [{ taskId: "t1", command: "npm lint", culpritCommit: "deadbeefcafe", culpritTask: "other-run-task" }],
    }, ["t1"]);
    expect(verdict.state).toBe("passed");
    expect(verdict.red).toEqual([]);
    expect(verdict.aside).toEqual([expect.objectContaining({ taskId: "t1", command: "npm lint", why: "outside" })]);
    const agents = JSON.parse(readFileSync(join(process.cwd(), "src/rooms/contracts/bundled-agents.json"), "utf8")) as Record<string, { skills?: string[] }>;
    expect(agents["dev-orchestrator"]!.skills).toContain("lane-pilot");
    expect(agents["nyquist-auditor"]!.skills).toContain("lane-pilot");
  });
});
