import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { createHarness, HARNESS_TUNING } from "../../src/rooms/harness/server/harness";
import { getHarness, insertHarness, listHarnesses, setHarnessState } from "../../src/rooms/harness/server/store";
import { mountNightGraphs } from "../../src/rooms/night-graphs/server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { createRun, createTask } from "../../src/rooms/storage/database";
import { nightWorld } from "./world";

const TREE_FILE = "Run the spec next to the file.";
const harvest = () => `@@FILE always-on.md\n${Buffer.from(TREE_FILE).toString("base64")}\n@@END\n`;
const hostReply = (command: string): string | undefined => {
  if (command.includes("test -d")) return "@@DIR";
  if (command.includes("@@WRITTEN")) return "@@WRITTEN";
  if (command.includes("find . -type f")) return harvest();
  return undefined;
};
const PROJECT = "proj";
HARNESS_TUNING.editorStaggerMs = 0;
HARNESS_TUNING.retryDelayMs = 0;

function setup(options: { answerFor?: (args: Record<string, any>) => string | Error | undefined } = {}) {
  const w = nightWorld({ hostReply, answerFor: options.answerFor ?? (() => "<notes>Added a rule about running the spec.</notes>") });
  w.services.harness = createHarness(w.ctx, w.services);
  mountNightGraphs(w.ctx, w.services);
  const harness = w.services.harness as ReturnType<typeof createHarness>;
  createRun(w.db, "run1", PROJECT);
  let n = 0;
  const attempt = (state = "accepted") => {
    const id = `att${++n}`;
    createTask(w.db, { id: `task-${id}`, runId: "run1", kind: "bb", contract: { area: "ui" } });
    w.db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "run1", `task-${id}`, null, state, 1, Date.now() - n * 1000, Date.now());
    return id;
  };
  attempt(); attempt();
  const roles = () => w.state.spawned.map((args) => args.pluginMetadata?.role as string);
  return { w, harness, attempt, roles };
}

describe("the harness graphs", () => {
  it("are built-in starter graphs that pass the validator", () => {
    const edit = builtinWorkflow("lp.harness-edit")!;
    expect(edit).toMatchObject({ id: "lp.harness-edit", startedBy: "harness-nightly", status: "published" });
    expect(edit.nodes.map((node) => node.id)).toEqual(["prepare", "edit", "validate", "done"]);
    expect(validateWorkflow(edit).filter((problem) => problem.level === "error")).toEqual([]);
    const reflect = builtinWorkflow("lp.harness-reflect")!;
    expect(reflect.nodes.map((node) => node.id)).toEqual(["prepare", "reflect", "record", "done"]);
    expect(validateWorkflow(reflect).filter((problem) => problem.level === "error")).toEqual([]);
  });

  it("a round runs the two editors and the composer as helpers of one graph run and puts the composed tree on trial", async () => {
    const { w, harness, roles } = setup();
    const result = await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", reason: "nightly: 2 attempts", night: "2026-10-27" });
    expect(result).toMatchObject({ status: "trial", candidateId: expect.stringMatching(/^hrn_/) });
    expect(roles().sort()).toEqual(["harness-composer", "harness-editor", "harness-editor"]);
    const [run] = w.runs("lp.harness-edit");
    expect(run).toMatchObject({ status: "succeeded", idem_key: `harness-edit:${PROJECT}:ui:*:2026-10-27` });
    for (const args of w.state.spawned) {
      expect(args.pluginMetadata).toMatchObject({ lanePilotWorkflowRunId: run!.id, lanePilotWorkflowNode: "edit", lanePilotProjectId: PROJECT });
      expect(args.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    }
    // Sessions are records, not conversations.
    expect(w.state.archived).toHaveLength(3);
    const candidate = getHarness(w.db, result.candidateId!)!;
    expect(candidate).toMatchObject({ state: "trial", area: "ui", createdBy: "editor", reason: "nightly: 2 attempts" });
    expect(candidate.tree["always-on.md"]).toBe(TREE_FILE);
    expect(candidate.notes).toContain("## inv");
    // The same night again finds the run: nothing new starts. (A trial is also open now.)
    expect(await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", night: "2026-10-27" })).toMatchObject({ status: "skipped" });
    expect(w.state.spawned).toHaveLength(3);
  });

  it("editors that keep the base put nothing on trial; the round is recorded", async () => {
    const { w, harness } = setup({ answerFor: () => "<notes>KEEP_BASE: nothing to add</notes>" });
    const result = await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", night: "2026-10-27" });
    expect(result).toMatchObject({ status: "keep_base", detail: "both editors kept the current harness" });
    expect(listHarnesses(w.db, PROJECT, { states: ["trial"] })).toHaveLength(0);
    expect(await w.bb.storage.kv.get(`harness:last-edit:${PROJECT}:ui:*`)).toMatchObject({ result: "keep_base" });
    expect(w.runs("lp.harness-edit")).toEqual([expect.objectContaining({ status: "succeeded" })]);
    // The composer never ran.
    expect(w.state.spawned).toHaveLength(2);
  });

  it("when both editors fail the run fails (the wall sees it) and nothing is put on trial", async () => {
    const { w, harness } = setup({ answerFor: () => new Error("provider refused") });
    const result = await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", night: "2026-10-27" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("both editors failed");
    expect(listHarnesses(w.db, PROJECT, { states: ["trial"] })).toHaveLength(0);
    expect(w.engine.get(w.runs("lp.harness-edit")[0]!.id)).toMatchObject({ status: "failed", failedNode: "validate" });
  });

  // 2026-10-31: the night editor of office-studio-prototype worked in the magicseo replay's live checkout, the project's newest run of
  // another area, and failed that replay's designer with repo_edited on `.lane-pilot/harness-edit/…`.
  it("works in the key's own folder or the project's, never in the newest run of another area", async () => {
    const { w, harness } = setup();
    createRun(w.db, "run-other", PROJECT);
    w.db.prepare("UPDATE lane_pilot_run SET writer_host_id='host-x', writer_workspace_path='/other-section', updated_at=? WHERE id='run-other'").run(Date.now() + 60_000);
    createTask(w.db, { id: "task-other", runId: "run-other", kind: "bb", contract: { area: "backend" } });
    await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", night: "2026-10-27" });
    const paths = w.state.spawned.map((args) => JSON.stringify(args.environment ?? {}));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.join("\n")).not.toContain("/other-section");
  });

  it("a key with no finished attempts, or with a candidate already on trial, starts nothing or ends skipped", async () => {
    const { w, harness } = setup();
    expect(await harness.runEditor({ projectId: PROJECT, area: "backend", writerKey: "*", night: "2026-10-27" })).toMatchObject({ status: "skipped", detail: "no finished attempts of this key in the window" });
    expect(w.state.spawned).toHaveLength(0);
    insertHarness(w.db, { projectId: PROJECT, area: "ui", writerKey: "*", tree: { "always-on.md": "x" }, state: "trial", createdBy: "editor", parentId: null });
    expect(await harness.runEditor({ projectId: PROJECT, area: "ui", writerKey: "*", night: "2026-10-27" })).toMatchObject({ status: "skipped", detail: "a candidate is already on trial for this key" });
    expect(w.runs("lp.harness-edit")).toHaveLength(1);
  });

  it("the nightly tick keeps its dry run: it names the editor it would start and starts no graph", async () => {
    const { w, harness } = setup();
    await harness.setConfig(PROJECT, { minAttempts: 1, minSpanDays: 0 } as never);
    const dry = await harness.tick(PROJECT, { dryRun: true, night: "2026-10-27" });
    expect(dry.editors).toEqual([expect.objectContaining({ area: "ui", result: "would start an editor" })]);
    expect(w.runs()).toEqual([]);
    expect(w.state.spawned).toHaveLength(0);
    const live = await harness.tick(PROJECT, { night: "2026-10-27" });
    expect(live.editors).toEqual([expect.objectContaining({ area: "ui", result: expect.stringMatching(/^trial:/) })]);
    expect(w.runs("lp.harness-edit")).toHaveLength(1);
  });

  it("the reflection on a decided trial is the graph lp.harness-reflect and happens once", async () => {
    const { w, harness } = setup({ answerFor: () => "NO_ENTRY" });
    const trial = insertHarness(w.db, { projectId: PROJECT, area: "ui", writerKey: "*", tree: { "always-on.md": "x" }, state: "trial", createdBy: "editor", parentId: null });
    expect(await harness.reflect(trial.id)).toMatchObject({ status: "skipped" });
    setHarnessState(w.db, trial.id, "retired", "no better", Date.now());
    expect(await harness.reflect(trial.id)).toMatchObject({ status: "done", detail: expect.stringContaining("NO_ENTRY") });
    expect(w.state.spawned.map((args) => args.pluginMetadata?.role)).toEqual(["harness-reflection"]);
    expect(w.runs("lp.harness-reflect")).toEqual([expect.objectContaining({ status: "succeeded", idem_key: `harness-reflect:${trial.id}` })]);
    expect(await harness.reflect(trial.id)).toMatchObject({ status: "done" });
    expect(w.state.spawned).toHaveLength(1);
  });
});
