import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-tech-audit", () => {
  const input = { site_url: "https://example.ru" };
  const base = () => ({
    intake: { findings_paths: ["gsc.md", "crawl.md"], defects: [], skipped: false, skipped_branches: ["logs"] },
    agent_ready: { score: 14, blockers: 2, report_path: "agent-ready.json" },
    specialists: { findings_paths: ["index.md", "canonical.md"], defects: [], skipped: false, skipped_branches: [] },
    matrix: { matrix_path: "matrix.csv", rows: 24 },
    backlog: { backlog_path: "backlog.md", tickets: 6, release_items: [".agents/seo/release/r1/item.json"], code_tasks: [] },
    critic: { status: "pass", findings: [] },
    commit_intents: { intents: 1 },
    drain_outbox: { dispatched_count: 1, dispatched_ids: ["lptask_tech_1"] },
    package: { package_path: ".agents/seo/tech-audit/2026-11-06/" },
  });
  const humans = { access: { logs_path: "", crawl_path: "", answer_kind: "given" } };

  it("happy path: access -> intake -> agent_ready -> specialists -> matrix -> backlog -> critic -> intents -> drain -> package -> done", async () => {
    const r = await runSim("seo-tech-audit", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("access intake agent_ready specialists matrix backlog critic commit_intents drain_outbox package done");
    expect(out(r)).toMatchObject({ status: "done", backlog_path: "backlog.md", release_items: [".agents/seo/release/r1/item.json"], agent_ready_score: 14, dispatched_count: 1 });
  });

  it("a rework critic loops back to the backlog once", async () => {
    const r = await runSim("seo-tech-audit", {
      input,
      stubs: { ...base(), critic: [{ status: "rework", findings: [] }, { status: "pass", findings: [] }] },
      humans,
    });
    expect(pathOf(r)).toBe("access intake agent_ready specialists matrix backlog critic backlog critic commit_intents drain_outbox package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("changes no site: it emits release items and writer tasks, no publish node and no subworkflow", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-tech-audit")!.workflow;
    expect(workflow.nodes.filter((node) => node.type === "subworkflow")).toEqual([]);
  });
});

describe("seo-drop-diagnosis", () => {
  const input = { site_url: "https://example.ru", affected_urls: ["/catalog/a"] };
  const base = () => ({
    intake: { status: "proceed", freeze_due: "", log_path: "log.md", windows_path: "windows.md" },
    window_split: { drop_confirmed: true, seasonality: false, split_path: "split.json" },
    channel_isolation: { cause_channel: "organic", report_path: "channels.json" },
    mechanism: { mechanism_path: "mechanism.md", labels: ["ranking"] },
    scope: { scope: "template", scope_path: "scope.md" },
    layers: { findings_paths: ["layer.md"], defects: [], skipped: false, skipped_branches: [] },
    contour: { contour: "template", contour_path: "contour.md" },
    hypotheses: { hypotheses_path: "hypotheses.md", pilot_path: "pilot.md", top_count: 3, followup_orders: [] },
    critic: { status: "pass", findings: [] },
    package: { diagnosis_path: ".agents/seo/drop-diagnosis/2026-11-06/diagnosis.md" },
    followups: { intents: 1 },
    followups_drain: { dispatched_count: 1, dispatched_ids: ["wfrun_refresh_7"] },
  });
  const humans = { review: { answer: "pilot A", answer_kind: "approved" } };

  it("happy path: intake -> window_split -> channel_isolation -> mechanism -> scope -> layers -> contour -> hypotheses -> critic -> review -> package -> followups -> done", async () => {
    const r = await runSim("seo-drop-diagnosis", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("intake window_split channel_isolation mechanism scope layers contour hypotheses critic review package followups followups_drain done");
    expect(out(r)).toMatchObject({ status: "done", hypotheses_path: "hypotheses.md", pilot_path: "pilot.md", dispatched_count: 1 });
  });

  it("an active core update freezes the run until T_end+7 and touches nothing", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: { ...base(), intake: { status: "frozen", freeze_due: "2026-11-20", log_path: "log.md", windows_path: "" } },
    });
    expect(pathOf(r)).toBe("intake frozen");
    expect(out(r)).toMatchObject({ status: "frozen", freeze_due: "2026-11-20" });
  });

  it("demand contraction / seasonality exits early without diagnosing an organic drop", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: { ...base(), window_split: { drop_confirmed: false, seasonality: true, split_path: "split.json" } },
    });
    expect(pathOf(r)).toBe("intake window_split seasonal");
    expect(out(r)).toMatchObject({ status: "seasonal", diagnosis_path: "split.json" });
  });

  it("paid or tracking cause hands off to mkt-tracking-setup instead of diagnosing rankings", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: {
        ...base(),
        channel_isolation: { cause_channel: "tracking", report_path: "channels.json" },
        mkt_handoff: { intents: 1 },
        mkt_drain: { dispatched_count: 1, dispatched_ids: ["wfrun_tracking_9"] },
      },
    });
    expect(pathOf(r)).toBe("intake window_split channel_isolation mkt_handoff mkt_drain handed_off");
    expect(out(r)).toMatchObject({ status: "handed_off", dispatched_count: 1 });
  });

  it("a declined review keeps the diagnosis without a pilot", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: base(),
      humans: { review: { answer: "", answer_kind: "declined" } },
    });
    expect(pathOf(r)).toBe("intake window_split channel_isolation mechanism scope layers contour hypotheses critic review partial");
    expect(out(r)).toMatchObject({ status: "partial" });
  });
});
