import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { backlogBoard, backlogReadCommand, parseBacklogOutput, parseTodoMeta } from "../../src/rooms/backlog";
import { createBacklog, runBacklogCli } from "../../src/rooms/backlog/server";
import { createRun, openDatabase, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";

const meta = (id: string, extra: string) => `id: ${id}\ntitle: "Item ${id}"\ncreated: 2026-10-${id.slice(-2)}T10:00:00+02:00\n${extra}\n`;

describe("the backlog rules", () => {
  it("reads the flat fields of meta.yaml, inline lists and comments included", () => {
    expect(parseTodoMeta('id: a\ntitle: "A thing"\nstatus: ready   # clear enough\npriority: high\nestimate: 5\ndepends_on: [b, "c"]\n')).toEqual({
      id: "a", title: "A thing", status: "ready", priority: "high", estimate: 5, dependsOn: ["b", "c"], created: "" });
    expect(parseTodoMeta("title: no id")).toBeNull();
  });

  it("issues ready items with an estimate up to 13 and done dependencies, by priority then age; lists the rest with why", () => {
    const items = [
      parseTodoMeta(meta("t-01", "status: ready\npriority: low\nestimate: 3"))!,
      parseTodoMeta(meta("t-02", "status: ready\npriority: high\nestimate: 8"))!,
      parseTodoMeta(meta("t-03", "status: ready\npriority: high\nestimate: 21"))!,
      parseTodoMeta(meta("t-04", "status: ready\npriority: high"))!,
      parseTodoMeta(meta("t-05", "status: ready\npriority: high\nestimate: 2\ndepends_on: [t-06]"))!,
      parseTodoMeta(meta("t-06", "status: open\nestimate: 1"))!,
      parseTodoMeta(meta("t-07", "status: ready\npriority: high\nestimate: 2\ndepends_on: [t-08]"))!,
      parseTodoMeta(meta("t-08", "status: done"))!,
    ];
    const board = backlogBoard(items);
    expect(board.issuable.map((item) => item.id)).toEqual(["t-02", "t-07", "t-01"]);
    expect(board.decompose.map((item) => item.id)).toEqual(["t-03"]);
    expect(board.needsEstimate.map((item) => item.id)).toEqual(["t-04"]);
    expect(board.blocked.map((item) => item.id)).toEqual(["t-05"]);
  });

  it("the read command prints every item of a real todos folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-backlog-"));
    for (const [id, extra] of [["t-01", "status: ready\nestimate: 3"], ["t-02", "status: done"]] as const) {
      mkdirSync(join(dir, ".agents/todos/items", id), { recursive: true });
      writeFileSync(join(dir, ".agents/todos/items", id, "meta.yaml"), meta(id, extra));
    }
    const items = parseBacklogOutput(execSync(backlogReadCommand, { cwd: dir, shell: "/bin/sh", encoding: "utf8" }));
    expect(items.map((item) => [item.id, item.status])).toEqual([["t-01", "ready"], ["t-02", "done"]]);
    expect(parseBacklogOutput(execSync(backlogReadCommand, { cwd: tmpdir(), shell: "/bin/sh", encoding: "utf8" }))).toEqual([]);
  });
});

describe("the scanner", () => {
  it("hands one item a project a day to its owner's PM, never twice, and skips a project with no recent PM", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const sent: Array<{ threadId: string; text: string }> = [];
    harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return undefined; });
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => ({ role: threadId === "thr_pm" ? "pm" : "workflow-architect" }));
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    createRun(db, "run_cli", "P", "cli", "/repo");
    setRunThread(db, "run_cli", "thr_pm");
    // A workflow architect's newer chat with a run of its own is not the owner's PM.
    createRun(db, "run_arch", "P", "cli", "/repo");
    setRunThread(db, "run_arch", "thr_arch");
    db.prepare("UPDATE lane_pilot_run SET updated_at=updated_at+60000 WHERE id='run_arch'").run();
    const output = ["t-01", "t-02"].map((id) => `__lp_todo__ .agents/todos/items/${id}/meta.yaml\n${meta(id, "status: ready\npriority: high\nestimate: 3")}`).join("");
    const host = { call: async () => ({ exitCode: 0, stdout: output, stderr: "" }) };
    const api = createBacklog({ db, bb, host, log: () => undefined, isDisposed: () => false } as never).backlog;
    const now = Date.now();
    const first = await api.scan(now);
    expect(first).toEqual([{ projectId: "P", issued: "t-01", board: { issuable: 2, needsEstimate: 0, decompose: 0, blocked: 0 } }]);
    expect(sent).toEqual([{ threadId: "thr_pm", text: expect.stringContaining("«Item t-01» (t-01, оценка 3, приоритет high)") }]);
    expect((await api.scan(now + 3_600_000))[0]!.issued).toBeNull();
    expect((await api.scan(now + 25 * 3_600_000))[0]!.issued).toBe("t-02");
    expect((await api.board("P")).issuable).toEqual([]);
    expect((await runBacklogCli(api, [])).exitCode).toBe(1);
  });
});
