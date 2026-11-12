import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/rooms/plugin-db";
// The worktree's own jev package by relative path: `@lane-pilot/jev` resolves to the main checkout (shared node_modules),
// and these tests pin what this branch adds to the package (the merge brings the same code to the main checkout).
import { insertReceipt } from "@lane-pilot/jev";
import { labelCritiqueScreen, applyOutcomeLabels, judgeAccuracy } from "@lane-pilot/jev";
import { sampledInput, INPUT_JSON_CAP } from "@lane-pilot/jev";
import { planModelLabels, modelLabelPrompt, answersFromModelText, compareModelDecision } from "@lane-pilot/jev";
import { labelSource, calibrateReceipts } from "@lane-pilot/jev";
import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";

/** A fixture judgment (the calibration machinery is generic): which side an attempt failed on. */
const failureClassJudgment = defineJudgment<{ state: string; reason: string }, { cls: string }>({
  id: "test.side", title: "fixture", version: 1, defaultMode: "shadow", timeoutMs: 5_000,
  stateBuilder: (input) => ({ attempt_state: input.state, reason: input.reason }),
  questions: () => ({ side: choice("Which side failed?", { task: "the task's own work", infra: "the machine or network" }) }),
  thresholds: { min_p: { default: 0.7, min: 0.5, max: 0.98, about: "least probability" }, min_margin: { default: 0.3, min: 0.05, max: 0.9, about: "least lead" } },
  decide(answers, t) {
    const pick = choiceOf(answers, "side");
    if (!pick || pick.p < t.min_p! || pick.margin < t.min_margin!) return { decision: { cls: "task" } };
    return { decision: { cls: pick.top } };
  },
  fallback: () => ({ cls: "task" }),
  describe: (decision) => decision.cls,
});

const NOW = 1_800_000_000_000;
const OLD = NOW - 48 * 3_600_000; // older than the 24h truth age
const YOUNG = NOW - 60_000;

function db() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

function receipt(database: ReturnType<typeof db>, extra: Partial<Parameters<typeof insertReceipt>[1]> = {}): number {
  return insertReceipt(database, {
    judgment: "critique.screen", version: 1, mode: "active", inputSha256: "0".repeat(64), inputChars: 100, questions: 1,
    status: "ok", decision: "pass", decidedBy: "jev", runId: "run1", subject: "task1", at: OLD, ...extra,
  });
}

function task(database: ReturnType<typeof db>, state: string | null, opts: { regression?: boolean; mainfix?: boolean } = {}) {
  database.prepare("INSERT INTO lane_pilot_run (id,project_id,state,created_at,updated_at,kind,closed_at) VALUES (?,?,?,?,?,?,?)")
    .run("run1", "proj", state === null ? "running" : "accepted", OLD, OLD + 1000, "bb", state === null ? null : OLD + 2000);
  database.prepare("INSERT INTO lane_pilot_task (id,run_id,kind,contract_json,created_at) VALUES (?,?,?,?,?)")
    .run("task1", "run1", "bb", "{}", OLD);
  if (state) database.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("a1", "run1", "task1", state, OLD, OLD + 3000);
  if (opts.regression) database.prepare(`INSERT INTO lane_pilot_regression (found_at,updated_at,project_id,run_id,task_id,command,kind,state,bisect_status) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(OLD + 4000, OLD + 4000, "proj", "run1", "task1", "npm test", "regression", "open", "none");
  if (opts.mainfix) database.prepare("INSERT INTO lane_pilot_task (id,run_id,kind,contract_json,created_at) VALUES (?,?,?,?,?)")
    .run("task1-mainfix", "run1", "bb", "{}", OLD + 5000);
}

describe("outcome labels: critique.screen on the task's fate", () => {
  it("agrees with a pass that was accepted cleanly, disagrees on a regression or a failed attempt, and waits while attempts run", () => {
    const database = db();
    const accepted = receipt(database);
    task(database, "accepted");
    expect(labelCritiqueScreen(database, NOW)).toEqual([{ receiptId: accepted, outcome: "agree:outcome" }]);

    const database2 = db();
    const regressed = receipt(database2);
    task(database2, "accepted", { regression: true });
    expect(labelCritiqueScreen(database2, NOW)).toEqual([{ receiptId: regressed, outcome: "disagree:outcome" }]);

    const database3 = db();
    const failed = receipt(database3);
    task(database3, "validation_failed");
    expect(labelCritiqueScreen(database3, NOW)).toEqual([{ receiptId: failed, outcome: "disagree:outcome" }]);

    const database4 = db();
    const running = receipt(database4);
    task(database4, "running");
    expect(labelCritiqueScreen(database4, NOW)).toEqual([]);
  });

  it("leaves too-young receipts alone and never relabels", () => {
    const database = db();
    const id = receipt(database, { at: YOUNG });
    task(database, "accepted");
    expect(labelCritiqueScreen(database, NOW)).toEqual([]);
    // Label it by hand; a second pass must write nothing.
    database.prepare("UPDATE lane_pilot_jev_receipt SET outcome='agree:outcome' WHERE id=?").run(id);
    database.prepare("UPDATE lane_pilot_jev_receipt SET at=? WHERE id=?").run(OLD, id);
    expect(labelCritiqueScreen(database, NOW)).toEqual([]);
    expect(applyOutcomeLabels(database, NOW)).toEqual({ "critique.screen": 0 });
  });
});

describe("sampling: input_json on one receipt in five, capped at 8 KB", () => {
  it("keeps exactly the sampled rows and truncates with the marker", () => {
    const database = db();
    let kept = 0;
    for (let i = 0; i < 25; i++) {
      const sha = i.toString(16).padStart(8, "0") + "0".repeat(56);
      receipt(database, { inputSha256: sha, inputJson: `{"n":${i}}` });
    }
    const rows = database.prepare("SELECT id, input_json FROM lane_pilot_jev_receipt").all() as Array<{ id: number; input_json: string | null }>;
    kept = rows.filter((row) => row.input_json !== null).length;
    expect(kept).toBe(5);
    // A giant input lands truncated with the marker (or not at all when unsampled).
    const shaOk = "5".repeat(64); // 0x55555555 % 5 === 0
    receipt(database, { inputSha256: shaOk, inputJson: "x".repeat(INPUT_JSON_CAP * 2) });
    const big = database.prepare("SELECT input_json FROM lane_pilot_jev_receipt WHERE input_sha256=?").get(shaOk) as { input_json: string };
    expect(big.input_json.length).toBe(INPUT_JSON_CAP);
    expect(big.input_json.endsWith("…[truncated]")).toBe(true);
    expect(sampledInput(shaOk, "{}")).toBe("{}");
    expect(sampledInput("1".repeat(64), "{}")).toBeNull();
  });
});

describe("model labels", () => {
  it("the prompt carries the state and the questions, never the judge's decision or answers", () => {
    const input = { state: "validation_failed", reason: "npm test: 2 failed" };
    const prompt = modelLabelPrompt(failureClassJudgment, input);
    expect(prompt).toContain("npm test");
    expect(prompt).toContain('"side"');
    expect(prompt).not.toContain('"decision"');
    expect(prompt).not.toContain("answers_json");
    expect(prompt).not.toContain("provider p=");
    // The answer parse only takes the options the question offered.
    const answers = answersFromModelText('{"side":"infra","nope":"x"}', failureClassJudgment.questions(input));
    expect(answers?.side).toMatchObject({ type: "choice", choice: "infra" });
    expect(answers?.nope).toBeUndefined();
    expect(answersFromModelText("not json", failureClassJudgment.questions(input))).toBeNull();
  });

  it("plans only unlabeled receipts with input_json, capped per judgment and in total", () => {
    const database = db();
    for (let i = 0; i < 30; i++) {
      const sha = i.toString(16).padStart(8, "0") + "0".repeat(56);
      insertReceipt(database, { judgment: "failure.class", version: 1, mode: "shadow", inputSha256: sha, inputChars: 10, questions: 1, status: "ok", decision: "infra", decidedBy: "jev", inputJson: `{"i":${i}}`, at: OLD });
    }
    // i%5==0 for i in 0..29 leaves 6 sampled rows (0,5,10,15,20,25); the cap is under it.
    const jobs = planModelLabels(database, [{ id: "failure.class" }], { perJudgment: 7 });
    expect(jobs.length).toBe(6);
    expect(jobs[0]!.input).toEqual({ i: 0 });
    database.prepare("UPDATE lane_pilot_jev_receipt SET outcome='agree:model' WHERE id=?").run(jobs[0]!.receiptId);
    const again = planModelLabels(database, [{ id: "failure.class" }], { perJudgment: 7 });
    expect(again.some((job) => job.receiptId === jobs[0]!.receiptId)).toBe(false);
    expect(again.length).toBe(5);
  });

  it("compares the re-decision with the receipt and labels agree:model / disagree:model", () => {
    const input = { state: "validation_failed", reason: "npm test: 2 failed" };
    expect(compareModelDecision(failureClassJudgment, input, '{"side":"task"}', "task")).toBe("agree:model");
    expect(compareModelDecision(failureClassJudgment, input, '{"side":"infra"}', "task")).toBe("disagree:model");
    expect(compareModelDecision(failureClassJudgment, input, "garbage", "task")).toBeNull();
    expect(compareModelDecision(failureClassJudgment, input, '{"side":"infra"}', null)).toBeNull();
  });
});

describe("calibrate --by-source", () => {
  it("splits labels into outcome / model / escalated", () => {
    expect(labelSource("agree")).toBe("escalated");
    expect(labelSource("disagree")).toBe("escalated");
    expect(labelSource("agree:model")).toBe("model");
    expect(labelSource("disagree:model:x")).toBe("model");
    expect(labelSource("agree:outcome")).toBe("outcome");
    expect(labelSource("disagree:outcome:critic_found_nothing")).toBe("outcome");
    expect(labelSource("pending")).toBeNull();

    const database = db();
    receipt(database, { decision: "pass" });
    const base = database.prepare("SELECT id FROM lane_pilot_jev_receipt").all() as Array<{ id: number }>;
    database.prepare("UPDATE lane_pilot_jev_receipt SET outcome='agree' WHERE id=?").run(base[0]!.id);
    receipt(database, { decision: "pass" });
    receipt(database, { decision: "pass" });
    const ids = database.prepare("SELECT id FROM lane_pilot_jev_receipt ORDER BY id").all() as Array<{ id: number }>;
    database.prepare("UPDATE lane_pilot_jev_receipt SET outcome='agree:model' WHERE id=?").run(ids[1]!.id);
    database.prepare("UPDATE lane_pilot_jev_receipt SET outcome='disagree:outcome' WHERE id=?").run(ids[2]!.id);
    const report = calibrateReceipts(database, { sinceMs: 0, judgments: [] });
    expect(report[0]!.bySource).toEqual({ outcome: { agree: 0, disagree: 1 }, model: { agree: 1, disagree: 0 }, escalated: { agree: 1, disagree: 0 } });
    expect(report[0]!.labeled).toBe(3);
    expect(judgeAccuracy(database, "critique.screen")).toEqual({ labeled: 3, accuracy: 2 / 3 });
    expect(judgeAccuracy(database, "never.asked")).toBeNull();
  });
});
