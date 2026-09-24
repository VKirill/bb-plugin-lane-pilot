import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { aggregateRun } from "../src/aggregation";
import { spawnSync } from "node:child_process";
import { buildCliInvocation } from "../src/argv-builder";
import { requiredCliFlags } from "../src/cli-flags";
import { attemptProduced, classifyCliOutcome } from "../src/cli-outcome";
import { classifyWriterOutput, parseGitChangedPaths } from "../src/validate-output";
import {
  claimActivation,
  countAttempts,
  createAttempt,
  createRun,
  createTask,
  getActivation,
  getAttempt,
  listTaskKinds,
  openDatabase,
  savePrototypeConfig,
  saveStageReceipt,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import { fileAllowedByOwns, fnmatch, matchOwnsPath } from "../src/owns-paths";
import plugin from "../server";
import {
  MAIN_ATTEMPT_LIMIT,
  nextAttemptState,
  retryAction,
  TRANSITION_TABLE,
} from "../src/state-machine";
import { loadTaskV2Schema, TASK_V2_REQUIRED, validateTaskV2 } from "../src/task-v2";

const config = {
  projectId:"project-test",
  hostId:"host-test",
  pmWorkspacePath:"/tmp/pm",
  writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code",
  pmModel:"claude-test",
  writerProviderId:"codex",
  writerModel:"codex-test",
};

describe("§3.4 transition table", () => {
  const cases: Array<{from:Parameters<typeof nextAttemptState>[0]; event:Parameters<typeof nextAttemptState>[1]; to:string}> = [
    { from:null, event:"form_task", to:"queued" },
    { from:"queued", event:"spawn_called", to:"spawn_requested" },
    { from:"spawn_requested", event:"spawn_ok", to:"running" },
    { from:"spawn_requested", event:"spawn_explicit_error", to:"spawn_rejected" },
    { from:"spawn_requested", event:"spawn_network_error", to:"spawn_unknown" },
    { from:"spawn_unknown", event:"reconcile_found", to:"running" },
    { from:"spawn_unknown", event:"reconcile_not_found", to:"spawn_rejected" },
    { from:"spawn_unknown", event:"reconcile_ambiguous", to:"blocked" },
    { from:"spawn_unknown", event:"reconcile_error", to:"spawn_unknown" },
    { from:"spawn_rejected", event:"retry", to:"queued" },
    { from:"spawn_rejected", event:"retry_exhausted", to:"blocked" },
    { from:"running", event:"provider_error", to:"provider_error" },
    { from:"running", event:"wait_timeout", to:"timeout" },
    { from:"running", event:"empty_output", to:"empty_output" },
    { from:"running", event:"validation_failed", to:"validation_failed" },
    { from:"running", event:"checks_passed", to:"accepted" },
    { from:"running", event:"cancel", to:"cancel_requested" },
    { from:"cancel_requested", event:"cancel_observed", to:"canceled" },
    { from:"provider_error", event:"retry", to:"queued" },
    { from:"provider_error", event:"retry_exhausted", to:"blocked" },
    { from:"timeout", event:"retry", to:"queued" },
    { from:"timeout", event:"retry_exhausted", to:"blocked" },
    { from:"empty_output", event:"retry", to:"queued" },
    { from:"empty_output", event:"retry_exhausted", to:"blocked" },
    { from:"validation_failed", event:"retry", to:"queued" },
    { from:"validation_failed", event:"retry_exhausted", to:"blocked" },
  ];
  it("covers every spec row", () => expect(TRANSITION_TABLE).toHaveLength(cases.length));
  for (const row of cases) {
    it(`${row.from ?? "∅"} + ${row.event} → ${row.to}`, () => {
      expect(nextAttemptState(row.from, row.event)).toBe(row.to);
    });
  }
  it("retry limit is 2 main attempts", () => {
    expect(MAIN_ATTEMPT_LIMIT).toBe(2);
    expect(retryAction("validation_failed", 1)).toBe("retry");
    expect(retryAction("validation_failed", 2)).toBe("retry_exhausted");
  });
});

describe("§3.5 aggregation", () => {
  it("accepts only when every task is accepted", () => {
    expect(aggregateRun(["accepted","accepted"])).toBe("accepted");
  });
  it("blocks when every task is accepted or blocked", () => {
    expect(aggregateRun(["accepted","blocked"])).toBe("blocked");
    expect(aggregateRun(["blocked"])).toBe("blocked");
  });
  it("stays running while any task is open", () => {
    expect(aggregateRun(["accepted","running"])).toBe("running");
    expect(aggregateRun(["validation_failed"])).toBe("running");
  });
});

describe("argv-builder channels", () => {
  it("maps W-DIRECT and ENV-PASSTHROUGH and lists E1 unapplied settings", () => {
    const built = buildCliInvocation({
      binary:"run-controller",
      subcommand:"run",
      settings:{
        "writer.provider":"opencode",
        "writer.model":"kimi",
        "writer.reasoning_effort":"medium",
        "writer.service_tier":"standard",
        "writer.fast_mode":true,
        "jev.LANE_JEV_EFFORT":true,
        "jev.LANE_OPENCODE_JEV":false,
        "ops.poll_interval":2,
        "plan_critique.mode":"advisory",
        "plan_critique.provider":"codex",
      },
      required:{ "--run-dir":"/tmp/run", "--project-cwd":"/tmp/proj" },
    });
    expect(built.argv).toEqual([
      "run", "--run-dir", "/tmp/run", "--project-cwd", "/tmp/proj",
      "--provider", "opencode", "--model", "kimi", "--reasoning-effort", "medium",
      "--service-tier", "standard", "--poll-interval", "2",
    ]);
    expect(built.argv.filter((token) => token === "--provider")).toHaveLength(1);
    expect(built.env).toEqual({ LANE_JEV_EFFORT:"1", LANE_OPENCODE_JEV:"0" });
    expect(built.unapplied.map((row) => row.key).sort()).toEqual(["plan_critique.mode","plan_critique.provider","writer.fast_mode"]);
    expect(built.unapplied.find((item) => item.key === "plan_critique.mode")?.reason).toMatch(/no --mode/);
  });
  it("emits one unapplied row for a duplicated catalog key", () => {
    const built = buildCliInvocation({
      binary:"run-controller",
      subcommand:"run",
      settings:{ "night_review.model":"gpt-6-astra", "writer.reasoning_effort":"medium" },
    });
    const night = built.unapplied.filter((row) => row.key === "night_review.model");
    expect(night).toHaveLength(1);
    expect(night[0]?.reason).toMatch(/native Lane Pilot stage/i);
    expect(new Set(built.unapplied.map((row) => row.key)).size).toBe(built.unapplied.length);
  });
  it.each([[false, "standard"], [true, "fast"]] as const)("migrates legacy fast_mode=%s through one service-tier flag", (legacy, expectedTier) => {
    const built = buildCliInvocation({
      binary:"run-controller", subcommand:"run", settings:{ "writer.fast_mode":legacy },
    });
    expect(built.argv).toEqual(["run", "--service-tier", expectedTier]);
    expect(built.argv.filter((token) => token === "--service-tier")).toHaveLength(1);
    expect(built.argv).not.toContain("--fast-mode");
    expect(built.unapplied).toContainEqual(expect.objectContaining({ key:"writer.fast_mode" }));
  });
  it("does not put --max-tasks on run-controller unless that key is controller-scoped", () => {
    const built = buildCliInvocation({
      binary:"run-controller",
      subcommand:"run",
      settings:{ "ops.max_tasks":3 },
      required:{ "--run-dir":"/tmp/run" },
    });
    expect(built.argv).not.toContain("--max-tasks");
  });
  it("applies the configured session task cap to lane-ctl start only",()=>{
    const built=buildCliInvocation({
      binary:"lane-ctl",subcommand:"start",settings:{"ops.max_tasks":3},
      required:requiredCliFlags({binary:"lane-ctl",subcommand:"start",runDir:"/tmp/run",projectCwd:"/tmp/proj",taskFile:"/tmp/run/tasks/001.yaml"}),
    });
    expect(built.argv).toEqual(["start","--run-dir","/tmp/run","--project-cwd","/tmp/proj","--task-file","/tmp/run/tasks/001.yaml","--max-tasks","3"]);
    expect(built.applied).toContain("ops.max_tasks");
    expect(built.unapplied).toEqual([]);
  });
  it("emits a writer provider flag only once when it is already required", () => {
    const built = buildCliInvocation({
      binary:"run-controller",
      subcommand:"run",
      settings:{ "writer.provider":"codex" },
      required:{ "--run-dir":"/tmp/run", "--project-cwd":"/tmp/proj", "--provider":"codex" },
    });
    expect(built.argv.filter((arg) => arg === "--provider")).toHaveLength(1);
    expect(built.argv.filter((arg) => arg === "codex")).toHaveLength(1);
  });
  it("does not put W-DIRECT or OPS poll flags on run-controller status", () => {
    const built = buildCliInvocation({
      binary:"run-controller",
      subcommand:"status",
      settings:{
        "writer.provider":"opencode",
        "ops.poll_interval":1,
        "plan_critique.mode":"advisory",
      },
      required: requiredCliFlags({ binary:"run-controller", subcommand:"status", runDir:"/tmp/run", projectCwd:"/tmp/proj" }),
    });
    expect(built.argv).toEqual(["status", "--run-dir", "/tmp/run", "--json"]);
    expect(built.unapplied.map((row) => row.key).sort()).toEqual([
      "ops.poll_interval",
      "plan_critique.mode",
      "writer.provider",
    ]);
  });
  it("lane-ctl status requires --task-id and rejects --project-cwd", () => {
    const built = buildCliInvocation({
      binary:"lane-ctl",
      subcommand:"status",
      settings:{ "writer.provider":"cursor", "ops.project_cwd":"/tmp/proj" },
      required: requiredCliFlags({ binary:"lane-ctl", subcommand:"status", runDir:"/tmp/run", projectCwd:"/tmp/proj", taskId:"001" }),
    });
    expect(built.argv).toEqual(["status", "--run-dir", "/tmp/run", "--json", "--task-id", "001"]);
    expect(built.argv).not.toContain("--project-cwd");
  });
  it("lane-ctl start requires --task-file and --project-cwd", () => {
    expect(() => requiredCliFlags({ binary:"lane-ctl", subcommand:"start", runDir:"/tmp/run", projectCwd:"/tmp/proj" }))
      .toThrow(/task-file/);
    const built = buildCliInvocation({
      binary:"lane-ctl",
      subcommand:"start",
      settings:{ "writer.provider":"cursor" },
      required: requiredCliFlags({
        binary:"lane-ctl", subcommand:"start", runDir:"/tmp/run", projectCwd:"/tmp/proj", taskFile:"/tmp/run/tasks/001.yaml",
      }),
    });
    expect(built.argv).toEqual([
      "start", "--run-dir", "/tmp/run", "--project-cwd", "/tmp/proj",
      "--task-file", "/tmp/run/tasks/001.yaml", "--provider", "cursor",
    ]);
  });
  it("built argv is a subset of real binary --help", () => {
    const cases: Array<{ binary:"run-controller"|"lane-ctl"; subcommand:string; required:Record<string,string> }> = [
      { binary:"run-controller", subcommand:"status", required: requiredCliFlags({ binary:"run-controller", subcommand:"status", runDir:"/tmp/r" }) },
      { binary:"run-controller", subcommand:"run", required: requiredCliFlags({ binary:"run-controller", subcommand:"run", runDir:"/tmp/r", projectCwd:"/tmp/p" }) },
      { binary:"lane-ctl", subcommand:"status", required: requiredCliFlags({ binary:"lane-ctl", subcommand:"status", runDir:"/tmp/r", taskId:"001" }) },
      { binary:"lane-ctl", subcommand:"start", required: requiredCliFlags({ binary:"lane-ctl", subcommand:"start", runDir:"/tmp/r", projectCwd:"/tmp/p", taskFile:"/tmp/t.yaml" }) },
    ];
    for (const row of cases) {
      const help = spawnSync(row.binary, [row.subcommand, "--help"], { encoding:"utf8" });
      const text = `${help.stdout}\n${help.stderr}`;
      const allowed = new Set([...text.matchAll(/--[a-z0-9-]+/g)].map((match) => match[0]));
      const built = buildCliInvocation({
        binary:row.binary,
        subcommand:row.subcommand,
        settings:{ "writer.provider":"cursor", "ops.poll_interval":2, "plan_critique.mode":"advisory" },
        required:row.required,
      });
      for (const token of built.argv.filter((item) => item.startsWith("--"))) {
        expect(allowed.has(token), `${row.binary} ${row.subcommand} unexpected ${token}`).toBe(true);
      }
    }
  });
  it("rejects --apply / setup", () => {
    expect(() => buildCliInvocation({
      binary:"run-controller",
      subcommand:"run",
      settings:{},
      required:{ "--apply":"1" },
    })).toThrow(/forbidden/);
  });
});

describe("task-v2", () => {
  const valid = {
    schema_version:2 as const,
    id:"task1",
    title:"T",
    risk:"low" as const,
    lane:"writer",
    project_cwd:"/tmp/x",
    read_first:["README.md"],
    interfaces:["i"],
    invariants:["inv"],
    out_of_scope:["out"],
    expected_outputs:["a.txt"],
    owns_paths:["a.txt"],
    never_touch:[".git/**"],
    depends_on:[],
    objective:"do it",
    acceptance:["done"],
    verify:"tests" as const,
    verification:[{ command:"true", cwd:"/tmp/x" }],
  };
  it("requires the 18 upstream fields and keeps the copyrighted schema copy", () => {
    const schema = loadTaskV2Schema();
    expect(schema.required).toEqual([...TASK_V2_REQUIRED]);
    expect(schema.additionalProperties).toBe(false);
    const copied = readFileSync(join(process.cwd(), "lane-stack/schemas/task-v2.schema.json"), "utf8");
    const upstream = readFileSync(join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack/schemas/task-v2.schema.json"), "utf8");
    expect(copied).toBe(upstream);
    expect(readFileSync(join(process.cwd(), "lane-stack/schemas/LICENSE"), "utf8")).toMatch(/Copyright \(c\) 2026 VKirill/);
  });
  it("accepts a valid contract and rejects extras", () => {
    expect(validateTaskV2(valid).ok).toBe(true);
    expect(validateTaskV2({ ...valid, plan_critique_mode:"advisory" }).ok).toBe(false);
  });
});

describe("owns_paths strategies", () => {
  it("matches /** suffix as a directory prefix", () => {
    expect(matchOwnsPath("src/a.ts", "src/**")).toBe(true);
    expect(matchOwnsPath("lib/a.ts", "src/**")).toBe(false);
  });
  it("matches fnmatch globs", () => {
    expect(fnmatch("tests/hello.test.txt", "tests/*.test.txt")).toBe(true);
    expect(fnmatch("tests/nested/hello.test.txt", "tests/*.test.txt")).toBe(false);
  });
  it("matches a plain prefix", () => {
    expect(fileAllowedByOwns("docs/plans/x.md", ["docs/plans"])).toBe(true);
    expect(fileAllowedByOwns("src/x.md", ["docs/plans"])).toBe(false);
  });
});

describe("activation lock and run mix", () => {
  it("blocks a second live activation on the same project", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-a", config.projectId);
    setRunThread(db, "run-a", "thr-pm-1");
    claimActivation(db, { projectId:config.projectId, pmThreadId:"thr-pm-1", runId:"run-a" });
    expect(getActivation(db, config.projectId)?.pm_thread_id).toBe("thr-pm-1");
    expect(() => claimActivation(db, { projectId:config.projectId, pmThreadId:"thr-pm-2", runId:"run-b" }))
      .toThrow(/already active/);
    await harness.lifecycle.dispose();
  });
  it("refuses to mix BB and CLI tasks in one run", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-mix", config.projectId, "bb");
    createTask(db, { id:"t1", runId:"run-mix", kind:"bb", contract:{} });
    expect(listTaskKinds(db, "run-mix")).toEqual(["bb"]);
    await harness.lifecycle.dispose();
  });
});

describe("retry creates a new attemptId", () => {
  it("counts two attempts then stops", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-r", config.projectId);
    createAttempt(db, { id:"a1", runId:"run-r", taskId:"t" });
    transitionAttempt(db, "a1", "validation_failed");
    createAttempt(db, { id:"a2", runId:"run-r", taskId:"t" });
    expect(countAttempts(db, "run-r", "t")).toBe(2);
    expect(getAttempt(db, "a2")?.attempt_no).toBe(2);
    expect(retryAction("validation_failed", 2)).toBe("retry_exhausted");
    await harness.lifecycle.dispose();
  });
});

describe("writer output validation", () => {
  const task = {
    schema_version:2 as const,
    id:"task1",
    title:"T",
    risk:"low" as const,
    lane:"writer",
    project_cwd:"/tmp/x",
    read_first:["README.md"],
    interfaces:["i"],
    invariants:["inv"],
    out_of_scope:["out"],
    expected_outputs:["hello.txt"],
    owns_paths:["hello.txt"],
    never_touch:[".git/**"],
    depends_on:[],
    objective:"do it",
    acceptance:["done"],
    verify:"tests" as const,
    verification:[{ command:"true", cwd:"/tmp/x" }, { command:"false", cwd:"/tmp/x" }],
  };
  it("fails when any verification command is non-zero, not only the first", () => {
    const classified = classifyWriterOutput({
      task,
      produced:["hello.txt"],
      contents:{ "hello.txt":"hello\n" },
      verifies:[
        { command:"true", exitCode:0, stderr:"" },
        { command:"false", exitCode:1, stderr:"boom" },
      ],
    });
    expect(classified.ok).toBe(false);
    if (!classified.ok) expect(classified.reason).toMatch(/false/);
  });
  it("fails a dirty path outside owns_paths", () => {
    const classified = classifyWriterOutput({
      task,
      produced:["hello.txt", "src/production.ts"],
      contents:{ "hello.txt":"hello\n" },
    });
    expect(classified.ok).toBe(false);
    if (!classified.ok) expect(classified.reason).toMatch(/owns_paths rejected src\/production.ts/);
  });
  it("parses git status --porcelain and name-only", () => {
    expect(parseGitChangedPaths("?? hello.txt\n M src/production.ts\nsrc/other.ts\n")).toEqual([
      "hello.txt",
      "src/production.ts",
      "src/other.ts",
    ]);
  });
  it("rejects a pre-existing expected file that this attempt did not produce", () => {
    const produced = attemptProduced(["hello.txt"], ["hello.txt"]);
    expect(produced).toEqual([]);
    const classified = classifyWriterOutput({
      task:{ ...task, verify:"none", verification:[] },
      produced,
      contents:{ "hello.txt":"hello from native BB writer\n" },
    });
    expect(classified).toEqual({
      ok:false,
      state:"empty_output",
      reason:"missing expected_outputs: hello.txt",
    });
  });
  it("fails validation when only some expected outputs are missing", () => {
    const classified = classifyWriterOutput({
      task:{ ...task, expected_outputs:["hello.txt", "other.txt"], verify:"none", verification:[] },
      produced:["hello.txt"],
      contents:{ "hello.txt":"hello\n" },
    });
    expect(classified).toEqual({
      ok:false,
      state:"validation_failed",
      reason:"missing expected_outputs: other.txt",
    });
  });
  it("reports never_touch as validation_failed even when expected output is missing", () => {
    const produced = attemptProduced(["hello.txt", "src/production.ts"], ["hello.txt"]);
    expect(produced).toEqual(["src/production.ts"]);
    const classified = classifyWriterOutput({
      task:{
        ...task,
        verify:"none",
        verification:[],
        never_touch:["src/production.ts"],
      },
      produced,
      contents:{ "hello.txt":"stale\n" },
    });
    expect(classified).toEqual({
      ok:false,
      state:"validation_failed",
      reason:"never_touch matched src/production.ts",
    });
  });
  it("rejects a pre-dirty never_touch file when its content changes again", () => {
    const produced = attemptProduced(
      [
        { path:"src/production.ts", sha256:"after-writer-change" },
        { path:"hello.txt", sha256:"created-by-writer" },
      ],
      [{ path:"src/production.ts", sha256:"before-writer-change" }],
    );
    expect(produced).toContain("src/production.ts");
    const classified = classifyWriterOutput({
      task:{ ...task, never_touch:["src/production.ts"], verify:"none", verification:[] },
      produced,
      contents:{ "hello.txt":"hello\n" },
    });
    expect(classified).toEqual({
      ok:false,
      state:"validation_failed",
      reason:"never_touch matched src/production.ts",
    });
  });
  it("rejects a pre-dirty file changed outside owns_paths", () => {
    const produced = attemptProduced(
      [{ path:"src/production.ts", sha256:"after-writer-change" }],
      [{ path:"src/production.ts", sha256:"before-writer-change" }],
    );
    expect(produced).toEqual(["src/production.ts"]);
    expect(classifyWriterOutput({
      task:{ ...task, owns_paths:["hello.txt"], verify:"none", verification:[] },
      produced,
      contents:{},
    })).toEqual({
      ok:false,
      state:"validation_failed",
      reason:"owns_paths rejected src/production.ts",
    });
  });
});

describe("CLI run outcome", () => {
  it("rejects a nonzero host exit even when stdout claims accepted", () => {
    const outcome = classifyCliOutcome({
      subcommand:"status",
      exitCode:73,
      stdout: JSON.stringify({ accepted:true, status:"accepted", exit_code:0 }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.taskAccepted).toBe(false);
    expect(outcome.reason).toBe("control exit 73");
  });
  it("does not accept lane-ctl status exit 0 when the task failed", () => {
    const outcome = classifyCliOutcome({
      subcommand:"status",
      exitCode:0,
      stdout: JSON.stringify({ status:"failed", accepted:false, exit_code:71 }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.taskAccepted).toBe(false);
  });
  it("keeps start/run at running until upstream accepted", () => {
    expect(classifyCliOutcome({
      subcommand:"start",
      exitCode:0,
      stdout: JSON.stringify({ status:"started", accepted:false }),
    }).status).toBe("running");
    expect(classifyCliOutcome({
      subcommand:"status",
      exitCode:0,
      stdout: JSON.stringify({ status:"accepted", accepted:true }),
    }).status).toBe("accepted");
  });
  it("blocks a conflicting failed receipt even when accepted is true", () => {
    const outcome = classifyCliOutcome({
      subcommand:"status",
      exitCode:0,
      stdout: JSON.stringify({ status:"failed", accepted:true, exit_code:71 }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.taskAccepted).toBe(false);
    expect(outcome.upstreamStatus).toBe("failed");
    expect(outcome.reason).toMatch(/conflict/);
  });
});

describe("PM tool gating", () => {
  it("exposes writer, wait and cli tools only for origin.pluginId=lane-pilot and role=pm", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    await plugin(bb);
    const base = {
      threadId:"thr-x",
      project:{ id:config.projectId },
    };
    const pm = await harness.behavior.resolveAgentConfiguration({
      ...base,
      origin:{ pluginId:"lane-pilot" },
      pluginMetadata:{ role:"pm", lanePilotRunId:"run-x" },
    } as never);
    const writer = await harness.behavior.resolveAgentConfiguration({
      ...base,
      origin:{ pluginId:"lane-pilot" },
      pluginMetadata:{ role:"writer", lanePilotRunId:"run-x" },
    } as never);
    const ordinary = await harness.behavior.resolveAgentConfiguration({
      ...base,
      origin:{ pluginId:"other" },
      pluginMetadata:{ role:"pm", lanePilotRunId:"run-x" },
    } as never);
    expect(pm.tools.map((tool) => tool.name)).toEqual(["lane_pilot_dispatch_writer","lane_pilot_wait_writer","lane_pilot_dispatch_cli","lane_pilot_browser_qa","lane_pilot_ingest_opencode_telemetry","lane_pilot_docs_maintain","lane_pilot_onboarding_preview","lane_pilot_onboarding_apply","lane_pilot_memory_maintain","lane_pilot_night_review","lane_pilot_night_fix","lane_pilot_workspace_status","lane_pilot_memory_context","lane_pilot_gate_report","lane_pilot_gate_triage"]);
    expect(writer.tools).toEqual([]);
    expect(ordinary.tools).toEqual([]);
    createRun(db,"gate-report-run",config.projectId);
    createTask(db,{id:"gate-report-task",runId:"gate-report-run",kind:"bb",contract:{}});
    saveStageReceipt(db,{contractVersion:1,runId:"gate-report-run",taskId:"gate-report-task",stageId:"plan-critique",state:"blocked",
      inputSha256:"a".repeat(64),outputSha256:null,attempt:0,providerId:"critic",model:"critic-model",threadId:"critic-thread",
      result:{detail:"not copied into the report"},reason:"changes_requested",updatedAt:Date.now()});
    const report=JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_gate_report",{days:7},{threadId:"thr-x",projectId:config.projectId})));
    expect(report).toMatchObject({schemaVersion:1,projectId:config.projectId,totalEvents:1,recentBlockers:[{stageId:"plan-critique",state:"blocked"}]});
    expect(JSON.stringify(report)).not.toContain("not copied into the report");
    await harness.lifecycle.dispose();
  });
});
