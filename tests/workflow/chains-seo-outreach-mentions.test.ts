import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-outreach", () => {
  const input = {
    sprint_plan_path: ".agents/seo/links/sprint.md",
    anchor_spec_path: ".agents/seo/links/anchors.md",
    donor_plan_path: ".agents/seo/links/donors.md",
    brandcore_path: ".agents/seo/brandcore.md",
    acceptor_urls: ["https://site.example/services/install"],
  };
  const base = () => ({
    drafts: { channel: "guest_posts", draft_paths: [".agents/seo/outreach/r1/draft-1.md"] },
    humanize: { clean_paths: [".agents/seo/outreach/r1/clean-1.md"], ready: 1 },
    send: { sent: 1, send_log_path: ".agents/seo/outreach/r1/send-log.md" },
    log: { log_path: ".agents/seo/outreach/r1/placement-log.json" },
  });

  it("happy path: drafts -> humanize -> owner approve -> send -> log -> done", async () => {
    const r = await runSim("seo-outreach", { input, stubs: base(), humans: { send_ok: { answer_kind: "approve", answer: "да" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("drafts humanize send_ok send log done");
    expect(out(r)).toMatchObject({ status: "done", sent: 1 });
  });

  it("owner refusal ends the run before send", async () => {
    const r = await runSim("seo-outreach", { input, stubs: base(), humans: { send_ok: { answer_kind: "decline", answer: "не отправлять" } } });
    expect(pathOf(r)).toBe("drafts humanize send_ok blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("send has exactly one incoming edge: the owner approve", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-outreach")!.workflow;
    const into = workflow.edges.filter((edge) => edge.to === "send");
    expect(into).toHaveLength(1);
    expect(into[0]!.from).toBe("send_ok");
    expect(into[0]!.when).toContain("approve");
  });
});

describe("seo-mentions", () => {
  const input = {
    entity_dict_path: ".agents/seo/links/entities.json",
    acceptor_map_path: ".agents/seo/links/acceptor-map.json",
    gsc_links_path: ".agents/seo/links/gsc-links.csv",
    release_log_path: ".agents/seo/release/change-log.json",
  };
  const base = () => ({
    harvest: { mentions_path: ".agents/seo/mentions/r1/mentions.json", reclamation_paths: [".agents/seo/mentions/r1/rec-1.md"], unlinked: 3, toxic: 0 },
    entity_pages: { entity_specs_path: ".agents/seo/mentions/r1/entity-specs.json", spec_count: 1 },
    lost_links: { recovery_paths: [".agents/seo/mentions/r1/lost-1.md"], redirect_fixes_path: ".agents/seo/mentions/r1/redirects.json" },
    send: { sent: 2, send_log_path: ".agents/seo/mentions/r1/send-log.md" },
    log: { log_path: ".agents/seo/mentions/r1/mentions.json" },
  });

  it("happy path: harvest -> entity_pages -> lost_links -> owner approve -> send -> log -> done", async () => {
    const r = await runSim("seo-mentions", { input, stubs: base(), humans: { send_ok: { answer_kind: "approve", answer: "да" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("harvest entity_pages lost_links send_ok send log done");
    expect(out(r)).toMatchObject({ status: "done", entity_specs_path: ".agents/seo/mentions/r1/entity-specs.json" });
  });

  it("owner refusal ends the run before send", async () => {
    const r = await runSim("seo-mentions", { input, stubs: base(), humans: { send_ok: { answer_kind: "decline", answer: "не отправлять" } } });
    expect(pathOf(r)).toBe("harvest entity_pages lost_links send_ok blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("send has exactly one incoming edge: the owner approve", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-mentions")!.workflow;
    const into = workflow.edges.filter((edge) => edge.to === "send");
    expect(into).toHaveLength(1);
    expect(into[0]!.from).toBe("send_ok");
    expect(into[0]!.when).toContain("approve");
  });
});
