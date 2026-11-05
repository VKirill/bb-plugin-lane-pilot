import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-tech-audit", () => {
  const input = { site_url: "https://example.ru" };
  const base = () => ({
    intake: { findings_paths: ["gsc.md", "crawl.md"], defects: [], skipped: false, skipped_branches: ["logs"] },
    specialists: { findings_paths: ["index.md", "canonical.md"], defects: [], skipped: false, skipped_branches: [] },
    matrix: { matrix_path: "matrix.csv", rows: 24 },
    backlog: { backlog_path: "backlog.md", tickets: 6, release_items: [".agents/seo/release/r1/item.json"] },
    critic: { status: "pass", findings: [] },
    package: { package_path: ".agents/seo/tech-audit/2026-11-06/" },
  });
  const humans = { access: { logs_path: "", crawl_path: "", answer_kind: "given" } };

  it("happy path: access -> intake -> specialists -> matrix -> backlog -> critic -> package -> done", async () => {
    const r = await runSim("seo-tech-audit", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("access intake specialists matrix backlog critic package done");
    expect(out(r)).toMatchObject({ status: "done", backlog_path: "backlog.md", release_items: [".agents/seo/release/r1/item.json"] });
  });

  it("a rework critic loops back to the backlog once", async () => {
    const r = await runSim("seo-tech-audit", {
      input,
      stubs: { ...base(), critic: [{ status: "rework", findings: [] }, { status: "pass", findings: [] }] },
      humans,
    });
    expect(pathOf(r)).toBe("access intake specialists matrix backlog critic backlog critic package done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("changes no site: it emits release items, no publish node and no subworkflow", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-tech-audit")!.workflow;
    expect(workflow.nodes.filter((node) => node.type === "subworkflow")).toEqual([]);
  });
});

describe("seo-drop-diagnosis", () => {
  const input = { site_url: "https://example.ru", affected_urls: ["/catalog/a"] };
  const base = () => ({
    intake: { status: "proceed", freeze_due: "", log_path: "log.md", windows_path: "windows.md" },
    mechanism: { mechanism_path: "mechanism.md", labels: ["ranking"] },
    scope: { scope: "template", scope_path: "scope.md" },
    layers: { findings_paths: ["layer.md"], defects: [], skipped: false, skipped_branches: [] },
    contour: { contour: "template", contour_path: "contour.md" },
    hypotheses: { hypotheses_path: "hypotheses.md", pilot_path: "pilot.md", top_count: 3 },
    critic: { status: "pass", findings: [] },
    package: { diagnosis_path: ".agents/seo/drop-diagnosis/2026-11-06/diagnosis.md" },
  });
  const humans = { review: { answer: "pilot A", answer_kind: "approved" } };

  it("happy path: intake -> mechanism -> scope -> layers -> contour -> hypotheses -> critic -> review -> package -> done", async () => {
    const r = await runSim("seo-drop-diagnosis", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("intake mechanism scope layers contour hypotheses critic review package done");
    expect(out(r)).toMatchObject({ status: "done", hypotheses_path: "hypotheses.md", pilot_path: "pilot.md" });
  });

  it("an active core update freezes the run until T_end+7 and touches nothing", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: { ...base(), intake: { status: "frozen", freeze_due: "2026-11-20", log_path: "log.md", windows_path: "" } },
    });
    expect(pathOf(r)).toBe("intake frozen");
    expect(out(r)).toMatchObject({ status: "frozen", freeze_due: "2026-11-20" });
  });

  it("a declined review keeps the diagnosis without a pilot", async () => {
    const r = await runSim("seo-drop-diagnosis", {
      input,
      stubs: base(),
      humans: { review: { answer: "", answer_kind: "declined" } },
    });
    expect(pathOf(r)).toBe("intake mechanism scope layers contour hypotheses critic review partial");
    expect(out(r)).toMatchObject({ status: "partial" });
  });
});
