import { coreFileWrite, diskStore } from "../helpers/core-files";
import { writtenByEngineSince } from "../../src/rooms/verification/server";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { registerPureActions, wfChildRuns } from "@lane-pilot/workflow-engine";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";
import { BUILTIN_SOURCES, builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import { wf } from "./engine-helpers";

/**
 * Packet P04-R7: sibling read-only document-write graphs (validate-phase, eval-review, secure-phase,
 * ai-integration-phase, spike, project-start, new-milestone, ship) and milestone-close's retro append move their
 * repository document writes out of read-only helper prompts into explicit fs.write actions on the frozen P04.08
 * writer API (params.contents + params.mode append|prepend, CAS). The real registered fs.write / deliverable.validate
 * / lp.* handlers run on a real engine over a temp SQLite db and a real git checkout; only the model's replies are
 * scripted. A green run is itself the proof of zero repo_edited failures: the scripted helpers never touch the
 * checkout, and the files land exactly where the code-owned writers put them.
 * Also covered: ai-integration's check->spec rework edge delivering check.gaps (F-A11), ship's review range using
 * $inputs.head (C-ship-review-ignores-head) and ship's goal_check receiving the actual producer path
 * (C-ship-goalcheck companion).
 */

type Row = Record<string, unknown>;
const PM = "pm-r7", PROJECT = "project-r7", RUN = "run-r7";
type Script = Record<string, Array<string | ((checkout: string) => string)>>;
const reply = (body: Row, lead = "Done.") => `${lead}\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

/** The executor fixture of a chain run: same composition as production (registerChainExecutors registers fs.write,
 *  deliverable.validate and the lp.* actions), minus the parts this packet does not exercise. */
async function setup(script: Script, options: { resolveWorkflow?: (id: string, version?: number) => Workflow | null; human?: (node: Row) => Row; truncateReads?: boolean; readError?: { code: string; serverCode: string }; writeOutcome?: string } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-r7-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const spawned: Array<Row> = [], writes: Array<{ path: string; content: string }> = [], hostCalls: Array<Row> = [], sends: Array<Row> = [];
  const nodeOf = new Map<string, string>(), counts = new Map<string, number>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      hostCalls.push(call);
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async (args) => {
          const request = args as unknown as Row;
          spawned.push(request);
          const id = `helper-${spawned.length}`;
          nodeOf.set(id, String((request.pluginMetadata as Row).lanePilotWorkflowNode ?? (request.pluginMetadata as Row).role));
          return { id };
        },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async ({ threadId }) => {
          const now = Date.now();
          return [{ type: "client/turn/requested", threadId, seq: 1, createdAt: now }, { type: "turn/started", threadId, seq: 2, createdAt: now + 1 },
            { type: "turn/completed", threadId, seq: 3, data: { status: "completed" }, createdAt: now + 2 }];
        } },
        send: async (args) => { sends.push(args as unknown as Row); return {} as never; },
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          const node = nodeOf.get(threadId) ?? "";
          const at = counts.get(node) ?? 0;
          counts.set(node, at + 1);
          const answers = script[node] ?? [];
          const answer = answers[Math.min(at, answers.length - 1)];
          return { output: typeof answer === "function" ? answer(checkout) : answer ?? "no script" };
        },
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) as never },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        write: async (args: unknown) => {
          const filePath = String((args as { path?: unknown }).path ?? "");
          if (options.writeOutcome && !/manifest\.json$/.test(filePath)) return { outcome: options.writeOutcome };
          return coreFileWrite(diskStore(), (path, content) => {
            if (!/\/\.agents\/runs\/[^/]+\/manifest\.json$/.test(path)) writes.push({ path, content });
          })(args) as never;
        },
        read: async (args: unknown) => {
          const filePath = String((args as { path?: unknown }).path ?? "");
          if (options.readError) throw Object.assign(new Error(`${options.readError.serverCode}: ${filePath}`), options.readError);
          if (!existsSync(filePath)) throw Object.assign(new Error(`file not found: ${filePath}`), { code: "not_found", serverCode: "file_not_found" });
          const content = readFileSync(filePath, "utf8");
          // The broken shape the data-loss review named: a sliced body under the whole-file hash.
          if (options.truncateReads) return { content: content.split("\n").slice(0, 4000).join("\n"), sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8", truncated: true };
          return { content, sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8", truncated: false };
        },
      },
      hosts: { directory: async () => ({ directory: checkout }) },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: vi.fn(async (args: Row) => ({ runId: RUN, taskId: (args.task as Row).id, state: "queued" })), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services), ...(options.resolveWorkflow ? { resolveWorkflow: options.resolveWorkflow } : {}) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  engine.register("builtin:human", { run: async (c) => ({ output: options.human ? options.human(c.node as unknown as Row) : { answer: "", answer_kind: "timeout" } }) });
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const start = (workflow: Workflow, inputs: Row = {}, mode?: "quick" | "standard" | "full") => engine.start({ workflow, inputs, ...(mode ? { mode } : {}), runtime: rt, link: { projectId: PROJECT, runId: RUN } });
  return { bb, harness, db, engine, checkout, spawned, sends, writes, hostCalls, start, rt, dispose: () => harness.lifecycle.dispose() };
}

const storeP = loadWorkflowStore({ builtin: BUILTIN_SOURCES });
const builtin = async (id: string): Promise<Workflow> => (await storeP).resolve(id)!;
const file = (checkout: string, rel: string) => existsSync(join(checkout, rel)) ? readFileSync(join(checkout, rel), "utf8") : null;
/** The inputs the engine handed a child workflow run, keyed by the child's workflow id. */
const childInputs = (db: { prepare: (sql: string) => { get: (...args: unknown[]) => Row | undefined } }, runId: string): Record<string, Row> =>
  Object.fromEntries(wfChildRuns(db as never, runId).map((child) => [
    child.workflow_id,
    JSON.parse(String(db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE id=?").get(child.id)?.inputs_json ?? "{}")) as Row,
  ]));

describe("P04-R7 sibling document writes through the real fs.write action", () => {
  it("validate-phase writes VALIDATION.md and the goal check validates that exact producer path", async () => {
    const t = await setup({
      audit: [reply({ gaps: [], document: "# Validation\n\n| Promise | Check |\n| --- | --- |\n| P1 | npm test |\n", sampled: 2, handoff: "audit done" })],
    });
    dispose = t.dispose;
    const summary = await t.start(await builtin("validate-phase"), { phase_id: "ph_r7a" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", validation_path: ".agents/phases/ph_r7a/VALIDATION.md" });
    expect(file(t.checkout, ".agents/phases/ph_r7a/VALIDATION.md")).toContain("| P1 | npm test |");
  });

  it("eval-review writes EVAL-REVIEW.md; a flawed verdict still records the written path", async () => {
    const t = await setup({
      review: [reply({ findings: [], coverage: { dim: "covered" }, flawed: false, document: "# Eval review\n\nAll dimensions covered.\n", handoff: "review done" })],
    }, { resolveWorkflow: (id) => builtinWorkflow(id) });
    dispose = t.dispose;
    const sound = await t.start(await builtin("eval-review"), { phase_id: "ph_r7b" }).done;
    expect(sound.status, sound.error ?? undefined).toBe("succeeded");
    expect(sound.output).toMatchObject({ status: "sound", review_path: ".agents/phases/ph_r7b/EVAL-REVIEW.md" });
    expect(file(t.checkout, ".agents/phases/ph_r7b/EVAL-REVIEW.md")).toContain("All dimensions covered");

    const u = await setup({
      review: [reply({ findings: [{ file: "eval.ts", line: 1, severity: "high", evidence: "gold set written after tuning", dimension: "leakage" }], coverage: { dim: "missing" }, flawed: true, document: "# Eval review\n\nLeakage found.\n", handoff: "flawed" })],
    }, { resolveWorkflow: (id) => builtinWorkflow(id) });
    dispose = u.dispose;
    const flawed = await u.start(await builtin("eval-review"), { phase_id: "ph_r7c" }).done;
    expect(flawed.status, flawed.error ?? undefined).toBe("succeeded");
    expect(flawed.output).toMatchObject({ status: "flawed", review_path: ".agents/phases/ph_r7c/EVAL-REVIEW.md" });
    expect(file(u.checkout, ".agents/phases/ph_r7c/EVAL-REVIEW.md")).toContain("Leakage found");
  });

  it("secure-phase appends the status table to an existing SECURITY.md without losing it", async () => {
    const t = await setup({
      audit: [reply({ open: [], status_table: "\n## Threat register status\n\n| Threat | Disposition |\n| --- | --- |\n| T1 | mitigated src/a.ts:9 |\n", handoff: "secure done" })],
    });
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/phases/ph_r7d"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/phases/ph_r7d/SECURITY.md"), "# Security\n\n## Threats\n\n- T1: injection\n");
    const summary = await t.start(await builtin("secure-phase"), { phase_id: "ph_r7d" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", security_path: ".agents/phases/ph_r7d/SECURITY.md" });
    const written = file(t.checkout, ".agents/phases/ph_r7d/SECURITY.md")!;
    expect(written).toContain("## Threats");
    expect(written).toContain("## Threat register status");
    expect(written.indexOf("## Threats")).toBeLessThan(written.indexOf("## Threat register status"));
  });

  it("ai-integration-phase persists model research and AI-SPEC, and the rework edge delivers check.gaps to spec visit 2", async () => {
    const specPrompts: string[] = [];
    const t = await setup({
      select: [reply({ framework: "jev", options: [{ name: "jev" }], scores: {}, document: "# Model notes\n\n- jev\n", handoff: "selected" })],
      research: [reply({ notes: "n", quick_reference: "qr", implementation_notes: "in", domain_notes: "dn", handoff: "researched" })],
      eval_plan: [reply({ eval_plan: "gold set of 30", handoff: "eval planned" })],
      spec: [() => { specPrompts.push(String(t.spawned.at(-1)!.prompt)); return reply({ document: "# AI-SPEC v1\n", handoff: "spec v1" }); },
             () => { specPrompts.push(String(t.spawned.at(-1)!.prompt)); return reply({ document: "# AI-SPEC v2\n\nAll sections present.\n", handoff: "spec v2" }); }],
      check: [reply({ ok: false, gaps: ["missing ## Evaluation", "no cost line"], handoff: "gaps found" }),
              reply({ ok: true, gaps: [], handoff: "clean" })],
    });
    dispose = t.dispose;
    const run = t.start(await builtin("ai-integration-phase"), { goal: "add a typed judgment", phase_id: "ph_r7e" });
    const summary = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error("STALL: " + JSON.stringify((t.db as never as { prepare(s: string): { all(...a: unknown[]): Row[] } }).prepare("SELECT node_id,state,substr(error,1,200) e FROM lane_pilot_wf_step WHERE run_id=?").all(run.runId)) + " spawns=" + t.spawned.length + " sends=" + t.sends.length)), 20000))]) as Awaited<typeof run.done>;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", framework: "jev", spec_path: ".agents/phases/ph_r7e/AI-SPEC.md" });
    expect(file(t.checkout, ".agents/phases/ph_r7e/AI-SPEC.md")).toBe("# AI-SPEC v2\n\nAll sections present.\n");
    const modelNote = readdirSync(join(t.checkout, ".agents/research")).find((name) => name.startsWith("model-") && name.endsWith(".md"));
    expect(modelNote).toBeTruthy();
    expect(file(t.checkout, `.agents/research/${modelNote}`)).toBe("# Model notes\n\n- jev\n");
    expect(specPrompts).toHaveLength(2);
    // The rework visit reuses the spec thread, so its prompt goes out as a follow-up send: the check.gaps edge mapping must land in it.
    const followUp = JSON.stringify(t.sends.map((send) => send.input));
    expect(followUp).toContain("missing ## Evaluation");
    expect(followUp).toContain("no cost line");
  });

  it("spike persists the experiment document under .agents/planning/spikes/ and the goal check passes on it", async () => {
    const t = await setup({
      experiment: [reply({ answered: true, decision: "use sqlite WAL", document: "# Spike: journal mode\n\nWAL wins.\n", skill_draft: "", handoff: "answered" })],
    });
    dispose = t.dispose;
    const summary = await t.start(await builtin("spike"), { question: "which journal mode" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    const spikePath = String((summary.output as Row).spike_path);
    expect(summary.output).toMatchObject({ status: "answered" });
    expect(spikePath).toMatch(/^\.agents\/planning\/spikes\/which-journal-mode-\d{4}-\d{2}-\d{2}\.md$/);
    const spike = file(t.checkout, spikePath)!;
    expect(spike).toContain("# Spike — which journal mode");
    expect(spike).toContain("WAL wins");
  });

  it("spike refuses a wrap_skill that is not a single safe segment and writes no skill file", async () => {
    for (const unsafe of ["~root", "..", "a/b", "a\\b", ".hidden"]) {
      const t = await setup({
        experiment: [reply({ answered: true, decision: "d", document: "# Spike\n", skill_draft: "# skill\n", handoff: "answered" })],
      });
      dispose = t.dispose;
      const summary = await t.start(await builtin("spike"), { question: "which journal mode " + unsafe, wrap_skill: unsafe }).done;
      expect(summary.status, `${unsafe} was not refused`).toBe("failed");
      expect(readdirSync(join(t.checkout, ".agents"), { withFileTypes: false }).includes("forge")).toBe(false);
    }
  });

  it("project-start persists the value map, never overwrites existing REQUIREMENTS.md (.new.md) and writes the roadmap skeleton", async () => {
    const t = await setup({
      value_map: [reply({ document: "# Value map\n\nFor the maker.\n", handoff: "mapped" })],
      preview: [reply({ stack: { lang: "ts" }, memory: {}, handoff: "previewed" })],
      research: [reply({ research_notes: "three competitors", stack: "# Stack\n\n- vite\n", features: "", architecture: "# Arch\n\n- rooms\n", pitfalls: "", handoff: "researched" })],
      requirements: [reply({ requirements: ["REQ-1", "REQ-2"], document: "\n## Requirements\n\n- REQ-1: first\n- REQ-2: second\n", handoff: "required" })],
      recap: [reply({ next_steps: ["step one"], roadmap_draft: "# Roadmap\n\n- phase one\n", project_document: "# Project\n\n## Vision\n\nFor makers.\n", phases: ["1 the first phase"], handoff: "recapped" })],
    });
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "# Requirements\n\n- REQ-0: existing\n");
    const summary = await t.start(await builtin("project-start"), { goal: "start the project" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done" });
    expect(file(t.checkout, ".agents/planning/VALUE-MAP.md")).toBe("# Value map\n\nFor the maker.\n");
    expect(file(t.checkout, ".agents/planning/REQUIREMENTS.md")).toBe("# Requirements\n\n- REQ-0: existing\n");
    expect(file(t.checkout, ".agents/planning/REQUIREMENTS.new.md")).toContain("REQ-2: second");
    const roadmap = file(t.checkout, ".agents/planning/ROADMAP.md")!;
    expect(roadmap).toContain("# Roadmap\n\n- phase one");
    expect(roadmap).toContain("- [ ] 1 the first phase");
    expect(file(t.checkout, ".agents/planning/research/STACK.md")).toBe("# Stack\n\n- vite\n");
    expect(file(t.checkout, ".agents/planning/research/FEATURES.md")).toBeNull();
    // profile_write already seeded PROJECT.md, so the recap document lands in the non-overwrite sibling, the existing file untouched
    expect(file(t.checkout, ".agents/planning/PROJECT.new.md")).toBe("# Project\n\n## Vision\n\nFor makers.\n");
    expect(file(t.checkout, ".agents/planning/PROJECT.md")).toContain("Developer preferences");
  });

  it("new-milestone appends the requirements block, keeping the existing file", async () => {
    const t = await setup({
      frame: [reply({ phases: ["phase-a", "phase-b"], document: "\n- REQ-A: alpha\n- REQ-B: beta\n", handoff: "framed" })],
    });
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "# Requirements\n\n- REQ-OLD: kept\n");
    const summary = await t.start(await builtin("new-milestone"), { goal: "second milestone" }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", phases: ["phase-a", "phase-b"] });
    const reqs = file(t.checkout, ".agents/planning/REQUIREMENTS.md")!;
    expect(reqs).toContain("REQ-OLD: kept");
    expect(reqs).toContain("REQ-B: beta");
    const roadmap = file(t.checkout, ".agents/planning/ROADMAP.md")!;
    expect(roadmap).toContain("- [ ] phase-a — second milestone");
    expect(roadmap).toContain("- [ ] phase-b — second milestone");
  });

  it("ship appends the deploy record, goal_check validates that path, and review range honors $inputs.head", async () => {
    const codeReview = wf({
      id: "code-review",
      inputs: [{ name: "range", type: "string" }],
      outputs: [{ name: "status", type: "enum", values: ["pass", "rework", "block"] }],
      nodes: [{ id: "do", type: "action", action: "emit", map: { status: "'pass'" } }],
      edges: [{ from: "start", to: "do" }],
    });
    const t = await setup({
      preflight: [reply({ ready: true, held_by: [], handoff: "preflight ok" })],
      open_pr: [reply({ pr_url: "https://example.invalid/pr/7", deploy_entry: "- 2026-11-16 ph_r7 shipped https://example.invalid/pr/7\n", handoff: "shipped" })],
    }, {
      resolveWorkflow: (id) => (id === "code-review" ? codeReview : builtinWorkflow(id)),
    });
    dispose = t.dispose;
    const summary = await t.start(await builtin("ship"), { phase_id: "ph_r7s", base: "main", head: "feature-ship", review: true }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "shipped", pr_url: "https://example.invalid/pr/7" });
    expect(file(t.checkout, ".agents/deploys.log")).toBe("- 2026-11-16 ph_r7 shipped https://example.invalid/pr/7\n");
    expect(childInputs(t.db as never, summary.runId)["code-review"]).toMatchObject({ range: "main..feature-ship" });
  });

  it("ship review range falls back to the current HEAD when $inputs.head is absent", async () => {
    const codeReview = wf({
      id: "code-review",
      inputs: [{ name: "range", type: "string" }],
      outputs: [{ name: "status", type: "enum", values: ["pass", "rework", "block"] }],
      nodes: [{ id: "do", type: "action", action: "emit", map: { status: "'pass'" } }],
      edges: [{ from: "start", to: "do" }],
    });
    const t = await setup({
      preflight: [reply({ ready: true, held_by: [], handoff: "preflight ok" })],
      open_pr: [reply({ pr_url: "https://example.invalid/pr/8", deploy_entry: "- 2026-11-16 ph_r7 shipped https://example.invalid/pr/8\n", handoff: "shipped" })],
    }, {
      resolveWorkflow: (id) => (id === "code-review" ? codeReview : builtinWorkflow(id)),
    });
    dispose = t.dispose;
    const summary = await t.start(await builtin("ship"), { phase_id: "ph_r7s2", base: "release/1.0", review: true }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(childInputs(t.db as never, summary.runId)["code-review"]).toMatchObject({ range: "release/1.0..HEAD" });
  });

  it("milestone-close's retro appends changed limits to an existing PROJECT.md and creates none when absent", async () => {
    const lpClose = wf({
      id: "lp.close",
      inputs: ["goals", "goal", "merged_commits", "insights"].map((name) => ({ name, type: "any" })),
      outputs: [
        { name: "status", type: "enum", values: ["ok", "low_confidence", "done", "partial", "rework", "pass", "closed", "failed", "inconclusive"] },
        { name: "staged", type: "number" }, { name: "report_path", type: "string" },
      ],
      nodes: [{ id: "do", type: "action", action: "emit", map: { status: "'closed'", staged: "0", report_path: "'.agents/milestones/close.md'" } }],
      edges: [{ from: "start", to: "do" }],
    });
    const t = await setup({
      retro: [reply({ insights: [], metrics: {}, document: "# Retro — milestone 2\n\n- INS-00000001 pacing\n", project_update: "\n## Limits (milestone 2)\n\n- context budget kept under 80%\n", handoff: "retro done" })],
      summary: [reply({ section: "# Milestone 2 summary\n", open_items: [], handoff: "summarized" })],
    }, {
      resolveWorkflow: (id) => (id === "lp.close" ? lpClose : builtinWorkflow(id)),
      human: () => ({ answer: "", answer_kind: "timeout" }),
    });
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/PROJECT.md"), "# Project\n\n## Vision\n\nShip it.\n");
    const run = t.start(await builtin("milestone-close"), { goal: "milestone 2", goals: [] });
    const summary = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error("STALL: " + JSON.stringify((t.db as never as { prepare(q: string): { all(...a: unknown[]): Row[] } }).prepare("SELECT node_id,state,substr(error,1,160) e FROM lane_pilot_wf_step WHERE run_id=?").all(run.runId)) + " spawns=" + t.spawned.length + " sends=" + t.sends.length)), 20000))]) as Awaited<typeof run.done>;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    const project = file(t.checkout, ".agents/planning/PROJECT.md")!;
    expect(project).toContain("## Vision");
    expect(project).toContain("## Limits (milestone 2)");
    expect(project.indexOf("## Vision")).toBeLessThan(project.indexOf("## Limits (milestone 2)"));
  });

  it("milestone-close's retro leaves no PROJECT.md write when the helper returns an empty update", async () => {
    const lpClose = wf({
      id: "lp.close",
      inputs: ["goals", "goal", "merged_commits", "insights"].map((name) => ({ name, type: "any" })),
      outputs: [
        { name: "status", type: "enum", values: ["ok", "low_confidence", "done", "partial", "rework", "pass", "closed", "failed", "inconclusive"] },
        { name: "staged", type: "number" }, { name: "report_path", type: "string" },
      ],
      nodes: [{ id: "do", type: "action", action: "emit", map: { status: "'closed'", staged: "0", report_path: "'.agents/milestones/close.md'" } }],
      edges: [{ from: "start", to: "do" }],
    });
    const t = await setup({
      retro: [reply({ insights: [], metrics: {}, document: "# Retro — milestone 3\n", project_update: "\n## Limits\n\n- should never land\n", handoff: "retro done" })],
      summary: [reply({ section: "# Milestone 3 summary\n", open_items: [], handoff: "summarized" })],
    }, {
      resolveWorkflow: (id) => (id === "lp.close" ? lpClose : builtinWorkflow(id)),
      human: () => ({ answer: "", answer_kind: "timeout" }),
    });
    dispose = t.dispose;
    const run = t.start(await builtin("milestone-close"), { goal: "milestone 3", goals: [] });
    const summary = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error("STALL: " + JSON.stringify((t.db as never as { prepare(q: string): { all(...a: unknown[]): Row[] } }).prepare("SELECT node_id,state,substr(error,1,160) e FROM lane_pilot_wf_step WHERE run_id=?").all(run.runId)) + " spawns=" + t.spawned.length + " sends=" + t.sends.length)), 20000))]) as Awaited<typeof run.done>;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(file(t.checkout, ".agents/planning/PROJECT.md")).toBeNull();
  });

  it("lp.phase_add preserves every byte of a >4000-line ROADMAP.md and refuses a truncated read outright", async () => {
    const phaseAdd = wf({
      id: "t-phase-add",
      inputs: [{ name: "phases", type: "any" }],
      outputs: [],
      nodes: [{ id: "add", type: "action", action: "lp.phase_add", params: { goal: "grow" }, output: [{ name: "added", type: "array" }, { name: "count", type: "number" }] }],
      edges: [{ from: "start", to: "add" }, { from: "add", to: "end" }],
    });
    const bigRoadmap = Array.from({ length: 5000 }, (_, i) => `- [x] phase ${i + 1} — done`).join("\n") + "\n\n## Backlog\n\n- later\n";
    {
      const t = await setup({});
      dispose = t.dispose;
      mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
      writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), bigRoadmap);
      const summary = await t.start(phaseAdd, { phases: ["1 coverage", "2 the gate"] }).done;
      expect(summary.status, summary.error ?? undefined).toBe("succeeded");
      const after = file(t.checkout, ".agents/planning/ROADMAP.md")!;
      expect(after.startsWith("- [x] phase 1 — done")).toBe(true);
      expect(after).toContain("- [x] phase 5000 — done");
      const backlogAt = after.indexOf("## Backlog");
      expect(backlogAt).toBeGreaterThan(0);
      expect(after.slice(0, backlogAt)).toContain("- [ ] 1 coverage — grow");
      expect(after.slice(0, backlogAt)).toContain("- [ ] 2 the gate — grow");
      expect(after.endsWith("- later\n")).toBe(true);
    }
    {
      // The read answers a sliced body under the whole-file hash (truncated:true): the action must refuse,
      // never CAS-write the slice plus rows — the tail past the cap would be silently dropped.
      const t = await setup({}, { truncateReads: true });
      dispose = t.dispose;
      mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
      writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), bigRoadmap);
      const summary = await t.start(phaseAdd, { phases: ["1 coverage"] }).done;
      expect(summary.status).toBe("failed");
      expect(file(t.checkout, ".agents/planning/ROADMAP.md")).toBe(bigRoadmap);
    }
  });

  it("lp.phase_add treats only file-shaped absence as create-only, and marks engine writes solely after a written receipt", async () => {
    const phaseAdd = wf({
      id: "t-phase-add-miss",
      inputs: [{ name: "phases", type: "any" }],
      outputs: [],
      nodes: [{ id: "add", type: "action", action: "lp.phase_add", params: { goal: "grow" }, output: [{ name: "added", type: "array" }, { name: "count", type: "number" }] }],
      edges: [{ from: "start", to: "add" }, { from: "add", to: "end" }],
    });
    {
      // The SDK's real absent shape — code unknown_error carrying a file-scoped serverCode — is absence:
      // the create-only write lands and the path is marked engine-written after the receipt.
      const t = await setup({}, { readError: { code: "unknown_error", serverCode: "file_not_found" } });
      dispose = t.dispose;
      const summary = await t.start(phaseAdd, { phases: ["1 coverage"] }).done;
      expect(summary.status, summary.error ?? undefined).toBe("succeeded");
      expect(file(t.checkout, ".agents/planning/ROADMAP.md")).toContain("- [ ] 1 coverage — grow");
      expect(writtenByEngineSince(t.checkout, 0).has(".agents/planning/ROADMAP.md".replace(/^\.?\/+/, ""))).toBe(true);
    }
    {
      // `project_not_found` is not file absence: the run refuses and nothing is written or marked.
      const t = await setup({}, { readError: { code: "unknown_error", serverCode: "project_not_found" } });
      dispose = t.dispose;
      const summary = await t.start(phaseAdd, { phases: ["1 coverage"] }).done;
      expect(summary.status, JSON.stringify((t.db as never as { prepare(q: string): { all(...a: unknown[]): Row[] } }).prepare("SELECT node_id,state,substr(error,1,200) e FROM lane_pilot_wf_step WHERE run_id=?").all(summary.runId))).toBe("failed");
      expect(file(t.checkout, ".agents/planning/ROADMAP.md")).toBeNull();
      expect(writtenByEngineSince(t.checkout, 0).size).toBe(0);
    }
    {
      // A CAS conflict throws before the receipt: no bytes land and the engine-write mark stays empty.
      const t = await setup({}, { writeOutcome: "conflict" });
      dispose = t.dispose;
      const summary = await t.start(phaseAdd, { phases: ["1 coverage"] }).done;
      expect(summary.status).toBe("failed");
      expect(file(t.checkout, ".agents/planning/ROADMAP.md")).toBeNull();
      expect(writtenByEngineSince(t.checkout, 0).size).toBe(0);
    }
  });

  it("a diverted ROADMAP.new.md receives the phase rows while the existing ROADMAP.md stays byte for byte", async () => {
    const writeThenAdd = wf({
      id: "t-roadmap-divert",
      inputs: [{ name: "phases", type: "any" }],
      outputs: [],
      nodes: [
        { id: "write", type: "action", action: "fs.write", params: { path: ".agents/planning/ROADMAP.md", contents: "# fresh roadmap\n", mode: "non_overwrite" }, output: [{ name: "roadmap_path", type: "string" }] },
        { id: "add", type: "action", action: "lp.phase_add", params: { goal: "grow", path: "{{write.roadmap_path}}" }, output: [{ name: "added", type: "array" }, { name: "count", type: "number" }] },
      ],
      edges: [{ from: "start", to: "write" }, { from: "write", to: "add" }, { from: "add", to: "end" }],
    });
    const original = "# Existing roadmap\n\n- [x] old phase — kept\n\n## Backlog\n\n- later\n";
    const t = await setup({});
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), original);
    const summary = await t.start(writeThenAdd, { phases: ["1 coverage", "2 the gate"] }).done;
    expect(summary.status, summary.error ?? undefined).toBe("succeeded");
    expect(file(t.checkout, ".agents/planning/ROADMAP.md")).toBe(original);
    const diverted = file(t.checkout, ".agents/planning/ROADMAP.new.md")!;
    expect(diverted).toContain("# fresh roadmap");
    expect(diverted).toContain("- [ ] 1 coverage — grow");
    expect(diverted).toContain("- [ ] 2 the gate — grow");
  });
});
