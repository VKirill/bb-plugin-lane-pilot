import { expect, it } from "vitest";
import { classifyWriterOutput } from "../src/validate-output";
import type { TaskV2 } from "../src/contracts";

const task = (expected: string[]) => ({
  expected_outputs: expected, owns_paths: ["apps/marketing/app/components/greeting-cards/", "apps/marketing/i18n/locales/"],
  never_touch: [], verify: "none", verification: [],
}) as unknown as TaskV2;

// Live SelfyStudio contract gc-mock-card-placeholders (2026-10-03): a bare file name and prose entries.
it("finds a bare expected file name under the folder the task owns", () => {
  const produced = ["apps/marketing/app/components/greeting-cards/CardMockCard.vue"];
  const contents = { [produced[0]!]: "<template />" };
  expect(classifyWriterOutput({ task: task(["CardMockCard.vue", "Gallery and showcase use mocks", "Helper", "Tests"]), produced, contents }))
    .toEqual({ ok: true });
});

it("still reports a bare name the writer did not make, and a full path elsewhere", () => {
  const produced = ["apps/marketing/app/components/greeting-cards/Other.vue"];
  const contents = { [produced[0]!]: "x" };
  expect(classifyWriterOutput({ task: task(["CardMockCard.vue"]), produced, contents }))
    .toMatchObject({ ok: false, reason: "missing expected_outputs: CardMockCard.vue" });
  expect(classifyWriterOutput({ task: task(["apps/marketing/app/components/greeting-cards/Other.vue", "src/Missing.vue"]), produced, contents }))
    .toMatchObject({ ok: false, state: "validation_failed", reason: "missing expected_outputs: src/Missing.vue" });
});

it("keeps a stage receipt of the 3rd and 4th writer of the chain instead of failing the task", async () => {
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { openDatabase, createRun, listStageReceipts } = await import("../src/database");
  const { recordStage } = await import("../src/server/stage-records");
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  expect(() => recordStage(db, { runId: "run", taskId: "t", stageId: "writer-agent", state: "pending", input: "plan", attempt: 4 })).not.toThrow();
  expect(listStageReceipts(db, "run", "t")[0]?.attempt).toBe(2);
});

// Live SelfyStudio contract cards-preview-lightbox-fullscreen (2026-10-05): the PM named the folder; the writer changed
// three files in it and was blocked twice with «missing expected_outputs: …/greeting-cards».
it("takes a folder in expected_outputs as met by a file the writer changed under it", () => {
  const produced = ["apps/marketing/app/components/greeting-cards/GeneratorResult.vue", "apps/marketing/app/components/greeting-cards/result.css"];
  const contents = Object.fromEntries(produced.map((path) => [path, "x"]));
  for (const folder of ["apps/marketing/app/components/greeting-cards", "apps/marketing/app/components/greeting-cards/", "apps/marketing/app/components/greeting-cards/**"]) {
    expect(classifyWriterOutput({ task: task([folder]), produced, contents })).toEqual({ ok: true });
  }
  expect(classifyWriterOutput({ task: task(["apps/marketing/i18n/locales"]), produced, contents }))
    .toMatchObject({ ok: false, reason: "missing expected_outputs: apps/marketing/i18n/locales" });
  expect(classifyWriterOutput({ task: task(["apps/marketing/app/components/greeting"]), produced, contents }))
    .toMatchObject({ ok: false, reason: "missing expected_outputs: apps/marketing/app/components/greeting" });
});
