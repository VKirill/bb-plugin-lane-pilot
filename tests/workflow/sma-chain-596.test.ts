import { describe, expect, it } from "vitest";
import { LOOP_HOOK_POINTS, parseLoopHookManifest } from "../../src/rooms/workflow/models/loop-hooks";
import { out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("0.1.596 SMA promoted nodes and workflow chain coverage (P06.02 / P06.05)", () => {
  it("[sma:k_wdi_hooks] active capability steps at discuss:pre are parsed from loop-hooks.manifest.json and unsupported points are refused", () => {
    expect(LOOP_HOOK_POINTS).toEqual(["discuss:pre", "plan:pre", "verify:post", "ship:post"]);
    const parsed = parseLoopHookManifest(JSON.stringify({
      schemaVersion: 1,
      hooks: {
        "discuss:pre": [{ workflow: "web-research", inputs: { question: "$inputs.goal" } }],
        "plan:pre": [],
        "verify:post": [],
        "ship:post": [],
      },
    }));
    expect(parsed.manifest?.hooks["discuss:pre"]).toEqual([{ workflow: "web-research", inputs: { question: "$inputs.goal" } }]);
    expect(() => parseLoopHookManifest(JSON.stringify({ schemaVersion: 1, hooks: { "unknown:pre": [] } }))).toThrow();
  });

  it("[sma:k_d_tpl_research] project-start writes STACK.md, FEATURES.md, ARCHITECTURE.md and PITFALLS.md each from its own research field", async () => {
    const written: Record<string, string> = {};
    await runSim("project-start", {
      input: { goal: "New SaaS" },
      humans: { ask: { answer: "ts", answer_kind: "answered" } },
      stubs: {
        tree: { enabled: "on", sources: 2, tests: 1, docs: 1, planning: 0, commits: 1, counts_note: "n", profile_note: "p", recap_note: "r" },
        probe: { has_passport: false, open_tasks: 0, plan_exists: false, has_ui: false, has_value_map: true, has_roadmap: false, has_profile: true },
        preview: { stack: {}, memory: {}, profile: { stack: "ts" } },
        profile_write: { refused: [], set: ["stack"], reasons: [] },
        research: { research_notes: "summary-note", stack: "S-DOC", features: "F-DOC", architecture: "A-DOC", pitfalls: "P-DOC" },
        requirements: { requirements: ["R1"], document: "# req" },
        recap: { next_steps: ["1"], roadmap_draft: "# road", project_document: "# proj", phases: ["1 mvp"] },
        "fs.write": (ctx) => {
          const params = (ctx.node as { params?: { contents?: string } }).params;
          written[ctx.nodeId] = ctx.render(String(params?.contents ?? ""));
          return {};
        },
      },
    });
    expect(written.write_research_stack).toBe("S-DOC");
    expect(written.write_research_features).toBe("F-DOC");
    expect(written.write_research_architecture).toBe("A-DOC");
    expect(written.write_research_pitfalls).toBe("P-DOC");
  });

  it("walks docs-synthesis resolved and open paths", async () => {
    const conflict = {
      topic: "mode",
      a_path: "ADR.md",
      a_line: 1,
      a_quote: "one",
      a_kind: "ADR",
      b_path: "PRD.md",
      b_line: 2,
      b_quote: "two",
      b_kind: "PRD",
      winner: "a",
      rule: "precedence",
    };
    const resolved = await runSim("docs-synthesis", {
      input: { paths: ["ADR.md", "PRD.md"], precedence: ["ADR", "PRD"] },
      stubs: {
        classify: { documents: [] },
        synth: { conflicts: [conflict] },
        "docs-synthesis-check": { ...conflict, auto_resolved: true, valid: true },
        write_md: { markdown_path: ".agents/planning/ingest/c.md" },
        write_json: { json_path: ".agents/planning/ingest/c.json" },
      },
    });
    expect(pathOf(resolved)).toBe("classify synth verify pick resolve write_md write_json done");
    expect(out(resolved)).toMatchObject({ status: "done", owner_response: "none" });

    const open = await runSim("docs-synthesis", {
      input: { paths: ["ADR.md", "PRD.md"] },
      humans: { resolve: { answer: "keep both", answer_kind: "keep_both" } },
      stubs: {
        classify: { documents: [] },
        synth: { conflicts: [{ ...conflict, winner: "none", rule: "none" }] },
        "docs-synthesis-check": { ...conflict, auto_resolved: false, valid: true },
        write_md: { markdown_path: ".agents/planning/ingest/c.md" },
        write_json: { json_path: ".agents/planning/ingest/c.json" },
      },
    });
    expect(pathOf(open)).toBe("classify synth verify pick resolve write_md write_json open");
    expect(out(open)).toMatchObject({ status: "open", owner_response: "keep_both" });
  });

  it("walks lp.clarify, lp.plan block edge, plan-review-convergence-proof changes edge, and test-gen fix_tests blocked edge", async () => {
    const clarify = await runSim("lp.clarify", {
      input: { goal: "export reports" },
      stubs: { analyst: { questions: [{ task: "t1", question: "format?" }] } },
    });
    expect(pathOf(clarify)).toBe("analyst done");

    const planBlocked = await runSim("lp.plan", {
      input: { goal: "add cache" },
      stubs: {
        plan: { tasks: [task("a"), task("b"), task("c")], task_count: 3 },
        plan_critic: { status: "block" },
      },
    });
    expect(pathOf(planBlocked)).toBe("research patterns strategy plan lint plan_critic failed");

    const convChanges = await runSim("plan-review-convergence-proof", {
      input: { phase_id: "ph_1", plan_sha: "sha1" },
      stubs: {
        critic_a: { decision: "changes_requested", findings: [{ claim: "gap" }] },
        critic_b: { decision: "approve", findings: [] },
        converge: { decision: "changes_requested", findings: [{ claim: "gap" }], rounds: 1 },
      },
    });
    expect(pathOf(convChanges)).toBe("critic_a critic_b converge changes");

    const tgBlocked = await runSim("test-gen", {
      input: { scope: "src/a.ts", gaps: [{ file: "src/a.ts", layer: "L1", priority: "high" }] },
      stubs: {
        baseline: { status: "measured", reason: "", receipt: {} },
        write_tests: { state: "accepted", merge_commit: "c1", files: ["tests/a.test.ts"] },
        run: { ok: false, no_framework: false, pass_rate: 0.5, tests_passed: 1, tests_failed: 1, failures: [{ test: "x", error: "e" }] },
        inventory: { status: "measured", reason: "", runner_ok: false, tests_added: 2, receipt: {} },
        classify: { test_defects: [{ test: "x", error: "e" }], code_defects: [], env_issues: [], test_defect_count: 1, converged: false },
        fix_tests: { state: "failed", merge_commit: "" },
      },
    });
    expect(pathOf(tgBlocked)).toBe("derive confirm baseline write_tests run inventory classify fix_tests blocked");
  });
});
