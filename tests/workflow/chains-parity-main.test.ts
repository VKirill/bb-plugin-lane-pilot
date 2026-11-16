import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("hollow sign-2 workflow branches: debug", () => {
  it("resumes a short standalone session through the new symptom form, and a long session goes straight to investigation", async () => {
    const resumed = await runSim("debug", {
      input: { symptom: "it crashes", mode: "standalone", session: "short-session" },
      stubs: { session: { found: false, path: ".agents/planning/debug/short-session.md" }, investigate: { status: "partial", confidence: 40 } },
    });
    expect(pathOf(resumed)).toBe("ask_symptoms session ask_symptoms_new investigate write_investigation_session write_investigation_evidence partial");

    const long = await runSim("debug", {
      input: { symptom: "The import crashes after the last release when an empty row reaches the parser.", session: "long-session" },
      stubs: { session: { found: true, path: ".agents/planning/debug/long-session.md" }, investigate: { status: "partial", confidence: 40 } },
    });
    expect(pathOf(long)).toBe("ask_symptoms session investigate write_investigation_session write_investigation_evidence partial");
  });

  it("takes failure reports to the real per-failure diagnosis join and records diagnosed", async () => {
    const r = await runSim("debug", {
      input: { failures: [{ file: "src/parser.ts", severity: "high", evidence: "empty row" }, { file: "src/import.ts", severity: "high", evidence: "undefined" }], mode: "from_failures" },
    });
    expect(pathOf(r)).toBe("ask_symptoms normalize diagnose diagnosed");
    expect(r.called("diagnose:child")).toHaveLength(2);

    const resumed = await runSim("debug", {
      input: { failures: [{ file: "src/parser.ts", severity: "high", evidence: "empty row" }, { file: "src/import.ts", severity: "high", evidence: "undefined" }], mode: "from_failures", session: "failure-session" },
      stubs: { session: { found: true, path: ".agents/planning/debug/failure-session.md" } },
    });
    expect(pathOf(resumed)).toBe("ask_symptoms session normalize diagnose diagnosed");

    const fallback = await runSim("debug", {
      input: { failures: [{ file: "src/parser.ts", severity: "high", evidence: "empty row" }, { file: "src/import.ts", severity: "high", evidence: "undefined" }], mode: "from_failures", session: "missing-failure-session" },
      stubs: { session: { found: false, path: ".agents/planning/debug/missing-failure-session.md" } },
    });
    expect(pathOf(fallback)).toBe("ask_symptoms session normalize diagnose diagnosed");
  });

  it("returns inconclusive after repeated failed confirmation, and preserves the investigation fallback", async () => {
    const inconclusive = await runSim("debug", {
      input: { symptom: "The import crashes after the last release when an empty row reaches the parser." },
      mode: "full",
      stubs: { investigate: { status: "inconclusive", refuted: 1, confidence: 20 } },
    });
    expect(pathOf(inconclusive)).toBe("ask_symptoms investigate write_investigation_session write_investigation_evidence inconclusive");

    const confirmationPartial = await runSim("debug", {
      input: { symptom: "The import crashes after the last release when an empty row reaches the parser." },
      mode: "full",
      stubs: { investigate: { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["src/parser.ts"] }, verify_cause: { confirmed: false, objections: ["another cause"] } },
    });
    expect(pathOf(confirmationPartial)).toBe("ask_symptoms investigate write_investigation_session write_investigation_evidence verify_cause write_verification_session write_verification_evidence investigate write_investigation_session write_investigation_evidence verify_cause write_verification_session write_verification_evidence investigate write_investigation_session write_investigation_evidence verify_cause write_verification_session write_verification_evidence partial");
    expect(confirmationPartial.called("verify_cause")).toHaveLength(3);
  });
});

describe("hollow sign-2 workflow branches: deploy", () => {
  const input = { target: "lane-pilot-plugin", environment: "prod", incident: "" };
  const ready = { clean: true, pushed: true, running_attempts: 0, gate_ok: true, deployed_today: false, last_version: "0.1.182" };
  const base = () => ({ preflight: ready, tests: { ok: true }, push_plugin: { ok: true, version: "0.1.183", log_path: "deploys.log" }, post_check: { ok: true }, record: { staged: 1 } });

  it("blocks failed tests, failed plugin push, and a timed-out rollback decision", async () => {
    const tests = await runSim("deploy", { input: { ...input, target: "ssh", environment: "staging" }, stubs: { preflight: ready, tests: { ok: false, tests_failed: 3 } } });
    expect(pathOf(tests)).toBe("preflight tests blocked");

    const push = await runSim("deploy", { input, stubs: { ...base(), push_plugin: { ok: false, log_path: "deploys.log" } }, humans: { approve: { answer_kind: "deploy" } } });
    expect(pathOf(push)).toBe("preflight tests approve push_plugin failed");

    const timeout = await runSim("deploy", { input, stubs: { ...base(), post_check: { ok: false, details: "old version" } }, humans: { approve: { answer_kind: "deploy" }, ask_rollback: { answer_kind: "timeout" } } });
    expect(pathOf(timeout)).toBe("preflight tests approve push_plugin post_check ask_rollback failed");

    const leave = await runSim("deploy", { input, stubs: { ...base(), post_check: { ok: false, details: "old version" } }, humans: { approve: { answer_kind: "deploy" }, ask_rollback: { answer_kind: "leave" } } });
    expect(pathOf(leave)).toBe("preflight tests approve push_plugin post_check ask_rollback failed");
  });

  it("records a failed rollback and a failed non-plugin deployment", async () => {
    const rollback = await runSim("deploy", { input, stubs: { ...base(), post_check: { ok: false }, rollback: { ok: false } }, humans: { approve: { answer_kind: "deploy" }, ask_rollback: { answer_kind: "rollback" } } });
    expect(pathOf(rollback)).toBe("preflight tests approve push_plugin post_check ask_rollback rollback failed");

    const other = await runSim("deploy", { input: { target: "ssh", environment: "staging", accounts: ["PROD_SSH"], deploy_steps: "rsync dist/ to /var/www" }, stubs: { preflight: ready, tests: { ok: true }, run_deploy: { ok: false, log_path: "deploy.log", backup_path: "/b" } } });
    expect(pathOf(other)).toBe("preflight tests approve run_deploy failed");
  });
});

describe("hollow sign-2 workflow branches: issue-quick", () => {
  const input = { title: "Fix parser", text: "Handle an empty final row", context: "src/parser.ts" };
  const plan = { status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, tasks: [{ id: "q1" }], task: { id: "q1" }, waves: [["q1"]] };
  const goodClass = { size: "small", risk: "low", severity: "medium" };

  it("takes the explicit discussion and research detours, or research directly", async () => {
    const both = await runSim("issue-quick", { input: { ...input, discuss: true, research: true }, stubs: { class: goodClass, discuss: { answer_kind: "answered", answer: "the parser owns this" }, research: { notes: "the empty row is a known input" }, plan: { ...plan, status: "failed", clear: true } } });
    expect(pathOf(both)).toBe("class discuss research plan partial");
    expect(out(both)).toMatchObject({ status: "partial" });

    const research = await runSim("issue-quick", { input: { ...input, research: true }, stubs: { class: goodClass, research: { notes: "the input contract needs a guard" }, plan: { ...plan, status: "failed", clear: true } } });
    expect(pathOf(research)).toBe("class research plan partial");

    const discussOnly = await runSim("issue-quick", { input: { ...input, discuss: true }, stubs: { class: goodClass, discuss: { answer_kind: "answered", answer: "the parser owns this" }, plan: { ...plan, status: "failed", clear: true } } });
    expect(pathOf(discussOnly)).toBe("class discuss plan partial");
  });

  it("reworks a validation failure into the same plan, then blocks on a failed lint", async () => {
    const r = await runSim("issue-quick", { input: { ...input, validate: true }, stubs: { class: goodClass, plan, validate: [{ verdict: "rework", notes: "acceptance is too weak" }, { verdict: "ok", notes: "fixed" }], lint: { ok: false } } });
    expect(pathOf(r)).toBe("class plan validate plan validate lint partial");
  });

  it("sends full and medium writers to their distinct partial and review branches", async () => {
    const fullPartial = await runSim("issue-quick", { input: { ...input, full: true }, stubs: { class: goodClass, plan, lint: { ok: true }, validate: { verdict: "ok", notes: "accepted" }, "write-full": { state: "blocked", merged_commits: [] } } });
    expect(pathOf(fullPartial)).toBe("class plan validate lint write-full partial");

    const mediumPartial = await runSim("issue-quick", { input, stubs: { class: { ...goodClass, risk: "medium" }, plan: { ...plan, risk: "medium" }, lint: { ok: true }, "write-medium": { state: "blocked", merged_commits: [] } } });
    expect(pathOf(mediumPartial)).toBe("class plan lint write-medium partial");

    const lowReview = await runSim("issue-quick", { input: { ...input, validate: true }, stubs: { class: goodClass, plan, lint: { ok: true }, write: { state: "accepted", merged_commits: ["q1"] }, "lp.review": { status: "pass", critical_count: 0, high_count: 0, findings: [] }, state: { ok: true } } });
    expect(pathOf(lowReview)).toBe("class plan validate lint write review state closed_reviewed");

    const fullReview = await runSim("issue-quick", { input: { ...input, full: true }, stubs: { class: goodClass, plan, lint: { ok: true }, validate: { verdict: "ok", notes: "accepted" }, "write-full": { state: "accepted", merged_commits: ["q1"] }, "lp.review": { status: "pass", critical_count: 0, high_count: 0, findings: [] }, state: { ok: true } } });
    expect(pathOf(fullReview)).toBe("class plan validate lint write-full review state closed_reviewed");

    const mediumReview = await runSim("issue-quick", { input: { ...input, validate: true }, stubs: { class: { ...goodClass, risk: "medium" }, plan: { ...plan, risk: "medium" }, validate: { verdict: "ok", notes: "accepted" }, lint: { ok: true }, "write-medium": { state: "accepted", merged_commits: ["q1"] }, "lp.review": { status: "pass", critical_count: 0, high_count: 0, findings: [] }, state: { ok: true } } });
    expect(pathOf(mediumReview)).toBe("class plan validate lint write-medium review state closed_reviewed");
  });
});

describe("hollow sign-2 workflow branches: fragments", () => {
  it("lets the owner choose and advise after an analysis, including the full second opinion", async () => {
    const asked = await runSim("lp.analyze", { input: { goal: "choose an approach", ask_owner: true, owner_card: "owner" }, stubs: { assess: { open_questions: ["which boundary"], confidence: 90, scope_verdict: "small" }, choose: { answer_kind: "chosen", chosen: "keep the API" } } });
    expect(pathOf(asked)).toBe("gather assess choose advise done");

    const full = await runSim("lp.analyze", { input: { goal: "choose an approach", ask_owner: true, owner_card: "owner" }, mode: "full", stubs: { assess: { open_questions: ["which boundary"], confidence: 90, scope_verdict: "small" }, second_opinion: { consensus: [], conflicts: [], unique: [], consensus_level: 90 }, choose: { answer_kind: "chosen", chosen: "keep the API" } } });
    expect(pathOf(full)).toBe("gather assess second_opinion choose advise done");
  });

  it("keeps a docs unit at skipped verification when the real prepare and verify results say skipped", async () => {
    const prepareSkipped = await runSim("lp.docs-night", { input: { project_id: "p", host_id: "h", path: "/docs", unit: { docsDir: "docs" } }, stubs: { prepare: { state: "skipped", row: { state: "skipped" } } } });
    expect(pathOf(prepareSkipped)).toBe("prepare skipped-prepare");

    const verifySkipped = await runSim("lp.docs-night", { input: { project_id: "p", host_id: "h", path: "/docs", unit: { docsDir: "docs" } }, stubs: { prepare: { state: "ready", row: { state: "writing" }, plan: { pages: ["docs/a.md"] } }, write: { state: "written", thread_id: "thr-docs" }, verify: { state: "skipped", row: { state: "skipped" } } } });
    expect(pathOf(verifySkipped)).toBe("prepare write verify skipped-verify");
  });

  it("takes lp.draw material into draw, and lp.review's structural prepass can end directly at aggregate", async () => {
    const drawn = await runSim("lp.draw", { input: { goal: "a settings page", pieces: "settings", folder: ".agents/phases/ph_1", material: true }, stubs: { material: { material_path: ".agents/phases/ph_1/design/MATERIAL.md" }, draw: { paths: ["a.html"], feasible: true, contradiction: "" }, check: { verdict: "pass", notes: "ok" } } });
    expect(pathOf(drawn)).toBe("material draw check done");
    expect(out(drawn)).toMatchObject({ paths: ["a.html"], verdict: "pass" });

    const prepass = await runSim("lp.review", { input: { dimensions: ["correctness"] }, mode: "quick", stubs: { prepass: { rework: true, findings: [{ file: "src/a.ts", line: 1, severity: "medium" }], critical_count: 0 } } });
    expect(pathOf(prepass)).toBe("scope prepass aggregate result");
  });

  it("can block clarification and can leave a delivered research artifact partial when goal validation fails", async () => {
    const blocked = await runSim("web-research", { input: { question: "which compiler?" }, stubs: { frame: { needs_clarification: true, clarification: "which compiler?", subquestions: [] } }, humans: { ask: { answer_kind: "timeout", answer: "" } } });
    expect(pathOf(blocked)).toBe("frame ask blocked");

    const partial = await runSim("web-research", {
      input: { question: "compare two compilers" },
      stubs: {
        frame: { subquestions: ["compiler one"], sub_count: 1, needs_clarification: false },
        "search:child": { subquestion: "compiler one", sources: [{ url: "https://example.com/one", title: "One", snippet: "source" }] },
        claims: { claim_count: 1, claims: [], unverified: [], counter: [] },
        report: { report_md: "A [1].", cited_ids: ["1"], sources: [{ url: "https://example.com/one", title: "One", snippet: "source" }] },
        deliver: { report_path: "reports/compiler.md" },
        goal_check: { ok: false, verdict: "fail", reason: "missing comparison", details: {} },
      },
    });
    expect(pathOf(partial)).toBe("frame search claims report check deliver goal_check partial");
    expect(out(partial)).toMatchObject({ status: "partial" });
  });
});
