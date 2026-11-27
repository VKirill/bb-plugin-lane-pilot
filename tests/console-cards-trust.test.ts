import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUALITY_MODE_SETTING } from "../src/rooms/contracts";
import * as consoleContracts from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { registerRpc } from "../src/rooms/core/server/rpc";
import { cardsRpc, setCard } from "../src/rooms/memory/server";
import { WORKSPACE_MODE_SETTING } from "../src/rooms/native-agent";
import {
  createRun,
  finishGateRun,
  noteGateRunStart,
  openDatabase,
  saveProjectSetting,
  sectionBindingId,
} from "../src/rooms/plugin-db";
import {
  TRUST_HIGH_MAX_ROLLBACKS,
  TRUST_LOW_MIN_ROLLBACKS,
  TRUST_WINDOW_DAYS,
  TRUST_WINDOW_MS,
} from "../src/rooms/repo-trust";
import { repoTrust, repoTrustRpc } from "../src/rooms/repo-trust/server";
import { appendTaskReceipt } from "../src/rooms/rollback/server";
import type { Services } from "../src/rooms/services";

const HEAD_A = "1111111111111111111111111111111111111111";
const HEAD_B = "2222222222222222222222222222222222222222";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function fakeServices(): Services {
  return new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => undefined }) }) as unknown as Services;
}

function seedGateRow(
  db: ReturnType<typeof openDatabase>,
  input: {
    projectId: string;
    runId: string;
    state: "passed" | "failed" | "running" | "not_run";
    head?: string | null;
    reason?: string | null;
    updatedAt: number;
  },
): void {
  const id = noteGateRunStart(db, {
    projectId: input.projectId,
    runId: input.runId,
    scopeKey: "main",
    command: "npm test",
    batch: [],
  });
  if (input.state !== "running") {
    finishGateRun(db, id, input.state, {
      head: input.head ?? null,
      reason: input.reason ?? null,
    });
  }
  db.prepare("UPDATE lane_pilot_gate_run SET updated_at=? WHERE id=?").run(input.updatedAt, id);
}

describe("repo_trust and merged console contract", () => {
  it("merges repo_trust into rpcConsole and removes rpcConsoleLater", () => {
    expect("rpcConsoleLater" in consoleContracts).toBe(false);
    expect("repo_trust" in consoleContracts.rpcConsole).toBe(true);
    expect(TRUST_WINDOW_DAYS).toBe(30);
    expect(TRUST_HIGH_MAX_ROLLBACKS).toBe(0);
    expect(TRUST_LOW_MIN_ROLLBACKS).toBe(3);
  });

  it("returns high for a passed fresh gate with no rollbacks, low for failed gate, and unknown with no gate rows", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async ({ projectId }: { projectId: string }) => ({
            id: projectId,
            name: projectId,
            sources: [{ hostId: "h1", path: `/srv/${projectId}` }],
          }),
        },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const nowMs = Date.now();

    // 1. Unknown when no gate rows exist for the project.
    const unknownOut = await repoTrust(
      ctx,
      { projectId: "proj-empty" },
      {
        now: () => nowMs,
        probe: async () => ({
          state: "origin",
          root: "/srv/proj-empty",
          origin: "https://github.com/org/empty.git",
          hasCommit: true,
          head: HEAD_A,
        }),
      },
    );
    expect(consoleContracts.rpcConsole.repo_trust.output.safeParse(unknownOut).success).toBe(true);
    expect(unknownOut).toEqual({
      repo: { root: "/srv/proj-empty", remote: "https://github.com/org/empty.git" },
      gate: { state: "none", at: null, fresh: false, reason: null },
      tests: { lastCount: null },
      rollbacks30d: 0,
      acceptedFirstTry30d: null,
      level: "unknown",
      rules: [
        { actionClass: "merge_without_owner", mode: "auto" },
        { actionClass: "migrations", mode: "ask" },
        { actionClass: "deploy", mode: "owner_only" },
      ],
    });

    // 2. High when gate passed, fresh on current HEAD, and 0 rollbacks in 30 days.
    seedGateRow(db, {
      projectId: "proj-green",
      runId: "run-g1",
      state: "passed",
      head: HEAD_A,
      updatedAt: nowMs - 60_000,
    });
    createRun(db, "run-g1", "proj-green", "cli", "/srv/proj-green");
    db.prepare(
      "INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,?,?,?,1,NULL,?,?)",
    ).run("att-1", "run-g1", "T1", "accepted", nowMs - 120_000, nowMs - 120_000);
    db.prepare(
      "INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,?,?,?,1,'err',?,?)",
    ).run("att-2", "run-g1", "T2", "validation_failed", nowMs - 120_000, nowMs - 120_000);
    // An old revert (> 30 days) and a dry_run revert inside 30 days must not count as rollbacks30d.
    appendTaskReceipt(db, {
      at: nowMs - TRUST_WINDOW_MS - 10_000,
      kind: "revert",
      projectId: "proj-green",
      runId: "run-g1",
      taskId: "T0",
      attemptId: "att-1",
      baseSha: HEAD_A,
      changeSha: HEAD_B,
      resultCommit: HEAD_A,
      state: "merged",
      summary: "old revert",
      detail: {},
    });
    appendTaskReceipt(db, {
      at: nowMs - 10_000,
      kind: "revert",
      projectId: "proj-green",
      runId: "run-g1",
      taskId: "T2",
      attemptId: "att-2",
      baseSha: HEAD_A,
      changeSha: HEAD_B,
      resultCommit: null,
      state: "dry_run",
      summary: "dry run only",
      detail: {},
    });

    const highOut = await repoTrust(
      ctx,
      { projectId: "proj-green" },
      {
        now: () => nowMs,
        probe: async () => ({
          state: "origin",
          root: "/srv/proj-green",
          origin: "git@github.com:org/green.git",
          hasCommit: true,
          head: HEAD_A,
        }),
      },
    );
    expect(consoleContracts.rpcConsole.repo_trust.output.safeParse(highOut).success).toBe(true);
    expect(highOut).toMatchObject({
      repo: { root: "/srv/proj-green", remote: "git@github.com:org/green.git" },
      gate: { state: "passed", at: nowMs - 60_000, fresh: true, reason: null },
      tests: { lastCount: null },
      rollbacks30d: 0,
      acceptedFirstTry30d: 0.5,
      level: "high",
    });

    // 3. Low when latest gate failed.
    seedGateRow(db, {
      projectId: "proj-red",
      runId: "run-r1",
      state: "failed",
      head: HEAD_A,
      reason: "vitest exited 1",
      updatedAt: nowMs - 30_000,
    });
    const lowOut = await repoTrust(
      ctx,
      { projectId: "proj-red" },
      {
        now: () => nowMs,
        probe: async () => ({
          state: "localNoOrigin",
          root: "/srv/proj-red",
          hasCommit: true,
          head: HEAD_A,
        }),
      },
    );
    expect(lowOut).toMatchObject({
      repo: { root: "/srv/proj-red", remote: null },
      gate: { state: "failed", fresh: false, reason: "vitest exited 1" },
      level: "low",
    });
  });

  it("handles git probe failures without throwing, logs warn, and computes level without freshness", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async ({ projectId }: { projectId: string }) => ({
            id: projectId,
            name: projectId,
            sources: [{ hostId: "h-offline", path: `/srv/${projectId}` }],
          }),
        },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const warnSpy = vi.spyOn(bb.log, "warn");
    const nowMs = Date.now();

    seedGateRow(db, {
      projectId: "proj-probe-err",
      runId: "run-p1",
      state: "passed",
      head: HEAD_A,
      updatedAt: nowMs - 10_000,
    });

    const outThrown = await repoTrust(
      ctx,
      { projectId: "proj-probe-err" },
      {
        now: () => nowMs,
        probe: async () => {
          throw new Error("host unreachable");
        },
      },
    );
    expect(outThrown.repo).toEqual({ root: null, remote: null });
    expect(outThrown.gate.fresh).toBe(false);
    expect(outThrown.level).toBe("medium");
    expect(warnSpy).toHaveBeenCalledWith("[repo-trust] probe failed project=proj-probe-err: host unreachable");

    warnSpy.mockClear();
    const outUnknown = await repoTrust(
      ctx,
      { projectId: "proj-probe-err" },
      {
        now: () => nowMs,
        probe: async () => ({ state: "unknown", reason: "git missing" }),
      },
    );
    expect(outUnknown.repo).toEqual({ root: null, remote: null });
    expect(outUnknown.gate.fresh).toBe(false);
    expect(outUnknown.level).toBe("medium");
    expect(warnSpy).toHaveBeenCalledWith("[repo-trust] probe failed project=proj-probe-err: git missing");
  });

  it("applies rollback >= 3 threshold, maps quality_mode/adoc.040 rules per section, and wires cards + repo_trust in registerRpc", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async ({ projectId }: { projectId: string }) => ({
            id: projectId,
            name: projectId,
            sources: [{ hostId: "h1", path: `/srv/${projectId}` }],
          }),
        },
        plugins: {
          list: async () => [],
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            if (pluginId === "project-folders" && method === "sections_list") {
              return {
                sections: [
                  {
                    id: "sec-1",
                    projectId: "proj-rules",
                    parentId: null,
                    name: "Web",
                    path: "/srv/proj-rules/web",
                    hostId: "h1",
                    kind: "folder",
                    paths: [{ hostId: "h1", path: "/srv/proj-rules/web" }],
                  },
                ],
              };
            }
            return { sections: [] };
          },
        },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const nowMs = Date.now();

    seedGateRow(db, {
      projectId: "proj-rules",
      runId: "run-1",
      state: "passed",
      head: HEAD_A,
      updatedAt: nowMs - 10_000,
    });
    for (let i = 0; i < 3; i++) {
      appendTaskReceipt(db, {
        at: nowMs - 5_000 - i * 1000,
        kind: "revert",
        projectId: "proj-rules",
        runId: "run-1",
        taskId: `T${i}`,
        attemptId: null,
        baseSha: HEAD_A,
        changeSha: HEAD_B,
        resultCommit: HEAD_A,
        state: "merged",
        summary: `revert ${i}`,
        detail: {},
      });
    }

    // Project defaults: quality_mode=quick, section overrides quality_mode=full and adoc.040=in_place.
    saveProjectSetting(db, "proj-rules", QUALITY_MODE_SETTING, "quick");
    db.prepare(
      `INSERT INTO lane_pilot_project_settings (project_id, binding_id, key, value, version, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run("proj-rules", sectionBindingId("sec-1"), QUALITY_MODE_SETTING, JSON.stringify("full"), nowMs);
    db.prepare(
      `INSERT INTO lane_pilot_project_settings (project_id, binding_id, key, value, version, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run("proj-rules", sectionBindingId("sec-1"), WORKSPACE_MODE_SETTING, JSON.stringify("in_place"), nowMs);

    const projOut = await repoTrustRpc(ctx, {
      now: () => nowMs,
      probe: async () => ({ state: "localNoOrigin", root: "/srv/proj-rules", hasCommit: true, head: HEAD_A }),
    }).repo_trust({ projectId: "proj-rules" });
    expect(projOut.rollbacks30d).toBe(3);
    expect(projOut.level).toBe("low");
    expect(projOut.rules).toEqual([
      { actionClass: "merge_without_owner", mode: "auto" },
      { actionClass: "migrations", mode: "auto" },
      { actionClass: "deploy", mode: "owner_only" },
    ]);

    const secOut = await repoTrustRpc(ctx, {
      now: () => nowMs,
      probe: async (_hostId, folder) => ({
        state: "origin",
        root: folder,
        origin: "https://github.com/org/rules.git",
        hasCommit: true,
        head: HEAD_A,
      }),
    }).repo_trust({ projectId: "proj-rules", sectionId: "sec-1" });
    expect(secOut.repo).toEqual({
      root: "/srv/proj-rules/web",
      remote: "https://github.com/org/rules.git",
    });
    expect(secOut.rules).toEqual([
      { actionClass: "merge_without_owner", mode: "ask" },
      { actionClass: "migrations", mode: "owner_only" },
      { actionClass: "deploy", mode: "owner_only" },
    ]);

    // Verify registerRpc serves both memory_cards_list and repo_trust on the full contract.
    const { rpcContract } = await import("../src/rooms/core/server/plugin-contracts");
    const { bb: hostBb, harness: hostHarness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = async () => {
      await hostHarness.lifecycle.dispose();
      await harness.lifecycle.dispose();
    };
    const hostDb = openDatabase(hostBb);
    const hostCtx = createCore(hostBb, hostDb);
    setCard(hostCtx, {
      projectId: "proj-rules",
      kind: "brand",
      key: "tone",
      content: "Clear and direct",
      source: { kind: "owner", ref: "doc.md" },
      now: nowMs,
    });
    registerRpc(hostCtx, fakeServices(), rpcContract);
    expect(hostHarness.registrations.rpcMethods).toContain("repo_trust");
    expect(hostHarness.registrations.rpcMethods).toContain("memory_cards_list");
    await expect(cardsRpc(hostCtx, { now: () => nowMs }).memory_cards_list({ projectId: "proj-rules" })).resolves.toMatchObject({
      cards: [{ kind: "brand", title: "Clear and direct" }],
    });
    const viaHost = await hostHarness.behavior.callRpc("repo_trust", { projectId: "proj-rules" });
    expect(consoleContracts.rpcConsole.repo_trust.output.safeParse(viaHost).success).toBe(true);
  });
});
