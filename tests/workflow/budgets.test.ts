import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { workflowBudgetDefaults, WORKFLOW_NODE_BUDGET_TOKENS_KEY, WORKFLOW_STUCK_REPEAT_LIMIT_KEY } from "@lane-pilot/settings-catalog";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { registerHelperThread, registerThreadProcess, stopThreadTree } from "../../src/rooms/platform/server";
import { SETTINGS_REGISTRY } from "../../src/rooms/settings-registry";
import { waitAndGuardThread } from "../../src/rooms/workflow/server/services/workflow-agent-guard";
import { engineOn, journalDb, wf } from "./engine-helpers";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Task 30: workflow budgets, stuck detector, child tree kill, and stop hooks", () => {
  it("a node over its token cap stops with budget_exhausted (counting cache tokens and logging)", async () => {
    const db = journalDb();
    const warns: string[] = [];
    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: async (ctx) => {
          // Turn 1 stays under node cap (600 <= 1000).
          const t1 = await ctx.checkTurn?.({
            usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100 },
          });
          expect(t1).toEqual({ stop: false });
          // Turn 2 crosses node cap once cache tokens are included (600 + 500 = 1100 > 1000).
          const t2 = await ctx.checkTurn?.({
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 50 },
          });
          expect(t2).toMatchObject({ stop: true, reason: "budget_exhausted", kind: "tokens" });
          return { output: { text: "should-not-complete", handoff: "none" } };
        },
      },
      next: { reentrant: true, run: async () => ({ output: { text: "ok" } }) },
    }, {
      logger: { warn: (msg) => warns.push(msg) },
    });
    const flow = wf({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          uses: "agent",
          prompt: "work",
          budget: { maxTokens: 1000 },
          out: [{ name: "text", type: "string" }],
        },
        { id: "next", type: "action", action: "next", output: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "next" },
        { from: "next", to: "end", with: { result: "next.text" } },
      ],
    });
    try {
      const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
      expect(summary.status).toBe("blocked");
      expect(summary.reason).toContain("budget_exhausted");
      expect(warns.some((line) => /WARN budget exhausted node=work kind=tokens used=1100 cap=1000/.test(line))).toBe(true);
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("enforces settings-home defaults when workflow/node omit explicit budgets", async () => {
    const db = journalDb();
    const defaults = workflowBudgetDefaults({
      [WORKFLOW_NODE_BUDGET_TOKENS_KEY]: 500,
      [WORKFLOW_STUCK_REPEAT_LIMIT_KEY]: 10,
    });
    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: async () => ({
          output: { text: "over", handoff: "done" },
          usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 200, answeredModel: "claude-sonnet-5" },
        }),
      },
    }, {
      budgetDefaults: defaults,
    });
    const flow = wf({
      nodes: [{ id: "step", type: "agent", role: "analyst", uses: "agent", prompt: "go", out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "step" }, { from: "step", to: "end", with: { result: "step.text" } }],
    });
    try {
      const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
      expect(summary.status).toBe("blocked");
      expect(summary.reason).toContain("budget_exhausted");
      expect(SETTINGS_REGISTRY.get(WORKFLOW_NODE_BUDGET_TOKENS_KEY)?.default).toBe(400_000);
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("unknown cost does not count as 0 against the USD cap (the step is held for the owner)", async () => {
    const db = journalDb();
    const held: Array<{ runId: string; stepKey: string; nodeId: string; costState: string }> = [];
    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: async () => ({
          output: { text: "ok", handoff: "done" },
          // Unpriced model / unknown spend -> Task 26 resolves costState = "not_measured" & costMicroUsd = null
          usage: { tokens: 1200, answeredModel: "unpriced-custom-model" },
        }),
      },
    }, {
      onHoldOwner: (info) => { held.push(info); },
    });
    const flow = wf({
      nodes: [
        {
          id: "writer",
          type: "agent",
          role: "analyst",
          uses: "agent",
          prompt: "draft",
          budget: { maxCostUsd: 2 },
          out: [{ name: "text", type: "string" }],
        },
      ],
      edges: [
        { from: "start", to: "writer" },
        { from: "writer", to: "end", with: { result: "writer.text" } },
      ],
    });
    try {
      const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
      expect(summary.status).toBe("waiting");
      expect(summary.waiting).toHaveLength(1);
      expect(summary.waiting[0]?.nodeId).toBe("writer");
      expect(summary.waiting[0]?.await).toMatchObject({ kind: "owner_approval" });
      expect(held).toHaveLength(1);
      expect(held[0]?.costState).toBe("not_measured");
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("ten identical tool calls in a row trigger stuck and stop the step", async () => {
    const db = journalDb();
    const warns: string[] = [];
    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: async (ctx) => {
          for (let i = 1; i <= 10; i++) {
            const decision = await ctx.checkTurn?.({
              toolCalls: [{
                tool: "shell",
                // Flip key order on odd/even turns to ensure canonical argument comparison detects identical calls.
                args: i % 2 === 0 ? { cmd: "ls", flags: "-la" } : { flags: "-la", cmd: "ls" },
              }],
            });
            if (i < 10) expect(decision).toEqual({ stop: false });
            else expect(decision).toMatchObject({ stop: true, reason: "stuck", call: "shell", repeats: 10 });
          }
          return { output: { text: "unreachable", handoff: "none" } };
        },
      },
    }, {
      logger: { warn: (msg) => warns.push(msg) },
    });
    const flow = wf({
      nodes: [{ id: "loop", type: "agent", role: "analyst", uses: "agent", prompt: "loop", out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "loop" }, { from: "loop", to: "end", with: { result: "loop.text" } }],
    });
    try {
      const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
      expect(summary.status).toBe("blocked");
      expect(summary.reason).toContain("stuck");
      expect(warns.some((line) => /WARN stuck node=loop call=shell repeats=10/.test(line))).toBe(true);
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("stopping a parent leaves no child process alive and stops helper threads", async () => {
    const db = journalDb();
    const infos: string[] = [];
    const stoppedThreads: string[] = [];
    const spawnedChildPids: number[] = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          stop: async ({ threadId }: { threadId: string }) => {
            stoppedThreads.push(threadId);
            return { ok: true };
          },
          experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) =>
            threadIds.map((threadId) => ({
              threadId,
              descendantIds: threadId === "thr-parent" ? ["thr-helper-1"] : [],
            })),
        },
      } as never,
    });

    // Spawn a real OS child process with its own grandchild process.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process'); const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log(gc.pid); setInterval(() => {}, 1000);",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timed out reading grandchild pid")), 5000);
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const line = buf.trim().split("\n")[0];
        if (line && /^\d+$/.test(line)) {
          clearTimeout(timer);
          resolve(Number(line));
        }
      });
    });
    spawnedChildPids.push(child.pid!, grandchildPid);
    expect(isAlive(child.pid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: (ctx) => new Promise((_resolve, reject) => {
          ctx.trackChild?.({ pid: child.pid! });
          ctx.trackChild?.({ threadId: "thr-parent" });
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      },
    }, {
      logger: { info: (msg) => infos.push(msg) },
      stopThread: (threadId) => stopThreadTree(bb, threadId).then((r) => r.killed),
    });

    const flow = wf({
      nodes: [{ id: "worker", type: "agent", role: "analyst", uses: "agent", prompt: "run", out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "worker" }, { from: "worker", to: "end", with: { result: "worker.text" } }],
    });

    try {
      registerHelperThread("thr-parent", "thr-helper-2");
      registerThreadProcess("thr-helper-1", child.pid!);
      const run = engine.start({ workflow: flow, inputs: { query: "q" } });
      await new Promise((r) => setTimeout(r, 80));
      const { stopped, childrenKilled } = await engine.stopRun(run.runId, "owner_stop");
      await run.done;
      expect(stopped).toBe(true);
      expect(childrenKilled).toBeGreaterThanOrEqual(2);
      expect(isAlive(child.pid!)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
      expect(stoppedThreads).toContain("thr-parent");
      expect(stoppedThreads).toContain("thr-helper-1");
      expect(stoppedThreads).toContain("thr-helper-2");
      expect(infos.some((line) => /INFO run stopped children_killed=\d+/.test(line))).toBe(true);
    } finally {
      for (const pid of spawnedChildPids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
      engine.dispose();
      db.close();
    }
  });

  it("a blocking stop hook with stop_hook_active lets the session end", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-stop-hook-"));
    cleanupDirs.push(root);
    const projectDir = join(root, "project");
    const destDir = join(root, "session");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await mkdir(destDir, { recursive: true });

    const blockingScript = join(projectDir, "block-stop.py");
    await writeFile(
      blockingScript,
      "import json, sys\nprint(json.dumps({'decision': 'block', 'reason': 'keep working'}))\nsys.exit(0)\n",
      "utf8",
    );
    await writeFile(
      join(projectDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: "*", hooks: [{ type: "command", command: `python3 '${blockingScript}'` }] }],
        },
      }),
      "utf8",
    );

    const materialized = await materializeNativeHookSession({ cwd: projectDir, destDir });
    const settings = JSON.parse(await readFile(materialized.settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const wrappedCommand = settings.hooks.Stop[0]!.hooks[0]!.command;
    expect(wrappedCommand).toContain("inject_agent_type.py");

    const injectPath = join(destDir, "hooks/inject_agent_type.py");

    // Without stop_hook_active, the blocking Stop hook returns its block decision.
    const first = spawnSync("python3", [injectPath, "--", "python3", blockingScript], {
      input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
    });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).decision).toBe("block");

    // With stop_hook_active=true, the guard lets the session end without blocking.
    const second = spawnSync("python3", [injectPath, "--", "python3", blockingScript], {
      input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }),
      encoding: "utf8",
    });
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("block");
    expect(JSON.parse(second.stdout)).toEqual({});
  });

  it("enforces per-node USD and wall-clock limits and logs WARN budget exhausted", async () => {
    const db = journalDb();
    const warns: string[] = [];
    let clock = 1_000;
    const engine = engineOn(db, {
      priced: {
        reentrant: true,
        run: async () => ({
          output: { text: "ok", handoff: "done" },
          // claude-opus-5-5: $4/M input + $20/M output -> 500k output = $10 > $1 cap
          usage: { inputTokens: 0, outputTokens: 500_000, answeredModel: "claude-opus-5-5" },
        }),
      },
      slow: {
        reentrant: true,
        run: async () => {
          clock += 10_000;
          return { output: { text: "ok" } };
        },
      },
    }, {
      now: () => clock,
      logger: { warn: (msg) => warns.push(msg) },
    });

    const usdFlow = wf({
      nodes: [{ id: "step_usd", type: "agent", role: "analyst", uses: "priced", prompt: "go", budget: { maxCostUsd: 1 }, out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "step_usd" }, { from: "step_usd", to: "end", with: { result: "step_usd.text" } }],
    });
    const wallFlow = wf({
      nodes: [{ id: "step_wall", type: "action", action: "slow", budget: { maxWallSeconds: 5 }, output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "step_wall" }, { from: "step_wall", to: "end", with: { result: "step_wall.text" } }],
    });

    try {
      const sUsd = await engine.start({ workflow: usdFlow, inputs: { query: "q" } }).done;
      expect(sUsd.status).toBe("blocked");
      expect(sUsd.reason).toContain("budget_exhausted:usd");
      expect(warns.some((l) => /WARN budget exhausted node=step_usd kind=usd used=10 cap=1/.test(l))).toBe(true);

      const sWall = await engine.start({ workflow: wallFlow, inputs: { query: "q" } }).done;
      expect(sWall.status).toBe("blocked");
      expect(sWall.reason).toContain("budget_exhausted:wall");
      expect(warns.some((l) => /WARN budget exhausted node=step_wall kind=wall used=10 cap=5/.test(l))).toBe(true);
    } finally {
      engine.dispose();
      db.close();
    }
  });

  it("waitAndGuardThread detects 10 identical tool calls in thread events and stops the thread", async () => {
    const stopped: string[] = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" }),
          stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return { ok: true }; },
          events: {
            list: async () => [
              { type: "turn/started", seq: 1 },
              ...Array.from({ length: 10 }, (_, idx) => ({
                type: "item/completed",
                seq: 2 + idx,
                data: { item: { type: "mcpToolCall", server: "fs", tool: "read", arguments: { path: "a.ts" } } },
              })),
              { type: "turn/completed", seq: 20, data: { status: "completed" } },
            ],
          },
        },
      } as never,
    });

    const db = journalDb();
    const engine = engineOn(db, {
      agent: {
        reentrant: true,
        run: async (ctx) => {
          await waitAndGuardThread({
            bb,
            threadId: "thr-stuck",
            label: "stuck_check",
            tracked: [{ id: "thr-stuck" }],
            shouldStop: () => null,
            checkTurn: ctx.checkTurn,
            trackChild: ctx.trackChild,
            usageCtx: { requestedProvider: null, requestedModel: null, answeredProvider: null, answeredModel: null },
          });
          return { output: { text: "ok", handoff: "done" } };
        },
      },
    });
    const flow = wf({
      nodes: [{ id: "live_stuck", type: "agent", role: "analyst", uses: "agent", prompt: "go", out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "live_stuck" }, { from: "live_stuck", to: "end", with: { result: "live_stuck.text" } }],
    });

    try {
      const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
      expect(summary.status).toBe("blocked");
      expect(summary.reason).toContain("stuck");
      expect(stopped).toContain("thr-stuck");
    } finally {
      engine.dispose();
      db.close();
    }
  });
});
