import { expect, it } from "vitest";
import { classifyWriterOutput } from "../src/rooms/tasks/validate-output";
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

it("accepts a mainfix with zero changed files, other tasks still fail on them", () => {
  const mainfix = { ...task(["npm run typecheck"]), id: "cards-fix-mainfix" };
  expect(classifyWriterOutput({ task: mainfix, produced: [], contents: {} })).toEqual({ ok: true });
  expect(classifyWriterOutput({ task: { ...mainfix, id: "cards-fix-mainfix.2" }, produced: [], contents: {} })).toEqual({ ok: true });
  // A mainfix never fails on its own expected_outputs: even a command with «/» and no spaces reads path-like, and an
  // inherited file name must not send the writer chasing a file. Green checks are its whole acceptance.
  expect(classifyWriterOutput({ task: { ...mainfix, expected_outputs: ["bin/check.sh"] }, produced: [], contents: {} })).toEqual({ ok: true });
  expect(classifyWriterOutput({ task: { ...mainfix, expected_outputs: ["src/a.ts"] }, produced: [], contents: {} })).toEqual({ ok: true });
  // A stray file is still rejected before the mainfix branch: an out-of-owns change is blocked.
  expect(classifyWriterOutput({ task: mainfix, produced: ["src/stray.ts"], contents: {} }))
    .toMatchObject({ ok: false, state: "validation_failed" });
  expect(classifyWriterOutput({ task: task(["src/a.ts"]), produced: [], contents: {} }))
    .toMatchObject({ ok: false, state: "empty_output" });
});

it("splits empty_output by the writer's answer: a task failure with an answer, provider without", () => {
  expect(classifyWriterOutput({ task: task([]), produced: [], contents: {}, answered: true }))
    .toMatchObject({ ok: false, state: "empty_output", reason: "writer answered but changed no files" });
  expect(classifyWriterOutput({ task: task([]), produced: [], contents: {}, answered: false }))
    .toMatchObject({ ok: false, state: "empty_output", reason: "writer returned no output" });
});

it("meets a named output the attempt inherited, once it produced its other outputs", () => {
  const site = (expected: string[]) => ({
    expected_outputs: expected, owns_paths: ["apps/site/src/"], never_touch: [], verify: "none", verification: [],
  }) as unknown as TaskV2;
  // The contract names two files; one arrived before the attempt started (a sibling attempt's edits), the writer
  // produced the other: met, not missing.
  const both = site(["apps/site/src/a.ts", "apps/site/src/b.ts"]);
  expect(classifyWriterOutput({
    task: both, produced: ["apps/site/src/a.ts"], contents: { "apps/site/src/a.ts": "x", "apps/site/src/b.ts": "old" },
    preexisting: ["apps/site/src/b.ts"],
  })).toEqual({ ok: true });
  // With nothing produced the relief never applies: pre-existing dirt does not substitute for work.
  expect(classifyWriterOutput({
    task: both, produced: [], contents: { "apps/site/src/b.ts": "old" }, preexisting: ["apps/site/src/b.ts"],
  })).toMatchObject({ ok: false, state: "empty_output" });
  // Owner dirt in an owned file the contract does not name changes nothing.
  expect(classifyWriterOutput({
    task: site(["apps/site/src/a.ts"]), produced: ["apps/site/src/a.ts"],
    contents: { "apps/site/src/a.ts": "x" }, preexisting: ["apps/site/src/owner-edit.ts"],
  })).toEqual({ ok: true });
  // A genuinely missing output still fails even when others were produced and other dirt sat in the workspace.
  expect(classifyWriterOutput({
    task: both, produced: ["apps/site/src/a.ts"], contents: { "apps/site/src/a.ts": "x" },
    preexisting: ["apps/site/src/owner-edit.ts"],
  })).toMatchObject({ ok: false, state: "validation_failed", reason: "missing expected_outputs: apps/site/src/b.ts" });
});

it("cleans ANSI escapes and truncates stderr to 300 characters in failure reason", () => {
  const t = task(["apps/marketing/app/components/greeting-cards/CardMockCard.vue"]);
  const rawStderr = "\x1b[31mFAIL\x1b[39m " + "x".repeat(400);
  const result = classifyWriterOutput({
    task: t,
    produced: ["apps/marketing/app/components/greeting-cards/CardMockCard.vue"],
    contents: { "apps/marketing/app/components/greeting-cards/CardMockCard.vue": "content" },
    verifies: [{ command: "vitest run", exitCode: 1, stdout: "", stderr: rawStderr }],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).not.toContain("\x1b");
    const tail = result.reason.replace("verification failed (vitest run): ", "");
    expect(tail.length).toBeLessThanOrEqual(300);
    expect(tail.startsWith("FAIL")).toBe(true);
  }
});
