// Region 9 · Person and window, batch b (n786 … n813), the server halves: the RPCs the window's operations screens call, run through the real plugin
// with a fake host (no machine, no model, no hub). Each test checks the result a card names (what was answered, written or sent to the machine).
// The screens are in four-proofs-r09-b.test.tsx.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { backlogReadCommand } from "../../src/rooms/backlog";
import { backlogRpc, createBacklog } from "../../src/rooms/backlog/server";
import { createRun, openDatabase, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { loadProjectSettings, saveProjectSetting } from "../../src/rooms/storage";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

type Sent = { method: string; input: Record<string, unknown>; options: Record<string, unknown> };
/** The real plugin on a fake host; every host call is recorded and answered by `answer`. */
async function world(answer: (call: Sent) => unknown = () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const db = openDatabase(bb);
  const sent: Sent[] = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const call = { method, input, options }; sent.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return result;
  } })) as never;
  createRun(db, "r1", "p1", "bb", "/ws", "none", undefined as never, "h1");
  const call = <T = unknown>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  const refusal = async (name: string, input: Record<string, unknown> = {}) => { try { await call(name, input); return null; } catch (cause) { return (cause as Error).message; } };
  return { bb, db, call, refusal, sent };
}

describe("region 9 · first run on the server (the onboarding interview)", () => {
  it("[sma:d_onboarding] first_run_get answers the four steps and the draft, and says a first run is needed until the project has a writer or the interview was finished", async () => {
    const { call, db } = await world();
    const fresh = await call<{ needed: boolean; steps: Array<{ id: string }>; draft: { answers: Record<string, string> } }>("first_run_get", { projectId: "p1" });
    expect(fresh.needed).toBe(true);
    expect(fresh.steps.map((step) => step.id)).toEqual(["goal", "writer", "quality", "words"]);
    expect(fresh.draft.answers).toEqual({});
    // A project that already has a writer chosen needs no interview.
    saveProjectSetting(db, "p2", "writer.provider", "codex");
    expect((await call<{ needed: boolean }>("first_run_get", { projectId: "p2" })).needed).toBe(false);
  });

  it("[sma:d_onboarding_answer] first_run_answer keeps the trimmed answer under its step in the draft (later answers of other steps added), and refuses an answer that looks like a key and keeps nothing of it", async () => {
    const { call, refusal } = await world();
    const draft = await call<{ answers: Record<string, string> }>("first_run_answer", { projectId: "p1", step: "goal", answer: "  a shop with a cart  " });
    expect(draft.answers).toEqual({ goal: "a shop with a cart" });
    const second = await call<{ answers: Record<string, string> }>("first_run_answer", { projectId: "p1", step: "quality", answer: "full" });
    expect(second.answers).toEqual({ goal: "a shop with a cart", quality: "full" });
    expect(await refusal("first_run_answer", { projectId: "p1", step: "writer", answer: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })).toContain("looks like a key or a password");
    expect((await call<{ draft: { answers: Record<string, string> } }>("first_run_get", { projectId: "p1" })).draft.answers).toEqual({ goal: "a shop with a cart", quality: "full" });
  });

  it("[sma:d_onboarding_done] first_run_finish writes the answers as the project's settings (writer provider and model, quality, the owner's words, the goal), marks the interview done, and a first run is no longer needed", async () => {
    const { call, db } = await world();
    for (const [step, answer] of [["goal", "a shop"], ["writer", "codex / gpt-6-luna"], ["quality", "Full"], ["words", "yes"]] as const) await call("first_run_answer", { projectId: "p1", step, answer });
    expect(await call("first_run_finish", { projectId: "p1" })).toEqual({ written: ["writer.provider", "writer.model", "quality_mode", "owner.words"], goal: true });
    expect(loadProjectSettings(db, "p1")).toMatchObject({ "writer.provider": "codex", "writer.model": "gpt-6-luna", quality_mode: "full", "owner.words": "on", "project.goal": "a shop" });
    const after = await call<{ needed: boolean; draft: { done?: number } }>("first_run_get", { projectId: "p1" });
    expect(after.needed).toBe(false);
    expect(typeof after.draft.done).toBe("number");
  });
});

describe("region 9 · coordination on the server", () => {
  it("[sma:d_coordination] coord_status runs «lane-coord status» in the run's checkout on its machine and answers the exit code and the output (the error text when nothing came on stdout)", async () => {
    const { call, sent, refusal } = await world((c) => ({ hostId: "h1", exitCode: 0, stdout: "claim a1 term-1", stderr: "" }));
    expect(await call("coord_status", { runId: "r1" })).toEqual({ exitCode: 0, output: "claim a1 term-1" });
    expect(sent).toEqual([{ method: "runCommand", input: { requestedHostId: "h1", command: "lane-coord status", cwd: "/ws", timeoutSec: 20 }, options: { hostId: "h1", timeoutMs: 25_000 } }]);
    const quiet = await world(() => ({ hostId: "h1", exitCode: 3, stdout: "", stderr: "lane-coord: not found" }));
    expect(await quiet.call("coord_status", { runId: "r1" })).toEqual({ exitCode: 3, output: "lane-coord: not found" });
    expect(await quiet.refusal("coord_status", { runId: "nope" })).toContain("has no checkout");
    expect(await refusal("coord_status", { runId: "nope" })).toContain("has no checkout");
  });

  it("[sma:d_claim_clear] coord_clear force-clears the named session with the owner's reason: the session name keeps only safe characters and the reason loses its quotes, so nothing else can ride in the command", async () => {
    const { call, sent } = await world(() => ({ hostId: "h1", exitCode: 0, stdout: "cleared", stderr: "" }));
    expect(await call("coord_clear", { runId: "r1", session: "term-1.a:b_2", reason: "stuck since monday" })).toEqual({ exitCode: 0, output: "cleared" });
    expect(sent[0]!.input.command).toBe("lane-coord force-clear 'term-1.a:b_2' --reason 'stuck since monday'");
    await call("coord_clear", { runId: "r1", session: "t-1'; rm -rf /; echo '", reason: `it's "bad"` });
    expect(sent[1]!.input.command).toBe(`lane-coord force-clear 't-1rm-rfecho' --reason 'its "bad"'`);
    expect(sent[1]!.input).toMatchObject({ requestedHostId: "h1", cwd: "/ws", timeoutSec: 20 });
  });
});

describe("region 9 · bring your own helpers on the server", () => {
  const PAGES = [
    { path: ".claude/agents/yard.md", content: "---\nname: yard\ndescription: A yard agent.\n---\n\nKeep the yard tidy.\n" },
    { path: ".claude/skills/pick/SKILL.md", content: "---\nname: pick\ndescription: Use when picking.\n---\n\nDo the pick.\n" },
    { path: ".claude/agents/no-front-matter.md", content: "just text" },
    { path: ".cursor/agents/other.md", content: "---\nname: other\n---\nnot a helper root" },
  ];
  const answer = (c: Sent) => (c.method === "listDocsPages" ? { pages: PAGES } : { status: "applied" });

  it("[sma:d_import_scan] helpers_list asks the run's machine for the other tools' agent and skill folders and lists what parses (name, format, description), nothing from a file without front matter or outside the roots", async () => {
    const { call, sent } = await world(answer);
    const found = await call<Array<{ name: string; kind: string; format: string; description: string; source: string }>>("helpers_list", { runId: "r1" });
    expect(found.map((row) => `${row.format}:${row.kind}:${row.name}:${row.description}`)).toEqual(["claude:agent:yard:A yard agent.", "claude:skill:pick:Use when picking."]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "listDocsPages", input: { requestedHostId: "h1", projectCwd: "/ws", skipOversized: true }, options: { hostId: "h1" } });
    expect(sent[0]!.input.roots).toContain(".claude/agents");
  });

  it("[sma:d_import_enroll] helpers_import writes only the chosen helpers as drafts in their kind's forge folder, only if absent; a draft that exists answers «kept» and a host failure is said as «failed»", async () => {
    const { call, sent } = await world((c) => {
      if (c.method === "listDocsPages") return { pages: PAGES };
      const path = (c.input.edits as Array<{ path: string }>)[0]!.path;
      if (path.includes("/pick/")) return { status: "conflict" };
      return { status: "applied" };
    });
    expect(await call("helpers_import", { runId: "r1", names: ["yard", "pick", "no-front-matter"] })).toEqual([{ name: "yard", status: "applied" }, { name: "pick", status: "kept: a draft with this name exists" }]);
    const writes = sent.filter((c) => c.method === "writeForgeDraft").map((c) => (c.input.edits as Array<{ path: string; expectedSha256: unknown; content: string }>)[0]!);
    expect(writes.map((write) => [write.path, write.expectedSha256])).toEqual([[".agents/forge/roles/yard/yard.md", null], [".agents/forge/skills/pick/SKILL.md", null]]);
    expect(writes[0]!.content).toContain("name: yard\n");
    expect(writes[0]!.content).toContain("Keep the yard tidy.");
    const failing = await world((c) => (c.method === "listDocsPages" ? { pages: PAGES } : new Error("host offline")));
    expect(await failing.call("helpers_import", { runId: "r1", names: ["yard"] })).toEqual([{ name: "yard", status: "failed: host offline" }]);
  });
});

describe("region 9 · the update on the machine", () => {
  it("[sma:d_update_run] cockpit_update checks without applying («lane-stack-update --json», a minute) or applies («--yes», ten minutes) on the named machine and answers the exit code and the output clipped to 20000 characters, the error text when stdout is empty", async () => {
    const { call, sent } = await world((c) => ({ hostId: "h1", exitCode: 0, stdout: "x".repeat(25_000), stderr: "" }));
    const check = await call<{ exitCode: number; output: string }>("cockpit_update", { hostId: "h1", apply: false });
    expect(check.exitCode).toBe(0);
    expect(check.output).toHaveLength(20_000);
    await call("cockpit_update", { hostId: "h1", apply: true });
    expect(sent.map((c) => [c.input.command, c.input.timeoutSec, c.input.cwd, c.input.requestedHostId])).toEqual([["lane-stack-update --json", 60, "/tmp", "h1"], ["lane-stack-update --json --yes", 600, "/tmp", "h1"]]);
    const failed = await world(() => ({ hostId: "h1", exitCode: 2, stdout: "", stderr: "no network" }));
    expect(await failed.call("cockpit_update", { hostId: "h1", apply: false })).toEqual({ exitCode: 2, output: "no network" });
  });
});

describe("region 9 · the project backlog", () => {
  const meta = (id: string, extra: string) => `id: ${id}\ntitle: "Item ${id}"\ncreated: 2026-10-${id.slice(-2)}T10:00:00+02:00\n${extra}\n`;

  it("[sma:d_backlog] backlog_board reads the project's .agents/todos items on its machine (the real read command, run in a real folder) and sorts them into issuable, to decompose, to estimate and blocked; a project without a workspace says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-r09b-backlog-"));
    for (const [id, extra] of [["t-01", "status: ready\npriority: high\nestimate: 3"], ["t-02", "status: ready\nestimate: 21"], ["t-03", "status: ready"], ["t-04", "status: ready\nestimate: 2\ndepends_on: [t-05]"], ["t-05", "status: open"], ["t-06", "status: done"]] as const) {
      mkdirSync(join(dir, ".agents/todos/items", id), { recursive: true });
      writeFileSync(join(dir, ".agents/todos/items", id, "meta.yaml"), meta(id, extra));
    }
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: dir, writerWorkspacePath: dir, pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    savePrototypeConfig(db, { projectId: "Q", hostId: "h", pmWorkspacePath: "", writerWorkspacePath: "", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    const ran: string[] = [];
    // The host runs the command the plugin sends in the folder it names, as the machine does; the fetch before it fails (no remote).
    const host = { call: async (_method: string, input: { command: string; basePath: string }) => {
      ran.push(input.command);
      if (input.command !== backlogReadCommand) return { exitCode: 1, stdout: "", stderr: "no remote" };
      return { exitCode: 0, stdout: execSync(input.command, { cwd: input.basePath, shell: "/bin/sh", encoding: "utf8" }), stderr: "" };
    } };
    const rpc = backlogRpc(createBacklog({ db, bb, host, log: () => undefined, isDisposed: () => false } as never).backlog);
    const board = await rpc.backlog_board({ projectId: "P" });
    expect(board.issuable.map((item) => item.id)).toEqual(["t-01"]);
    expect(board.decompose.map((item) => item.id)).toEqual(["t-02"]);
    expect(board.needsEstimate.map((item) => item.id)).toEqual(["t-03"]);
    expect(board.blocked.map((item) => item.id)).toEqual(["t-04"]);
    expect(board.fetched).toBe(false);
    expect(ran).toEqual(["git fetch --quiet && git rev-list --count HEAD..@{u}", backlogReadCommand]);
    const none = await rpc.backlog_board({ projectId: "Q" });
    expect(none).toMatchObject({ issuable: [], needsEstimate: [], decompose: [], blocked: [], error: "the project has no workspace configured" });
  });
});
