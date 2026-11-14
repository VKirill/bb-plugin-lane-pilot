// Region 21 (sma-tools: project queries): the scratch world the node tests and the scene probe share. A phase driver on a fake host whose
// file store is a map (a write is compare-and-swap on the file's hash, like the real one), a scratch database, no model, no hub.
// No vitest import: scenes/sma_r21_probe.ts loads this file under vite-node.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import type { Phase, PhaseRecord } from "../../src/rooms/phase/logic";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { insertPhase, savePhase, getPhase } from "../../src/rooms/phase/store";
import { runPhaseCli } from "../../src/rooms/phase/server/cli";

export const STATE = ".agents/planning/STATE.md";
export const ROADMAP = ".agents/planning/ROADMAP.md";
const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });

export type World = ReturnType<typeof phaseWorld>;

export function phaseWorld(options: { settings?: Record<string, unknown>; projects?: Record<string, string> } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ status: "idle", projectId: options.projects?.[args.threadId] ?? "projA" }) as never);
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string; expectedSha256: string | null }>;
      for (const edit of edits) if ((texts.has(edit.path) ? sha256Hex(texts.get(edit.path)!) : null) !== edit.expectedSha256) return { status: "conflict", writes: [], reason: "expected hash changed" };
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='t' WHERE id='run1'").run();
  const core = createCore(bb, db);
  core.effectiveProjectSettings = (async () => ({ values: options.settings ?? {} })) as never;
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => {
      if (!texts.has(i.path)) throw enoent(i.path);
      const c = texts.get(i.path)!;
      return { content: c, sha256: sha256Hex(c), sizeBytes: c.length, truncated: false };
    },
    dispatchWriter: async () => ({ taskId: "none", runId: "run1" }),
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(core, services).phases;
  const cli = (...argv: string[]) => runPhaseCli(phases, argv);
  return { phases, db, texts, bb, harness, core, cli };
}

/** A phase put in the book directly, at the stage and with the record the case needs. */
export function seedPhase(w: World, over: { id?: string; title?: string; goal?: string; stage?: Phase["stage"]; record?: Partial<PhaseRecord> } = {}): string {
  const id = over.id ?? "ph_r21";
  insertPhase(w.db, { id, projectId: "projA", pmThreadId: "t", title: over.title ?? "Sum", goal: over.goal ?? "sums", runId: "run1", at: 1 });
  savePhase(w.db, id, { stage: over.stage ?? "planning", record: { context: { docs: [], sha: "ctx", signedAt: 1, legacy: true }, ...(over.record ?? {}) } as PhaseRecord, at: 1 });
  return id;
}
export const livePhase = (w: World, id = "ph_r21") => getPhase(w.db, id)!;
