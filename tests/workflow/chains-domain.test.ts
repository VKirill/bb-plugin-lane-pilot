import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("3d-asset", () => {
  const input = { prompt: "Low-poly wooden treasure chest", poly_budget: 3000, format: "glb", style: "lowpoly" };
  const base = () => ({
    concept: { ok: true, concept_path: "image-studio/model/chest/blueprint.png", status: "done" },
    model: { ok: true, blend_path: ".agents/3d/chest/scene.blend", poly_count: 2400, status: "done" },
    verify: { status: "pass", ngon_count: 0, normal_errors: 0, poly_count: 2400, preview_path: ".agents/3d/chest/preview.png", report_path: ".agents/3d/chest/geometry_report.json", issues: [] },
    export: { ok: true, asset_path: ".agents/3d/chest/export/chest.glb", format: "glb", status: "done" },
  });

  it("happy path: concept -> model in Blender -> verify geometry -> export -> done", async () => {
    const r = await runSim("3d-asset", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("concept model verify export done");
    expect(out(r)).toMatchObject({ status: "done", asset_path: ".agents/3d/chest/export/chest.glb", poly_count: 2400 });
  });

  it("skips concept generation when concept_image is provided in inputs", async () => {
    const r = await runSim("3d-asset", { input: { ...input, concept_image: "fixtures/concept.png" }, stubs: base() });
    expect(pathOf(r)).toBe("concept model verify export done");
    expect(r.skipped).toEqual(["concept"]);
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("geometry defects trigger a rework loop back to model up to 2 visits", async () => {
    const r = await runSim("3d-asset", {
      input,
      stubs: {
        ...base(),
        verify: [
          { status: "rework", ngon_count: 4, normal_errors: 2, poly_count: 3800, issues: ["4 n-gons found", "normals inverted"] },
          { status: "pass", ngon_count: 0, normal_errors: 0, poly_count: 2400, preview_path: ".agents/3d/chest/preview.png", report_path: ".agents/3d/chest/report.json", issues: [] },
        ],
      },
    });
    expect(pathOf(r)).toBe("concept model verify model verify export done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("model failure ends blocked", async () => {
    const r = await runSim("3d-asset", { input, stubs: { ...base(), model: { ok: false, status: "blocked" } } });
    expect(pathOf(r)).toBe("concept model blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("roblox-asset", () => {
  const input = { asset_name: "KnightHelmet", asset_type: "accessory", project_path: "src/accessories", attachment_point: "HatAttachment" };
  const base = () => ({
    assemble: { ok: true, model_path: ".agents/roblox/KnightHelmet/model.rbxm", part_count: 3, status: "done" },
    verify_asset: { status: "pass", bounds_ok: true, collisions_ok: true, scale_studs: "1.2x1.4x1.1", report_path: ".agents/roblox/KnightHelmet/collision_report.json", issues: [] },
    deploy_asset: { ok: true, deployed_path: "src/accessories/KnightHelmet.rbxm", asset_id: "rbxassetid://12345678", status: "done" },
  });

  it("happy path: assemble -> verify scale and collisions -> deploy to project -> done", async () => {
    const r = await runSim("roblox-asset", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("assemble verify_asset deploy_asset done");
    expect(out(r)).toMatchObject({ status: "done", deployed_path: "src/accessories/KnightHelmet.rbxm", scale_studs: "1.2x1.4x1.1" });
  });

  it("collision rework goes back to assemble once", async () => {
    const r = await runSim("roblox-asset", {
      input,
      stubs: {
        ...base(),
        verify_asset: [
          { status: "rework", bounds_ok: false, collisions_ok: false, issues: ["accessory clips head", "CanCollide must be false for handle"] },
          { status: "pass", bounds_ok: true, collisions_ok: true, scale_studs: "1.0x1.2x1.0", report_path: ".agents/roblox/report.json", issues: [] },
        ],
      },
    });
    expect(pathOf(r)).toBe("assemble verify_asset assemble verify_asset deploy_asset done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("assemble failure blocks the run", async () => {
    const r = await runSim("roblox-asset", { input, stubs: { ...base(), assemble: { ok: false, status: "blocked" } } });
    expect(pathOf(r)).toBe("assemble blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("social-post", () => {
  const input = { topic: "Удаленная работа и продуктивность", platform: "threads", posts_count: 2 };
  const base = () => ({
    insights: { status: "done", writing_pack_path: "fixtures/writing_pack.md", dossier_path: "fixtures/dossier.md", posts: ["p1", "p2"] },
    write_post: { status: "done", post_text: "Удаленка не убивает продуктивность, её убивает отсутствие границ.", draft_path: ".agents/social/post.md", ru_score: 9 },
    format_telegram: { status: "done", formatted_text: "<b>Удаленка и границы</b>\n\nУдаленка не убивает продуктивность...", char_count: 450, message_card_path: ".agents/social/telegram-card.md" },
  });

  it("happy path: insights -> write in author voice -> Telegram formatting -> owner preview -> done", async () => {
    const r = await runSim("social-post", { input, stubs: base(), humans: { preview: { answer_kind: "approve", answer: "looks great" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("insights write_post format_telegram preview done");
    expect(out(r)).toMatchObject({ status: "done", owner_decision: "approve" });
    expect(out(r)!.post_text).toContain("Удаленка и границы");
  });

  it("owner edit request loops back to write_post once", async () => {
    const r = await runSim("social-post", {
      input,
      stubs: base(),
      humans: {
        preview: [
          { answer_kind: "edit", answer: "Сделай вступление короче" },
          { answer_kind: "approve", answer: "отлично" },
        ],
      },
    });
    expect(pathOf(r)).toBe("insights write_post format_telegram preview write_post format_telegram preview done");
    expect(out(r)).toMatchObject({ status: "done", owner_decision: "approve" });
  });

  it("insights subworkflow failure blocks the run", async () => {
    const r = await runSim("social-post", { input, stubs: { ...base(), insights: { status: "blocked" } } });
    expect(pathOf(r)).toBe("insights blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});
