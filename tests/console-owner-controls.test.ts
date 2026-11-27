import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { rpcConsole } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { listOpenOwnerItems } from "../src/rooms/owner-waiting";
import { getProjectArtifact, openDatabase } from "../src/rooms/plugin-db";
import {
  approveCharter,
  charterDraftKey,
  getCharter,
  grantAutonomy,
  proposeCharter,
  room as specialistRoom,
  setSpecialistAutonomy,
  specialistDetail,
  upsertCharter,
} from "../src/rooms/specialist/server";
import { coreFileWrite, diskStore } from "./helpers/core-files";

let cleanup: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function setupHarness(withCheckout = false) {
  const dir = withCheckout ? mkdtempSync(join(tmpdir(), "lp-owner-ctrl-")) : null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    ...(dir
      ? {
          sdk: {
            projects: {
              get: async () => ({ id: "proj-1", name: "Proj 1", sources: [{ hostId: "local", path: dir }] }) as never,
            },
            files: {
              read: async (args: unknown) => {
                const input = args as { path: string };
                if (!existsSync(input.path)) {
                  throw Object.assign(new Error(`ENOENT: no such file ${input.path}`), { code: "ENOENT" });
                }
                const content = readFileSync(input.path, "utf8");
                return { content, contentEncoding: "utf8", sha256: "", sizeBytes: Buffer.byteLength(content) } as never;
              },
              write: coreFileWrite(diskStore()) as never,
            },
          },
        }
      : {}),
  });
  const logs: Array<{ level: string; message: string }> = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const orig = bb.log[level]?.bind(bb.log);
    bb.log[level] = (message: string) => {
      logs.push({ level, message: String(message) });
      orig?.(message);
    };
  }
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  cleanup = async () => {
    await harness.lifecycle.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
  return { bb, harness, db, ctx, logs, dir };
}

describe("console owner controls: specialist_autonomy_set", () => {
  it("lowers via revokeAutonomy, refuses raising when frozen or below promotion gates, and grants when eligible", async () => {
    const { bb, db, ctx, logs } = setupHarness();
    const t0 = Date.parse("2026-11-27T12:00:00Z");

    // Seed an active bounded_auto row that meets gates.
    grantAutonomy(db, {
      projectId: "proj-1",
      domain: "seo",
      actionClass: "sub_graph:seo_refresh",
      by: "owner",
      now: t0 - 10_000,
    });
    db.prepare(
      `UPDATE lane_pilot_sp_autonomy
       SET samples_n = 25, successes_k = 23, wilson_lb = 0.84
       WHERE project_id = ? AND domain = ? AND action_class = ?`,
    ).run("proj-1", "seo", "sub_graph:seo_refresh");

    // 1. Lowering bounded_auto -> propose calls revokeAutonomy (sets frozen_until) and logs.
    const lowered = setSpecialistAutonomy(
      { db, now: () => t0, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "sub_graph:seo_refresh", level: "propose", reason: "pause_auto" },
    );
    expect(() => rpcConsole.specialist_autonomy_set.output.parse(lowered)).not.toThrow();
    expect(lowered).toMatchObject({
      ok: true,
      autonomy: [
        {
          actionClass: "sub_graph:seo_refresh",
          level: "propose",
          sample: 25,
          confidence: 0.84,
          frozen: true,
        },
      ],
    });
    expect(
      logs.some((l) => l.level === "info" && l.message === "[specialist] autonomy project=proj-1 domain=seo class=sub_graph:seo_refresh level=propose"),
    ).toBe(true);

    // 2. Raising a frozen class back to bounded_auto is refused.
    const refusedFrozen = setSpecialistAutonomy(
      { db, now: () => t0 + 1000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "sub_graph:seo_refresh", level: "bounded_auto" },
    );
    expect(() => rpcConsole.specialist_autonomy_set.output.parse(refusedFrozen)).not.toThrow();
    expect(refusedFrozen).toEqual({ ok: false, reason: "frozen" });

    // 3. Lowering propose -> observe sets observe; raising observe -> propose while frozen is refused.
    const toObserve = setSpecialistAutonomy(
      { db, now: () => t0 + 2000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "sub_graph:seo_refresh", level: "observe", reason: "watch_only" },
    );
    expect(toObserve).toMatchObject({
      ok: true,
      autonomy: [{ actionClass: "sub_graph:seo_refresh", level: "observe", frozen: true }],
    });
    const raiseFromObserveWhileFrozen = setSpecialistAutonomy(
      { db, now: () => t0 + 3000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "sub_graph:seo_refresh", level: "propose" },
    );
    expect(raiseFromObserveWhileFrozen).toEqual({ ok: false, reason: "frozen" });

    // 4. Raising a non-frozen class with insufficient samples/confidence is refused by grantAutonomy gate.
    db.prepare(
      `INSERT INTO lane_pilot_sp_autonomy
        (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, frozen_until, updated_at)
       VALUES ('proj-1', 'seo', 'code_task:title_fix', 'propose', 5, 5, 0.56, 0.9, 0, NULL, ?)`,
    ).run(t0);
    const lowSamples = setSpecialistAutonomy(
      { db, now: () => t0 + 4000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "code_task:title_fix", level: "bounded_auto" },
    );
    expect(lowSamples).toEqual({ ok: false, reason: "insufficient_samples" });

    db.prepare(
      `UPDATE lane_pilot_sp_autonomy SET samples_n = 25, successes_k = 18, wilson_lb = 0.52
       WHERE project_id = 'proj-1' AND domain = 'seo' AND action_class = 'code_task:title_fix'`,
    ).run();
    const lowConf = setSpecialistAutonomy(
      { db, now: () => t0 + 5000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "code_task:title_fix", level: "bounded_auto" },
    );
    expect(lowConf).toEqual({ ok: false, reason: "insufficient_confidence" });

    // 5. High-risk class is always refused.
    const highRisk = setSpecialistAutonomy(
      { db, now: () => t0 + 6000, log: { info: (m) => bb.log.info(m), warn: (m) => ctx.log(m) } },
      { projectId: "proj-1", domain: "seo", actionClass: "direct_api:robots_txt_edit", level: "bounded_auto" },
    );
    expect(highRisk).toEqual({ ok: false, reason: "high_risk_never_auto" });

    // 6. Meeting samples & confidence gates grants bounded_auto via room RPC.
    db.prepare(
      `UPDATE lane_pilot_sp_autonomy SET samples_n = 25, successes_k = 24, wilson_lb = 0.85
       WHERE project_id = 'proj-1' AND domain = 'seo' AND action_class = 'code_task:title_fix'`,
    ).run();
    const rpc = specialistRoom.rpc!(ctx, {}) as {
      specialist_autonomy_set: (input: {
        projectId: string;
        domain: string;
        actionClass: string;
        level: "observe" | "propose" | "bounded_auto";
        reason?: string;
      }) => Promise<unknown>;
    };
    const granted = await rpc.specialist_autonomy_set({
      projectId: "proj-1",
      domain: "seo",
      actionClass: "code_task:title_fix",
      level: "bounded_auto",
      reason: "gate_met",
    });
    expect(() => rpcConsole.specialist_autonomy_set.output.parse(granted)).not.toThrow();
    expect(granted).toMatchObject({
      ok: true,
      autonomy: expect.arrayContaining([
        {
          actionClass: "code_task:title_fix",
          level: "bounded_auto",
          sample: 25,
          confidence: 0.85,
          frozen: false,
        },
      ]),
    });
    expect(
      logs.some((l) => l.level === "info" && l.message === "[specialist] autonomy project=proj-1 domain=seo class=code_task:title_fix level=bounded_auto"),
    ).toBe(true);
  });
});

describe("console owner controls: charter_propose and charter_approve", () => {
  it("proposes a draft without changing charter, approves to bump version and write checkout/artifact, and rejects double-approve", async () => {
    const { bb, db, ctx, logs, dir } = setupHarness(true);
    const rpc = specialistRoom.rpc!(ctx, {}) as {
      charter_propose: (input: { projectId: string; domain: string; charter: Record<string, unknown> }) => Promise<{ draftId: string }>;
      charter_approve: (input: { projectId: string; domain: string; draftId: string }) => Promise<{ ok: boolean; version?: number; reason?: string }>;
    };

    // Seed v1 charter.
    upsertCharter(db, {
      projectId: "proj-1",
      domain: "seo",
      approvedBy: "owner",
      charter: {
        north_star: { metric_id: "organic_clicks", target: 1000 },
        budgets: { daily_cap_usd: 25 },
      },
    });

    // 1. Propose v2 draft: stores KV draft & posts owner item with diff; v1 charter is untouched.
    const proposedCharter = {
      north_star: { metric_id: "organic_clicks", target: 2000 },
      budgets: { daily_cap_usd: 40 },
    };
    const proposed = await rpc.charter_propose({
      projectId: "proj-1",
      domain: "seo",
      charter: proposedCharter,
    });
    expect(() => rpcConsole.charter_propose.output.parse(proposed)).not.toThrow();
    expect(proposed.draftId).toMatch(/^draft_/);

    expect(getCharter(db, "proj-1", "seo")?.version).toBe(1);
    expect(getProjectArtifact(db, "proj-1", "seo.charter")).toBeNull();

    const storedDraft = await bb.storage.kv.get(charterDraftKey("proj-1", "seo"));
    expect(storedDraft).toMatchObject({ draftId: proposed.draftId, body: proposedCharter });

    const detailBefore = await specialistDetail({ db, kv: bb.storage.kv }, { projectId: "proj-1", domain: "seo" });
    expect(detailBefore.charter?.version).toBe(1);
    expect(detailBefore.charter?.pendingDraft).toEqual({
      draftId: proposed.draftId,
      body: proposedCharter,
    });

    const openItems = listOpenOwnerItems(db, { projectId: "proj-1", source: "specialist", kind: "charter_proposal" });
    expect(openItems).toHaveLength(1);
    expect(openItems[0]?.why).toContain("budgets");
    expect(openItems[0]?.why).toContain("north_star");

    // 2. Approve draft: bumps version to 2, writes file + artifact, closes owner item, deletes draft, logs info.
    const approved = await rpc.charter_approve({
      projectId: "proj-1",
      domain: "seo",
      draftId: proposed.draftId,
    });
    expect(() => rpcConsole.charter_approve.output.parse(approved)).not.toThrow();
    expect(approved).toEqual({ ok: true, version: 2 });

    const charterRow = getCharter(db, "proj-1", "seo");
    expect(charterRow?.version).toBe(2);
    expect(charterRow?.approved_by).toBe("owner");

    const diskContent = readFileSync(join(dir!, ".agents/seo/charter.json"), "utf8");
    const diskSha = createHash("sha256").update(diskContent).digest("hex");
    expect(JSON.parse(diskContent)).toMatchObject({ ...proposedCharter, _version: 2 });
    const artifact = getProjectArtifact(db, "proj-1", "seo.charter");
    expect(artifact?.sha256).toBe(diskSha);
    expect(artifact?.summary).toBe("seo charter v2");

    expect(listOpenOwnerItems(db, { projectId: "proj-1", source: "specialist", kind: "charter_proposal" })).toEqual([]);
    expect(await bb.storage.kv.get(charterDraftKey("proj-1", "seo"))).toBeUndefined();
    expect(
      logs.some((l) => l.level === "info" && l.message === "[specialist] charter approved project=proj-1 domain=seo v=2"),
    ).toBe(true);

    // 3. Approving the same draft a second time returns draft_not_found.
    const secondApprove = await rpc.charter_approve({
      projectId: "proj-1",
      domain: "seo",
      draftId: proposed.draftId,
    });
    expect(() => rpcConsole.charter_approve.output.parse(secondApprove)).not.toThrow();
    expect(secondApprove).toEqual({ ok: false, reason: "draft_not_found" });
  });

  it("returns draft_not_found when draft is missing or draftId mismatches", async () => {
    const { ctx } = setupHarness();
    await proposeCharter(ctx, { projectId: "proj-1", domain: "marketing", charter: { goal: "leads" } });

    const mismatch = await approveCharter(ctx, { projectId: "proj-1", domain: "marketing", draftId: "draft_wrong" });
    expect(mismatch).toEqual({ ok: false, reason: "draft_not_found" });

    const missing = await approveCharter(ctx, { projectId: "proj-1", domain: "specialist_os", draftId: "draft_none" });
    expect(missing).toEqual({ ok: false, reason: "draft_not_found" });
  });
});
