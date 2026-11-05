import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("seo-linkbuilding", () => {
  const input = {
    acceptors_path: ".agents/seo/conditioners/acceptors.json",
    gsc_export_path: ".agents/seo/gsc.csv",
    backlink_export_path: ".agents/seo/backlinks.csv",
    pr_calendar: ".agents/seo/pr-calendar.md",
    brandcore_path: ".agents/seo/brandcore.md",
    entity_dict_path: ".agents/seo/links/entities.json",
    acceptor_map_path: ".agents/seo/links/acceptor-map.json",
    acceptor_urls: ["https://site.example/services/install"],
    cluster: "conditioners",
  };
  const base = () => ({
    admission: { status: "pass", findings: [], admission_path: ".agents/seo/links/r1/admission.json", admitted_count: 12, remediation_path: "" },
    research: { opportunities_path: ".agents/seo/links/r1/opportunities.json", risk_audit_path: ".agents/seo/links/r1/risk.md" },
    sprint: { sprint_plan_path: ".agents/seo/links/r1/sprint.md", anchor_spec_path: ".agents/seo/links/r1/anchors.md", donor_plan_path: ".agents/seo/links/r1/donors.md" },
    "seo-outreach": { status: "done", sent: 3, log_path: ".agents/seo/outreach/r1/placement-log.json" },
    "seo-mentions": { status: "done", log_path: ".agents/seo/mentions/r1/mentions.json", entity_specs_path: "", redirect_fixes_path: "" },
    tracking: { tracking_path: ".agents/seo/links/r1/tracking.json", anomalies: 0 },
    post_batch_audit: { audit_path: ".agents/seo/links/r1/post-batch-audit.md", findings: 0 },
    package: { package_path: ".agents/seo/links/r1/" },
  });
  const humans = {
    setup: { answer_kind: "given", answer: "приоритет: монтаж кондиционеров" },
    approve: { answer_kind: "approve", answer: "да" },
  };

  it("happy path: setup -> admission -> research -> sprint -> owner approve -> outreach -> mentions -> tracking -> post-batch audit -> done", async () => {
    const r = await runSim("seo-linkbuilding", { input, stubs: base(), humans });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("setup admission research sprint approve outreach mentions tracking post_batch_audit package done");
    expect(out(r)).toMatchObject({ status: "done", sprint_plan_path: ".agents/seo/links/r1/sprint.md", tracking_path: ".agents/seo/links/r1/tracking.json" });
  });

  it("admission gate blocks the run when no acceptor is ready", async () => {
    const r = await runSim("seo-linkbuilding", {
      input,
      stubs: { ...base(), admission: { status: "block", findings: [], admission_path: ".agents/seo/links/r1/admission.json", admitted_count: 0, remediation_path: ".agents/seo/links/r1/remediation.md" } },
      humans,
    });
    expect(pathOf(r)).toBe("setup admission blocked");
    expect(out(r)).toMatchObject({ status: "blocked", remediation_path: ".agents/seo/links/r1/remediation.md" });
  });

  it("owner decline of the sprint stops the run before outreach", async () => {
    const r = await runSim("seo-linkbuilding", { input, stubs: base(), humans: { ...humans, approve: { answer_kind: "decline", answer: "нет" } } });
    expect(pathOf(r)).toBe("setup admission research sprint approve blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});
