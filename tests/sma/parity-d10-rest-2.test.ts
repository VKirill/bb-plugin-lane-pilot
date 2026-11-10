import { describe, expect, it, vi } from "vitest";
import { phaseStageCells, PHASE_STAGES } from "../../src/rooms/phase";
import { ceilingLine } from "../../src/rooms/work-graph";
import { tailWords } from "../../src/rooms/work-graph";
import { workerSecretReach } from "../../src/rooms/verification";
import { persistTaskFolder } from "../../src/rooms/verification";
import { explainCatalog, explainWord, firstSection } from "../../src/rooms/tools/server/explain";
import { weakSpotsBrief, type CurriculumCluster } from "../../src/rooms/tools/server/self-improve";
import { verdictInventory } from "../../src/rooms/tools/server/verdicts";
import { createFromDraft, proposeDraft } from "../../src/rooms/tasks/server";
import { migrations } from "../../src/rooms/plugin-db";
import { appendTaskReceipt, listTaskReceipts } from "../../src/rooms/rollback";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: Array<{ program: string; args: string[] }> = [];
vi.mock("@lane-pilot/kit", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, spawnAsync: async (program: string, args: string[]) => {
    calls.push({ program, args });
    // The fixture: ~/.ssh is world-readable to the worker, the 0600 credential file is not.
    return { status: args.includes(`${process.env.HOME}/.ssh`) ? 0 : 1, stdout: "", stderr: "" };
  } };
});

describe("parity d10-rest-2", () => {
  it("[sma:m_ws_stage_graph] phaseStageCells(\"execution\", \"active\") gives discussion, planning, design passed, execution running and the rest pending, eight cells in PHASE_STAGES order", () => {
    const cells = phaseStageCells("execution", "active");
    expect(cells.map((cell) => cell.stageId)).toEqual([...PHASE_STAGES]);
    expect(cells.map((cell) => cell.state)).toEqual(["passed", "passed", "passed", "running", "pending", "pending", "pending", "pending"]);
    expect(phaseStageCells("execution", "stopped")[3]!.state).toBe("failed");
    expect(phaseStageCells("closed", "closed").every((cell) => cell.state === "passed")).toBe(true);
  });

  it("[sma:sc_spend] ceilingLine({turns:4}, {monthUsd:45, cap:50}) names 4 of 5 turns and marks the money over 90 percent; with cap null it shows the spend only", () => {
    const line = ceilingLine({ turns: 4 }, { monthUsd: 45, cap: 50 });
    expect(line.turns).toEqual({ n: 4, max: 5 });
    expect(line.monthUsd).toBe(45);
    expect(line.hot).toBe(true);
    const open = ceilingLine({ turns: null }, { monthUsd: 45, cap: null });
    expect(open.turns).toBeNull();
    expect(open.cap).toBeNull();
    expect(open.hot).toBe(false);
    expect(ceilingLine({ turns: 4 }, { monthUsd: 10, cap: 50 }).hot).toBe(false);
  });

  it("[sma:m_ws_attempt_log] tailWords turns a read call, an edit call and a final message into three Russian lines in order, drops an unknown type, caps at 8 and is empty for no events", () => {
    const event = (item: unknown) => ({ data: { item } });
    const lines = tailWords([
      event({ type: "toolCall", name: "read_file" }),
      event({ type: "mysteryType", name: "x" }),
      event({ type: "toolCall", name: "apply_patch" }),
      event({ type: "agentMessage", text: "done" }),
    ]);
    expect(lines).toEqual(["читает файл…", "правит файл…", "пишет ответ"]);
    const many = Array.from({ length: 12 }, (_, index) => event({ type: "commandExecution", command: `check ${index}` }));
    const capped = tailWords(many);
    expect(capped).toHaveLength(8);
    expect(capped.every((line) => line === "запускает проверку")).toBe(true);
    expect(tailWords([])).toEqual([]);
  });

  it("[sma:k_v_explain + k_lib_explain] explain a verb gives summary and usage, a topic gives the doc's first section, an unknown word yields the catalog", () => {
    const verbs = [{ name: "memory-eval", summary: "score the memory", usage: "bb lane-pilot memory-eval <project>" }];
    const docs = [
      { file: "docs/guide/memory.md", text: "---\ntitle: Memory\ntopic: memory\n---\n# Memory\n\nOne fact store.\n\n## Details\n\nlong part\n", topic: "memory" },
      { file: "docs/guide/flow.md", text: "---\ntitle: Flow\ntopic: flow\n---\n# Flow\n\nUses `memory-eval`.\n", topic: "flow" },
    ];
    const verb = explainWord("memory-eval", verbs, docs);
    expect(verb?.kind).toBe("verb");
    expect(verb?.text).toContain("score the memory");
    expect(verb?.text).toContain("bb lane-pilot memory-eval");
    expect(verb?.source).toBe("docs/guide/flow.md");
    const topic = explainWord("memory", verbs, docs);
    expect(topic?.kind).toBe("topic");
    expect(topic?.text).toContain("One fact store.");
    expect(topic?.text).not.toContain("long part");
    expect(firstSection(docs[0]!.text)).toContain("# Memory");
    expect(explainWord("zzz", verbs, docs)).toBeNull();
    expect(explainCatalog(verbs, docs)).toEqual(["flow", "memory", "memory-eval"]);
  });

  it("[sma:k_v_curriculum] weakSpotsBrief turns each top cluster into one imperative line — trigger, what failed, where the fact lives — capped at 10 lines", () => {
    const clusters: CurriculumCluster[] = [
      { source: "memory", key: "q", count: 7, sample: "who owns the wall", projectId: "p1" },
      { source: "wall", key: "timeout|v1", count: 5, sample: "timeout", projectId: "" },
      { source: "rule", key: "r-9", count: 3, sample: "t-2", projectId: "p2" },
      { source: "forecast", key: "ui", count: 2, sample: "t-7", projectId: "p1" },
    ];
    const brief = weakSpotsBrief(clusters);
    const lines = brief.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("WHEN a p1 question");
    expect(lines[0]).toContain("memory");
    expect(lines[2]).toContain("rule r-9");
    const many = Array.from({ length: 20 }, (_, i) => ({ source: "memory" as const, key: `k${i}`, count: 1, sample: `s${i}`, projectId: "p" }));
    expect(weakSpotsBrief(many).split("\n")).toHaveLength(10);
    expect(weakSpotsBrief([])).toBe("");
  });

  it("[sma:k_pl_spikes] the verdict inventory lists each spike and sketch with question and verdict; missing verdict is open", () => {
    const root = mkdtempSync(join(tmpdir(), "verdicts-"));
    mkdirSync(join(root, ".agents/planning/spikes"), { recursive: true });
    mkdirSync(join(root, ".agents/planning/sketches"), { recursive: true });
    writeFileSync(join(root, ".agents/planning/spikes/s1.md"), "---\nquestion: can the queue hold 1k tasks?\nverdict: yes\n---\n# spike\n");
    writeFileSync(join(root, ".agents/planning/sketches/home.html"), "---\ntitle: home sketch\n---\n<html/>\n");
    const rows = verdictInventory(root);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "spike")).toMatchObject({ question: "can the queue hold 1k tasks?", verdict: "yes" });
    expect(rows.find((r) => r.kind === "sketch")?.verdict).toBe("open");
    expect(verdictInventory(mkdtempSync(join(tmpdir(), "verdicts-empty-")))).toEqual([]);
  });

  it("[sma:m_sw_chat_draft + m_sw_batch_draft] a draft stores proposed without enqueue, one create enqueues every contract, a second reads already_created and never enqueues twice", async () => {
    const db = new Database(":memory:");
    for (const statement of migrations) db.exec(statement);
    const batch = proposeDraft(db, { runId: "lprun_1", projectId: "p", threadId: "thr_1", kind: "batch", contracts: [{ id: "t-1", area: "ui" }, { id: "t-2", area: "ui" }], objective: "two tasks" });
    expect(batch.state).toBe("proposed");
    expect(batch.taskIds).toEqual([]);
    const enqueued: unknown[] = [];
    const dispatch = async (contract: unknown) => { enqueued.push(contract); return String((contract as { id: string }).id); };
    const first = await createFromDraft(db, batch.id, dispatch);
    expect(first.state).toBe("created");
    expect(first.taskIds).toEqual(["t-1", "t-2"]);
    expect(enqueued).toHaveLength(2);
    const again = await createFromDraft(db, batch.id, dispatch);
    expect(again.state).toBe("already_created");
    expect(enqueued).toHaveLength(2);
    db.close();
  });

  it("[sma:k_lib_landing] a landed receipt after the green gate names the merge commit and the counts", () => {
    const db = new Database(":memory:");
    for (const statement of migrations) db.exec(statement);
    appendTaskReceipt(db, { kind: "landed", projectId: "p", runId: "r", taskId: "t-1", attemptId: "a-1",
      baseSha: "b".repeat(40), changeSha: "c".repeat(40), resultCommit: "c".repeat(40), state: "merged",
      summary: `landed ${"c".repeat(12)} · 4 checks green · 3 files`, detail: {} });
    const rows = listTaskReceipts(db, "t-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("landed");
    expect(rows[0]!.resultCommit).toBe("c".repeat(40));
    expect(rows[0]!.summary).toContain("4 checks green");
    db.close();
  });

  it("[sma:k_pl_quick] persistTaskFolder writes OUTCOME.md with the terminal state, and no plan means no PLAN.md rewrite", async () => {
    const files = new Map<string, string>();
    const writeFile = async (rel: string, content: string) => { files.set(rel, content); };
    const done = await persistTaskFolder({ taskId: "t-outcome", outcome: "# OUTCOME — t-outcome\nstate: accepted\n", writeFile });
    expect(done?.folder).toBe(".agents/plans/items/t-outcome");
    expect(files.get(".agents/plans/items/t-outcome/OUTCOME.md")).toContain("state: accepted");
    expect(files.has(".agents/plans/items/t-outcome/PLAN.md")).toBe(false);
  });

  it("[sma:m_ac_identity_probe] workerSecretReach names a secret path the worker can read as exposed, a 0600 file as closed, and an invalid user fails without running sudo", async () => {
    calls.length = 0;
    const probe = await workerSecretReach("lp-worker", process.env.HOME!);
    expect(probe.ok).toBe(false);
    expect(probe.reachable).toEqual([`${process.env.HOME}/.ssh`]);
    expect(calls.every((call) => call.args.slice(0, 4).join(" ") === `-n -u lp-worker /usr/bin/test`)).toBe(true);
    await expect(workerSecretReach("root;rm -rf /")).rejects.toThrow(/worker_user_invalid/);
    expect(calls.filter((call) => call.args[2] !== "lp-worker")).toEqual([]);
  });
});
