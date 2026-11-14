// Probe of scenes/sma_r09_b.py (region 9, Person and window, batch b): runs the REAL RPCs and functions of THIS checkout (the commit under drill) that the window's
// operations screens call (first run, coordination, bring your own helpers, the update, the backlog board, the planning home), on a scratch database and a fake
// plugin host that records every host call, and prints what they returned as one JSON line. It judges nothing: the scene compares every value with the card's
// expected result and prove()s it. No model, no hub write, nothing outside the machine. The screens (jsdom) are not here: the scene runs their tests.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, openDatabase, savePrototypeConfig } from "../../../src/rooms/plugin-db";
import { loadProjectSettings } from "../../../src/rooms/storage";
import { backlogReadCommand } from "../../../src/rooms/backlog";
import { backlogRpc, createBacklog } from "../../../src/rooms/backlog/server";
import { planningRoot } from "../../../src/rooms/contracts/planning-root";
import plugin from "../../../server";

const out: Record<string, unknown> = {};

type Sent = { method: string; input: Record<string, unknown> };
const PAGES = [
  { path: ".claude/agents/yard.md", content: "---\nname: yard\ndescription: A yard agent.\n---\n\nKeep the yard tidy.\n" },
  { path: ".claude/skills/pick/SKILL.md", content: "---\nname: pick\ndescription: Use when picking.\n---\n\nDo the pick.\n" },
  { path: ".claude/agents/no-front-matter.md", content: "just text" },
];

// ---- n806 / n807 / n808 / n788 / n809 / n804 / n805 / n813: the real plugin's RPCs with a recording fake host ----
{
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const db = openDatabase(bb);
  const sent: Sent[] = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    sent.push({ method, input });
    if (method === "listDocsPages") return { pages: PAGES };
    if (method === "writeForgeDraft") return { status: (input.edits as Array<{ path: string }>)[0]!.path.includes("/pick/") ? "conflict" : "applied" };
    return { hostId: "h1", exitCode: 0, stdout: "ok", stderr: "" };
  } })) as never;
  createRun(db, "r1", "p1", "bb", "/ws", "none", undefined as never, "h1");
  // The answers are read field by field below; the probe does not type them (the scene judges them).
  const call = (name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<Record<string, any>>; // guardian: allow (an untyped probe answer)

  const fresh = await call("first_run_get", { projectId: "p1" });
  for (const [step, answer] of [["goal", "a shop"], ["writer", "codex / gpt-6-luna"], ["quality", "Full"], ["words", "yes"]] as const) await call("first_run_answer", { projectId: "p1", step, answer });
  const answered = await call("first_run_get", { projectId: "p1" });
  const finished = await call("first_run_finish", { projectId: "p1" });
  const after = await call("first_run_get", { projectId: "p1" });
  const settings = loadProjectSettings(db, "p1");
  out.firstRun = { freshNeeded: fresh.needed, steps: fresh.steps.map((step: { id: string }) => step.id), answered: answered.draft.answers, finished, settings: { provider: settings["writer.provider"], model: settings["writer.model"], quality: settings.quality_mode, words: settings["owner.words"], goal: settings["project.goal"] }, afterNeeded: after.needed, done: typeof after.draft.done };

  sent.length = 0;
  const status = await call("coord_status", { runId: "r1" });
  const cleared = await call("coord_clear", { runId: "r1", session: "t-1'; rm -rf /", reason: `it's "bad"` });
  out.coord = { status, cleared, commands: sent.map((c) => c.input.command) };

  sent.length = 0;
  const found = await call("helpers_list", { runId: "r1" });
  const taken = await call("helpers_import", { runId: "r1", names: ["yard", "pick", "no-front-matter"] });
  out.helpers = { found: found.map((row: { name: string; kind: string }) => `${row.kind}:${row.name}`), taken, paths: sent.filter((c) => c.method === "writeForgeDraft").map((c) => (c.input.edits as Array<{ path: string }>)[0]!.path) };

  sent.length = 0;
  await call("cockpit_update", { hostId: "h1", apply: false });
  await call("cockpit_update", { hostId: "h1", apply: true });
  out.update = sent.map((c) => c.input.command);
  await harness.lifecycle.dispose();
}

// ---- n787: the backlog board of a real todos folder, the real read command ----
{
  const dir = mkdtempSync(join(tmpdir(), "lp-r09b-backlog-"));
  const meta = (id: string, extra: string) => `id: ${id}\ntitle: "Item ${id}"\ncreated: 2026-10-${id.slice(-2)}T10:00:00+02:00\n${extra}\n`;
  for (const [id, extra] of [["t-01", "status: ready\npriority: high\nestimate: 3"], ["t-02", "status: ready\nestimate: 21"], ["t-03", "status: ready"], ["t-04", "status: ready\nestimate: 2\ndepends_on: [t-05]"], ["t-05", "status: open"]] as const) {
    mkdirSync(join(dir, ".agents/todos/items", id), { recursive: true });
    writeFileSync(join(dir, ".agents/todos/items", id, "meta.yaml"), meta(id, extra));
  }
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: dir, writerWorkspacePath: dir, pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
  const host = { call: async (_method: string, input: { command: string; basePath: string }) => input.command === backlogReadCommand
    ? { exitCode: 0, stdout: execSync(input.command, { cwd: input.basePath, shell: "/bin/sh", encoding: "utf8" }), stderr: "" } : { exitCode: 1, stdout: "", stderr: "no remote" } };
  const board = await backlogRpc(createBacklog({ db, bb, host, log: () => undefined, isDisposed: () => false } as never).backlog).backlog_board({ projectId: "P" });
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  out.backlog = { issuable: ids(board.issuable), decompose: ids(board.decompose), needsEstimate: ids(board.needsEstimate), blocked: ids(board.blocked) };
}

// ---- n794: the planning root: the home when one is set, else the run's checkout ----
out.planning = {
  home: planningRoot({ writer_workspace_path: "/checkout" }, { "project.planning_home": "/srv/plans" }, { userHome: "/home/u" }),
  unset: planningRoot({ writer_workspace_path: "/checkout" }, {}, { userHome: "/home/u" }),
  invalid: planningRoot({ writer_workspace_path: "/checkout" }, { "project.planning_home": "relative/dir" }, { userHome: "/home/u" }),
  none: planningRoot(null, {}),
};

console.log(JSON.stringify(out)); // guardian: allow (the probe's one JSON line is its answer to the scene)
