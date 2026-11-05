import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-project-intake", () => {
  const input = { site_url: "https://example.ru", offer: "продажа кофемашин" };
  const base = () => ({
    brandcore: { brandcore_path: "brandcore.md", open_facts: 2 },
    tech_gate: { tech_verdict: "pass", tech_path: "tech.md" },
    risk_flags: { flags_path: "flags.json", host_age: "established" },
    layer_verdict: { route: "seo-cocoon", broken_layer: "content" },
    critic: { status: "pass", findings: [] },
    package: { passport_path: ".agents/seo/example/project-passport.json" },
  });

  it("happy path: scope -> brandcore -> tech gate -> risk flags -> layer verdict -> critic -> package -> done", async () => {
    const r = await runSim("seo-project-intake", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("ask_scope brandcore tech_gate risk_flags layer_verdict critic package done");
    expect(r.skipped).toEqual(["ask_scope"]);
    expect(out(r)).toMatchObject({ status: "done", passport_path: ".agents/seo/example/project-passport.json", route: "seo-cocoon" });
  });

  it("a rework critic loops back to the layer verdict once", async () => {
    const r = await runSim("seo-project-intake", {
      input,
      stubs: { ...base(), critic: [{ status: "rework", findings: [] }, { status: "pass", findings: [] }] },
    });
    expect(pathOf(r)).toBe("ask_scope brandcore tech_gate risk_flags layer_verdict critic layer_verdict critic package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });
});

describe("seo-monitor", () => {
  const input = { site_url: "https://example.ru", period: "weekly", link_campaign: false };
  const base = () => ({
    pull: { pull_path: "pull/", urls: 320 },
    tech_watch: { watch_path: "watch.md", alerts: [] },
    anomalies: { anomalies_path: "anomalies.json", buckets: 2 },
    queue: { queue_path: "queue.json", queued: 5 },
    route: { status: "pass", signals: [], recommendations: ["seo-trust: quarterly eeat"], drop_due: false, refresh_due: false, structure_due: false, tech_due: false, release_due: false },
    report: { report_path: ".agents/seo/monitor/2026-11-05/weekly-report.md" },
  });

  it("weekly run: pull -> watch -> anomalies -> queue -> route -> report, cadence and links skipped", async () => {
    const r = await runSim("seo-monitor", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("pull tech_watch anomalies queue links_review cadence route drop refresh structure tech release_check report done");
    expect(r.skipped).toEqual(expect.arrayContaining(["links_review", "cadence", "drop", "refresh", "structure", "tech", "release_check"]));
    expect(out(r)).toMatchObject({ status: "done", report_path: ".agents/seo/monitor/2026-11-05/weekly-report.md" });
  });

  it("monthly run with an active link campaign runs links_review and cadence", async () => {
    const r = await runSim("seo-monitor", {
      input: { ...input, period: "monthly", link_campaign: true },
      stubs: { ...base(), links_review: { links_path: "links.md", verdicts: ["hold"] }, cadence: { cadence_path: "cadence.md" } },
    });
    expect(r.skipped).toEqual(expect.arrayContaining(["drop", "refresh", "structure", "tech", "release_check"]));
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a due index check runs the seo-release subworkflow in index_check mode", async () => {
    const r = await runSim("seo-monitor", {
      input: { ...input, release_items: [".agents/seo/release/r1/item.json"] },
      stubs: {
        ...base(),
        route: { status: "pass", signals: [], recommendations: ["seo-release index_check due"], drop_due: false, refresh_due: false, structure_due: false, tech_due: false, release_due: true },
        release_check: { status: "done", index_status_path: "index-status.json" },
      },
    });
    expect(r.skipped).toEqual(expect.arrayContaining(["links_review", "cadence"]));
    expect(r.skipped).not.toContain("release_check");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it.each([
    ["drop", "drop_due", "seo-drop-diagnosis", { status: "done", diagnosis_path: "d.md" }],
    ["refresh", "refresh_due", "seo-page-refresh", { status: "done", diagnosis_path: "r.md" }],
    ["structure", "structure_due", "seo-structure-audit", { status: "done", report_path: "s.md" }],
    ["tech", "tech_due", "seo-tech-audit", { status: "done", backlog_path: "t.md" }],
  ])("starts %s only when route marks it due", async (node, flag, _workflow, stub) => {
    const r = await runSim("seo-monitor", {
      input,
      stubs: { ...base(), route: { ...base().route, [flag]: true }, [node]: stub },
    });
    const due = ["drop", "refresh", "structure", "tech"];
    expect(r.skipped).toEqual(expect.arrayContaining(due.filter((id) => id !== node)));
    expect(r.skipped).not.toContain(node);
    expect(r.called(node)).toHaveLength(1);
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("starts no graph that does not exist: every subworkflow is registered", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-monitor")!.workflow;
    const subs = workflow.nodes.filter((node) => node.type === "subworkflow").map((node) => (node as { workflow: string }).workflow);
    expect(subs).toEqual(["seo-drop-diagnosis", "seo-page-refresh", "seo-structure-audit", "seo-tech-audit", "seo-release"]);
    for (const id of subs) expect(store.get(id), id).not.toBeNull();
  });
});
