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

describe("research-dossier", () => {
  const input = { question: "Какие требования к маркировке рекламы вступили в силу в 2026 году?", depth: "standard", max_sources: 5 };
  const base = () => ({
    search: { ok: true, sources: ["https://fas.gov.ru/news/1", "https://e-disclosure.ru/2", "https://broken.example/3"], source_count: 3, status: "done" },
    verify_sources: { status: "pass", verified_sources: ["https://fas.gov.ru/news/1", "https://e-disclosure.ru/2"], rejected_sources: ["https://broken.example/3"], verified_count: 2, issues: ["broken link on broken.example"] },
    synthesize: { dossier_path: ".agents/research/dossier.md", dossier_md: "# Досье: Маркировка рекламы\n\n1. Требование токена [1]...", claim_count: 4, status: "done" },
  });

  it("happy path: search -> verify sources -> synthesize verified dossier -> done", async () => {
    const r = await runSim("research-dossier", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("search verify_sources synthesize done");
    expect(out(r)).toMatchObject({ status: "done", verified_count: 2, dossier_path: ".agents/research/dossier.md" });
  });

  it("unverified sources cause a re-search loop once", async () => {
    const r = await runSim("research-dossier", {
      input,
      stubs: {
        ...base(),
        verify_sources: [
          { status: "rework", verified_sources: [], rejected_sources: ["https://bad.example/1"], verified_count: 0, issues: ["all sources invalid"] },
          { status: "pass", verified_sources: ["https://fas.gov.ru/news/1"], rejected_sources: [], verified_count: 1, issues: [] },
        ],
      },
    });
    expect(pathOf(r)).toBe("search verify_sources search verify_sources synthesize done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("search failure blocks the run", async () => {
    const r = await runSim("research-dossier", { input, stubs: { ...base(), search: { ok: false, status: "blocked" } } });
    expect(pathOf(r)).toBe("search blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("billing-batch", () => {
  const input = {
    items: [
      { company: "ООО «Ромашка»", inn: "7707083893", amount: 50000, service: "SEO за октябрь" },
      { company: "ИП Иванов", inn: "500100732259", amount: 30000, service: "Контекстная реклама" },
    ],
  };
  const base = () => ({
    prepare: {
      ok: true,
      batch_items: [
        { company: "ООО «Ромашка»", inn: "7707083893", amount: 50000, service: "SEO за октябрь", recipient: "me" },
        { company: "ИП Иванов", inn: "500100732259", amount: 30000, service: "Контекстная реклама", recipient: "me" },
      ],
      item_count: 2,
      status: "done",
    },
    "invoice-send": { status: "sent", invoice_number: "101", pdf_path: ".agents/documents/invoice-101.pdf" },
    summarize: { summary_md: "# Реестр счетов\n\n1. ООО «Ромашка» — 50 000 ₽\n2. ИП Иванов — 30 000 ₽\nИтого: 80 000 ₽", total_amount: 80000, invoices_count: 2, ok_count: 2, status: "done" },
  });

  it("happy path: prepare -> invoices -> summarize -> owner preview approve -> done", async () => {
    const r = await runSim("billing-batch", { input, stubs: base(), humans: { preview: { answer_kind: "approve", answer: "согласовано" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("prepare invoices summarize preview done");
    expect(out(r)).toMatchObject({ status: "done", total_amount: 80000, invoices_count: 2, owner_decision: "approve" });
  });

  it("owner abort stops the batch without sending", async () => {
    const r = await runSim("billing-batch", { input, stubs: base(), humans: { preview: { answer_kind: "abort", answer: "отменить" } } });
    expect(pathOf(r)).toBe("prepare invoices summarize preview blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("prepare failure blocks the run", async () => {
    const r = await runSim("billing-batch", { input, stubs: { ...base(), prepare: { ok: false, status: "blocked" } } });
    expect(pathOf(r)).toBe("prepare blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("macos-routine", () => {
  const input = { task: "Собери архив системных логов за день и проверь статус демона", apps: ["Terminal", "Finder"], target_dir: ".agents/macos/logs" };
  const base = () => ({
    plan: { ok: true, steps_plan: "1. Собрать логи\n2. Упаковать в zip\n3. Снять скриншот", status: "done" },
    execute: { ok: true, output: "Логи собраны в logs.zip, статус демона active", screenshot_path: ".agents/macos/evidence.png", affected_files: [".agents/macos/logs.zip"], status: "done" },
    report: { report_md: "# Отчёт выполнения на Mac mini\n\nВсе шаги выполнены, скриншот сохранён.", screenshot_ok: true, status: "done" },
  });

  it("happy path: plan -> execute with screenshot evidence -> report -> done", async () => {
    const r = await runSim("macos-routine", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("plan execute report done");
    expect(out(r)).toMatchObject({ status: "done", screenshot_path: ".agents/macos/evidence.png" });
  });

  it("execution failure blocks the run", async () => {
    const r = await runSim("macos-routine", { input, stubs: { ...base(), execute: { ok: false, status: "blocked" } } });
    expect(pathOf(r)).toBe("plan execute blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});

describe("seo-page", () => {
  const input = { page_topic: "Установка кондиционеров в квартире", site_goal: "услуги", site_dir: "content/services", geo: "RU" };
  const base = () => ({
    "seo-cocoon": { status: "done", folder: ".agents/seo/conditioners", handoff_path: ".agents/seo/conditioners/handoff.md", briefs_dir: ".agents/seo/conditioners/briefs" },
    write_content: { ok: true, raw_page_path: ".agents/seo/conditioners/page_raw.md", word_count: 1200, status: "done" },
    proofread: { status: "pass", clean_page_path: ".agents/seo/conditioners/page_clean.md", ru_score: 9, issues: [] },
    export_to_site: { ok: true, site_page_path: "content/services/ustanovka-kondicionerov.md", status: "done" },
  });

  it("happy path: cocoon -> write content -> ru-check proofread -> export to site -> done", async () => {
    const r = await runSim("seo-page", { input, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("cocoon write_content proofread export_to_site done");
    expect(out(r)).toMatchObject({ status: "done", site_page_path: "content/services/ustanovka-kondicionerov.md", ru_score: 9 });
  });

  it("poor proofreading score loops back to write_content once", async () => {
    const r = await runSim("seo-page", {
      input,
      stubs: {
        ...base(),
        proofread: [
          { status: "rework", clean_page_path: ".agents/seo/conditioners/page_clean.md", ru_score: 5, issues: ["many clichés", "bad typography"] },
          { status: "pass", clean_page_path: ".agents/seo/conditioners/page_clean.md", ru_score: 9, issues: [] },
        ],
      },
    });
    expect(pathOf(r)).toBe("cocoon write_content proofread write_content proofread export_to_site done");
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("cocoon subworkflow failure blocks the run", async () => {
    const r = await runSim("seo-page", { input, stubs: { ...base(), "seo-cocoon": { status: "blocked" } } });
    expect(pathOf(r)).toBe("cocoon blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });
});
