// Probe of scenes/sma_r13.py: runs the real guard checks of THIS checkout (the commit under drill) and prints what they returned as one
// JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
// Imported through tests/helpers/guard-tools (a re-export once the tools move to src/), so it runs before and after that move.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { rpcContract } from "../../../src/rooms/contracts";
import { createAttempt } from "../../../src/rooms/storage/attempts-store";
import { failedTasksAllProjects } from "../../../src/rooms/storage/attempts-store/project-reads";
import { transitionAttempt } from "../../../src/rooms/storage/attempts-store/transition";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { createTask } from "../../../src/rooms/storage/tasks-store";
import { terminalParity, type ParityLayerSet } from "../../../src/rooms/native-agent/terminal-parity";
import { UNSHOWN_FIELDS, houseWordHits, internalIds, leakFindings, leaks, parityGaps, unreadFields } from "../../../tests/helpers/guard-tools";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
// Sources that draw the answer fields: the ui faces of every room and the app shell (what tests/support/room-files.ts lists).
const uiSources = [...readdirSync(join(ROOT, "src/rooms")).flatMap((room) => { try { return walk(join(ROOT, "src/rooms", room, "ui")); } catch { return []; } }), join(ROOT, "app.tsx")]
  .filter((path) => /\.tsx?$/.test(path)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const baseline = new Set(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/unread-fields-baseline.json"), "utf8")) as string[]);

// Planted values are built in pieces: this file is itself under scripts/, not scanned, but a literal must not look like a leak either.
const secret = ["sk", "a".repeat(24)].join("-");
const oldBrand = ["Claude", "Lane"].join(" ");
const layers = (over: Partial<ParityLayerSet> = {}): ParityLayerSet => ({ hooks: ["0.1.1"], memory: ["m1", "m2"], rules: ["r1"], skills: ["s1"], permissions: ["a"], model: ["claude-code/m"], ...over });
const unreadReal = unreadFields(rpcContract as never, uiSources, UNSHOWN_FIELDS);
const unreadSynthetic = unreadFields({ zeta: { output: z.object({ a: z.string(), b: z.number(), c: z.boolean() }) } } as never, [{ path: "x.tsx", text: "const v = row.a; const { b } = row;" }], {});

// n1046: the failure-journal sweep on a scratch database: the latest attempt of each failed task, across projects, newest first.
function failedSweep() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const task = (runId: string, projectId: string, taskId: string) => { createRun(db, runId, projectId); createTask(db, { id: taskId, runId, kind: "bb", contract: {} as never }); };
  task("r1", "projA", "t_fail_twice"); task("r2", "projB", "t_blocked"); task("r3", "projA", "t_fixed"); task("r4", "projA", "t_running");
  const attempt = (id: string, runId: string, taskId: string, ...moves: Array<[string, Record<string, unknown>?]>) => {
    createAttempt(db, { id, runId, taskId });
    transitionAttempt(db, id, "spawn_requested");
    for (const [state, extra] of moves) transitionAttempt(db, id, state as never, extra as never);
  };
  attempt("a1", "r1", "t_fail_twice", ["running", { threadId: "tw1" }], ["provider_error", { reason: "boom" }]);
  attempt("a2", "r1", "t_fail_twice", ["blocked", { reason: "still broken" }]);
  attempt("a3", "r2", "t_blocked", ["blocked", { reason: "nope" }]);
  attempt("a4", "r3", "t_fixed", ["blocked", { reason: "was broken" }]);
  attempt("a5", "r3", "t_fixed", ["running", { threadId: "tw5" }], ["accepted"]);
  attempt("a6", "r4", "t_running", ["running", { threadId: "tw6" }]);
  const rows = failedTasksAllProjects(db, 0);
  const newest = Math.max(...rows.map((row) => row.failedAt));
  return { attempts: rows.map((row) => `${row.attemptId}:${row.projectId}:${row.state}:${row.reason}`), newestFirst: rows.every((row, i) => i === 0 || rows[i - 1]!.failedAt >= row.failedAt), afterNewest: failedTasksAllProjects(db, newest + 1).length };
}

process.stdout.write(JSON.stringify({
  failedSweep: failedSweep(),
  leakPlanted: leaks(`ok\n${secret}\nok`).map((hit) => hit.line),
  leakClean: leaks("ok\nno secret here\n"),
  leakRepo: leakFindings(ROOT),
  houseWords: houseWordHits({ brand: `ported from ${oldBrand}`, shortColour: "paint it #abc", attemptId: "open lpattempt_0123456789abcdef", clean: "Lane Pilot task {taskId} failed", plainNumber: "version 12" }).sort(),
  internal: internalIds({ attempt: "Open lpattempt_0123456789abcdef", thread: "Thread thr_nj6fa3v9 waits", placeholder: "Task {taskId} waits", short: "thr_short is no id" }),
  unreadSynthetic,
  unshown: Object.entries(UNSHOWN_FIELDS).map(([field, reason]) => ({ field, methodKnown: field.split(".")[0]! in rpcContract, words: reason.trim().split(/\s+/).length, silenced: !unreadFields(rpcContract as never, [], UNSHOWN_FIELDS).includes(field) })),
  unreadRealOutsideBaseline: unreadReal.filter((field) => !baseline.has(field)),
  unreadRealCount: unreadReal.length,
  parityDiffer: terminalParity(layers({ memory: ["m1", "m3"], skills: [] }), layers({ memory: ["m1", "m2"], skills: ["s9"] })).map((line) => `${line.layer}:${String(line.same)}:${line.detail}`),
  parityMissing: terminalParity(layers({ rules: null }), layers()).find((line) => line.layer === "rules"),
  gaps: parityGaps(["Read", "Bash", "Read"], ["Read", "Grep"]),
}));
