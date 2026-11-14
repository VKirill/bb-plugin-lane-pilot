// Region 3 · Worker, batch a: behaviour proofs of the cards that had no test, or none a mutation of the node's own code fails.
// Stand-in hosts, scratch databases and folders, a fake sudo/setfacl; no model, no hub write. The worlds are in tests/sma/r03-world-a.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBES } from "../../src/rooms/native-agent/server/helper-probe";
import { listReceipts } from "../../src/rooms/capability";
import { saveReceipt } from "../../src/rooms/capability/store";
import { openDatabase } from "../../src/rooms/plugin-db";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { adapterVersions, dueProbes } from "../../src/rooms/capability/logic";
import { WORKER_ENVELOPE } from "../../src/rooms/tasks/rails";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { workerReachable } from "../../src/rooms/verification/worker-user";
import {
  guardOnce, permitDecision, permitChannel,
  acceptedReceipts, capabilitySweep, checksAsWorker, confinedRun, criticEnvironments, folderGrants, pmActivation, roleModels, workerUserScript, writerLaunch,
} from "./r03-world-a";

const ROOT = join(__dirname, "../..");
const json = (file: string) => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { nodes: Array<{ id?: string; role?: string }> };

describe("capability cells: probes, receipts and the mandatory cells", () => {
  it("[sma:wc_mandatory] [sma:wc_receipt] a sweep keeps one receipt per cell; the accounting cell that failed is the only red one and is not probed again", async () => {
    const seen = await capabilitySweep();
    const cell = (name: string) => seen.receipts.find((row) => row.capability === name)!;
    // pause, accounting, progress and gate each have a receipt of their own, with the model it was probed on and the version key it applies to
    for (const name of ["pause", "accounting", "progress", "gate"]) {
      expect(cell(name), name).toMatchObject({ providerId: "codex", model: "gpt-6-luna" });
      expect(cell(name).version.startsWith("0.1.0#")).toBe(true);
    }
    expect(cell("accounting")).toMatchObject({ state: "not_supported", detail: "accounting: the turn's spend is not on the books (known=false, tokens=0)" });
    expect(seen.receipts.filter((row) => row.state === "not_supported").map((row) => row.capability)).toEqual(["accounting"]);
    expect(["pause", "progress", "gate"].map((name) => [cell(name).state, cell(name).detail])).toEqual([["supported", null], ["supported", null], ["supported", null]]);
    expect(seen.receipts).toHaveLength(9);
    expect(seen.probed).toHaveLength(9);
    // the receipt settles the key: a second sweep probes nothing
    expect(seen.second).toBe(0);
    expect(seen.rows).toBe(9);
  });

  it("[sma:wc_receipt] a later probe of the same cell replaces its receipt: state, model, detail and time", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    saveReceipt(db, { providerId: "codex", version: "1#k", capability: "pause", state: "supported", model: "m1", detail: null, at: 10 });
    saveReceipt(db, { providerId: "codex", version: "1#k", capability: "pause", state: "not_supported", model: "m2", detail: "pause: not resumed", at: 20 });
    saveReceipt(db, { providerId: "codex", version: "2#k", capability: "pause", state: "supported", model: "m2", detail: null, at: 30 });
    expect(listReceipts(db)).toEqual([
      { providerId: "codex", version: "1#k", capability: "pause", state: "not_supported", model: "m2", detail: "pause: not resumed", at: 20 },
      { providerId: "codex", version: "2#k", capability: "pause", state: "supported", model: "m2", detail: null, at: 30 },
    ]);
  });

  it("[sma:wc_documentary] the role cell reads the thread's spawn metadata; the session-end cell reads the output after stop (the model's word is not proof)", async () => {
    const bbWith = (meta: unknown, output: unknown) => ({ log: { warn: () => undefined, info: () => undefined }, sdk: { threads: {
      getPluginMetadata: meta === "absent" ? undefined : async () => meta,
      stop: async () => undefined,
      output: async () => ({ output }),
    } } }) as never;
    const role = PROBES["documentary.role"].check;
    const args = (bb: never) => ({ bb, threadId: "t", hostId: "h", workspace: "/w", output: "ROLE" });
    expect(await role(args(bbWith({ role: "pm-reader" }, "")))).toEqual({ ok: true });
    const wrong = await role(args(bbWith({ role: "writer" }, "")));
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.reason).toContain("does not carry the pm-reader role (role=writer)");
    expect((await role(args(bbWith({}, "")))).reason).toContain("helper_probe_metadata_unreadable");
    expect((await role(args(bbWith("absent", "")))).reason).toContain("helper_probe_metadata_unreadable");
    const end = PROBES["documentary.session_end"].check;
    expect(await end(args(bbWith({}, "SESSION")))).toEqual({ ok: true });
    expect(await end(args(bbWith({}, "  ")))).toEqual({ ok: false, reason: "documentary.session_end: the thread's output is not readable after stop" });
  });
});

describe("the separate worker user", () => {
  it("[sma:wi_user] create makes the user and a sudoers rule for the owner to run as that user only, without a password asked or stored; check reports reachable or unreachable by its exit code", () => {
    const seen = workerUserScript();
    expect(seen.createCalls).toContain("sudo useradd --system --no-create-home --shell /bin/bash lp-sma-r03-user");
    expect(seen.createCalls).toContain("sudo chmod 0440 /etc/sudoers.d/lp-worker-owner");
    // the rule: this owner may run as this one user, with no password, keeping the sandbox's variables — and nothing else
    expect(seen.rule).toBe("owner ALL=(lp-sma-r03-user) NOPASSWD:SETENV: ALL\n");
    expect(seen.createOut).toContain("user lp-sma-r03-user made");
    expect(seen.createOut).toContain("reachable: owner runs as lp-sma-r03-user without a password");
    expect(seen.createCalls.filter((line) => /\bpasswd\b|chpasswd| -S( |$)/.test(line))).toEqual([]);
    expect(seen.checkReachable).toMatchObject({ code: 0 });
    expect(seen.checkReachable.out).toContain("reachable: owner runs as lp-sma-r03-user without a password");
    expect(seen.checkUnreachable.code).toBe(1);
    expect(seen.checkUnreachable.out).toContain("unreachable: run");
    // a name that is not a user name stops before anything runs
    expect(seen.badName.code).toBe(2);
    expect(seen.badName.err).toContain("bad user name: Bad User");
    expect(seen.usage).toBe(2);
  });

  it("[sma:wi_clone] a strict worker is granted exactly the folders it was given, each grant is listed with the user and the owner, and a folder the tool refused is neither granted nor listed", async () => {
    const seen = await folderGrants();
    expect(seen.granted).toEqual(["<run>"]);
    expect(seen.ledger).toEqual([{ at: expect.any(Number), user: "lp-worker", owner: expect.any(String), path: "<run>" }]);
    // the rights name only that user and the owner, on exactly the folder passed
    expect(seen.calls).toEqual([
      "setfacl -R -m u:lp-worker:rwX,d:u:lp-worker:rwX,u:" + seen.ledger[0]!.owner + ":rwX,d:u:" + seen.ledger[0]!.owner + ":rwX <run>",
      "setfacl -R -m u:lp-worker:rwX,d:u:lp-worker:rwX,u:" + seen.ledger[0]!.owner + ":rwX,d:u:" + seen.ledger[0]!.owner + ":rwX <refused>",
    ]);
  });

  it("[sma:wi_exec] with worker.strict_user on the project's checks run through the host call as worker.user (lp-worker by default); off or unset they send no user", async () => {
    const on = await checksAsWorker({ "worker.strict_user": "on" });
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((input) => input.asUser === "lp-worker" && input.command === "node plain.js")).toBe(true);
    expect((await checksAsWorker({ "worker.strict_user": "on", "worker.user": "ci-bot" })).every((input) => input.asUser === "ci-bot")).toBe(true);
    for (const off of [{}, { "worker.strict_user": "off", "worker.user": "ci-bot" }] as Array<Record<string, string>>) {
      const inputs = await checksAsWorker(off);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => !("asUser" in input))).toBe(true);
    }
  });

  it("[sma:wi_check] a check is one command in a confined copy: its output and exit code come back, a write outside the workspace is refused, one inside is not, a runaway is stopped at its limit", async () => {
    const seen = await confinedRun();
    if (!seen) return; // no bubblewrap on this machine: the macOS sandbox has its own tests
    expect(seen.answer).toEqual({ exitCode: 0, stdout: "one-answer\n", backend: "linux-bubblewrap", policy: true });
    expect(seen.failing).toEqual({ exitCode: 3, stdout: "seen\n" });
    expect(seen.timedOut).toBe(124);
    expect(seen.outside.created).toBe(false);
    expect(seen.outside.exitCode).not.toBe(0);
    expect(seen.inside).toEqual({ exitCode: 0, created: true });
  }, 60_000);

  it("[sma:wi_critic] the critic of an attempt reads the attempt's own copy: the newest attempt's environment at that path, nothing for another path or an attempt with none", () => {
    expect(criticEnvironments()).toEqual({ atWorktree: { type: "reuse", environmentId: "env_new" }, otherPath: null, noEnvironment: null });
  });

  it("[sma:wi_receipts] an accepted attempt's receipts are written once into the task's home in the base checkout and survive the worktree", async () => {
    const seen = await acceptedReceipts();
    expect(seen.before).toBe(true);
    expect(seen.acceptancePath).toBe("/srv/proj/.agents/tasks/t1/acceptance.json");
    expect(seen.receiptPath).toBe("/srv/proj/.agents/tasks/t1/receipt.json");
    expect(seen.acceptance).toBe("{\"ok\":true}\n");
    expect(seen.receipt).toBe("{\"status\":\"accepted\"}\n");
    expect(seen.onlyBase).toBe(true);
    expect(seen.report).toBe("the report\n");
  });
});

describe("the worker roles", () => {
  it("[sma:wr_executor] the default role writes: a writer attempt's thread is started as role writer for its own task, attempt and PM, with the brief; an emergency fallback is the same worker under its own name", async () => {
    const normal = await writerLaunch(false);
    expect(normal).toMatchObject({ role: "writer", lanePilotTaskId: "T1", attemptId: "a1", parentPmThreadId: "thr_pm" });
    expect(normal.prompt).toContain("You are Lane Pilot writer");
    expect(normal.prompt).toContain("Work only inside owns_paths");
    expect((await writerLaunch(true)).role).toBe("emergency-writer");
  });

  it("[sma:wr_designer] the drawing step is led by the design-lead specialist, not the writer", () => {
    const draw = json("workflows/lp.draw.json").nodes.filter((node) => node.role);
    expect(draw.map((node) => node.role)).toEqual(["specialist:design-lead", "specialist:design-lead", "plan-critic"]);
    expect(draw.some((node) => node.role === "writer")).toBe(false);
  });

  it("[sma:wr_planner] the planner is a role of its own in the plan pipeline, ahead of the plan critic", () => {
    const nodes = json("workflows/lp.plan.json").nodes;
    const order = nodes.filter((node) => node.role === "planner" || node.role === "plan-critic").map((node) => node.role);
    expect(order).toEqual(["planner", "plan-critic"]);
    expect(nodes.some((node) => node.role === "writer")).toBe(false);
  });

  it("[sma:wr_orchestrator] the conversation's orchestrator is the PM: activation starts it as role pm bound to its run, and a writer thread cannot start one", async () => {
    const seen = await pmActivation();
    expect(seen).toMatchObject({ threadId: "pm-main", role: "pm", runPmThread: "pm-main", runKind: "bb", spawns: 1 });
    expect(seen.metaRunId).toBe(seen.runId);
  });

  it("[sma:wr_models] a role runs on its table row, an owner's pick replaces it, and a pick without an effort takes the model's own effort, not the row's", () => {
    const seen = roleModels() as Record<string, { providerId: string; model: string; effort: string; source: string } & string>;
    expect(seen.plannerDefault).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "default" });
    expect(seen.pmReaderDefault).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(seen.ownerPickNoEffort).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium", source: "table" });
    expect(seen.ownerPickWithEffort).toMatchObject({ model: "claude-sonnet-5-5", effort: "xhigh", source: "table" });
    expect(seen.workerAlias).toBe("claude-opus-5-5");
  });
});

describe("worker gates: values, not only shapes", () => {
  it("[sma:wb_envelope] each dimension of the envelope names the file that enforces it, and that file exists", () => {
    const named = Object.entries(WORKER_ENVELOPE).map(([key, text]) => [key, [...text.matchAll(/\((?:[^()]*? )?((?:src|lane-stack|packages)\/[A-Za-z0-9_./-]+)/g)].map((m) => m[1]!)] as const);
    for (const [key, paths] of named) for (const path of paths) expect(existsSync(join(ROOT, path)) || existsSync(join(ROOT, path.replace(/\/$/, ""))), `${key}: ${path}`).toBe(true);
    expect(WORKER_ENVELOPE.files).toContain("(src/rooms/verification/git-ownership.ts)");
  });

  it("[sma:wb_danger] the guard names the category of a writer's danger: forced clean, hard reset; a plain clean dry-run names none; the PM gets no ticket", () => {
    expect(guardOnce("git clean -fd", "writer", "writer").tickets.map((row) => row.category)).toEqual(["worker_clean_force"]);
    expect(guardOnce("git reset --hard", "writer", "writer").tickets.map((row) => row.category)).toEqual(["worker_reset_hard"]);
    expect(guardOnce("git clean -n", "writer", "writer").tickets).toEqual([]);
    expect(guardOnce("git clean -fd", "lane-pilot-pm", "pm").tickets).toEqual([]);
  });

  it("[sma:wb_ticket] a fresh ticket is listed and answerable, a stale one is neither", async () => {
    const seen = await permitChannel();
    expect(seen.listed).toEqual(["ffffffffffffffff"]);
    expect(seen.freshAnswer).toMatchObject({ written: true });
    expect(seen.freshAnswerFile).toBe(true);
    expect(seen.staleAnswer).toMatchObject({ written: false, expired: true });
    expect(seen.staleAnswerFile).toBe(false);
  });

  it("[sma:wb_decision] the host is told the decision that was given, allow or deny, for that ticket and session", async () => {
    const seen = await permitDecision();
    expect(seen.map((row) => row.hostGot)).toEqual([
      { decision: "allow", ticket: "a1b2c3d4e5f60718", session: "sess-b" },
      { decision: "deny", ticket: "a1b2c3d4e5f60718", session: "sess-b" },
    ]);
    expect(seen.map((row) => row.returned)).toEqual([
      { ticket: "a1b2c3d4e5f60718", decision: "allow", written: true },
      { ticket: "a1b2c3d4e5f60718", decision: "deny", written: true },
    ]);
    expect(seen.map((row) => row.sentMode)).toEqual(["queue-if-active", "queue-if-active"]);
  });

  it("[sma:wc_status] a probe that answered is supported, one that failed is not_supported", async () => {
    const seen = await capabilitySweep();
    const state = (name: string) => seen.receipts.find((row) => row.capability === name)!.state;
    expect([state("pause"), state("gate"), state("accounting")]).toEqual(["supported", "supported", "not_supported"]);
  });

  it("[sma:wc_probe] a provider without an installed version is not probed; one with no receipt is", () => {
    expect(dueProbes(new Map([["codex", "m"]]), new Map([["codex", null]]), [])).toEqual([]);
    expect(dueProbes(new Map([["codex", "m"]]), new Map([["codex", "1"]]), []).length).toBeGreaterThan(0);
  });

  it("[sma:wc_applicable] the installed version of a provider is its adapter plugin's, by plugin id; none for a provider with no plugin or a missing one", () => {
    const versions = adapterVersions([{ id: "codex", pluginId: "provider-codex" }, { id: "acp", pluginId: null }, { id: "ghost", pluginId: "gone" }], [{ id: "provider-codex", version: "0.1.0" }, { id: "codex", version: "9.9.9" }]);
    expect([...versions.entries()]).toEqual([["codex", "0.1.0"], ["acp", null], ["ghost", null]]);
  });
});

describe("the worker user probe", () => {
  it("[sma:wi_probe] a user sudo can run a no-op as is reachable, one that does not exist is not; a bad name is not a pass", async () => {
    const me = userInfo().username;
    expect(await workerReachable("Bad User")).toBe(false);
    expect(await workerReachable("lp-sma-no-such-user")).toBe(false);
    const sudoWorks = spawnSync("/usr/bin/sudo", ["-n", "-u", me, "/usr/bin/true"]).status === 0;
    if (sudoWorks) expect(await workerReachable(me)).toBe(true); // a machine without passwordless sudo cannot show the reachable side
  });
});
