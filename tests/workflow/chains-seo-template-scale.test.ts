import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim, chainStore } from "./chain-harness";

describe("seo-template-scale", () => {
  const input = { mode: "catalog", catalog_export_path: ".agents/seo/shop/catalog-export.json", target: "cms:shop" };
  const base = () => ({
    passports: { passports_path: "template-passports.md" },
    facets_stock: { facet_matrix_path: "facet-matrix.json", indexation_rules_path: "indexation-rules.md" },
    commercial_chain: { chain_specs_path: "chain-specs.md" },
    meta_alt: { meta_import_path: "meta-import.json", release_items: ["meta-import.json"] },
    critic: { status: "pass", verdict_path: "pilot-verdict.md", pilot_items: ["meta-import.json"] },
    rollout: { status: "done", release_report_path: ".agents/seo/release/r1/release-report.md" },
    package: { package_path: ".agents/seo/template-scale/r1/" },
  });

  it("catalog mode: passports -> facets -> chain -> meta -> critic -> owner approve -> rollout -> done", async () => {
    const r = await runSim("seo-template-scale", { input, stubs: base(), humans: { approve: { answer_kind: "approve", answer: "да" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("passports facets_stock commercial_chain service_geo proof meta_alt critic approve rollout package done");
    expect(r.skipped).toEqual(expect.arrayContaining(["service_geo", "proof"]));
    expect(out(r)).toMatchObject({ status: "done", passports_path: "template-passports.md", meta_import_path: "meta-import.json" });
  });

  it("service_geo mode runs the geo and proof nodes and skips the catalog ones", async () => {
    const r = await runSim("seo-template-scale", {
      input: { ...input, mode: "service_geo", location_registry_path: "locations.csv", proofs_path: "proofs/" },
      stubs: {
        ...base(),
        service_geo: { geo_specs_path: "geo-specs.md" },
        proof: { proof_specs_path: "proof-specs.md" },
      },
      humans: { approve: { answer_kind: "approve", answer: "да" } },
    });
    expect(pathOf(r)).toBe("passports facets_stock commercial_chain service_geo proof meta_alt critic approve rollout package done");
    expect(r.skipped).toEqual(expect.arrayContaining(["facets_stock", "commercial_chain"]));
    expect(out(r)).toMatchObject({ status: "done", geo_specs_path: "geo-specs.md" });
  });

  it("no rollout without the pilot verdict: rollout's only incoming edge is the owner's approve", async () => {
    const store = await chainStore();
    const workflow = store.get("seo-template-scale")!.workflow;
    const into = workflow.edges.filter((edge) => edge.to === "rollout").map((edge) => edge.from);
    expect(into).toEqual(["approve"]);
  });

  it("owner decline blocks the run before the rollout", async () => {
    const r = await runSim("seo-template-scale", { input, stubs: base(), humans: { approve: { answer_kind: "decline", answer: "стоп" } } });
    expect(pathOf(r)).toBe("passports facets_stock commercial_chain service_geo proof meta_alt critic approve blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});
