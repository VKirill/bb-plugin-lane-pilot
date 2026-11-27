import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createDraftStore } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { rpcConsole } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { addRoad, getRoad, proposeRoad } from "../src/rooms/lead/server";
import { listOpenOwnerItems, postOwnerItem } from "../src/rooms/owner-waiting";
import { savePushConfig } from "../src/rooms/owner-waiting/server";
import { getProjectArtifact, openDatabase, readLoopModes } from "../src/rooms/plugin-db";
import { deskRpc, deskWeekKey, reviewDeskOwnerItemKey } from "../src/rooms/reports/server";
import { draftSha256, peekAuthority } from "../src/rooms/workflow/server";
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

describe("console owner controls: desk_answer and desk_accept_defaults", () => {
  it("answers a desk item, persists answered state in desk_get, applies same effect as CLI, and handles errors", async () => {
    const { db, ctx, logs } = setupHarness();
    const t0 = Date.parse("2026-11-27T12:00:00Z");
    savePushConfig(db, { timezone: "UTC" }, t0);

    const dir = addRoad(
      db,
      { id: "dir:proj-1", projectId: "proj-1", title: "Directions", kind: "direction", source: "lead", why: "Seed direction" },
      t0 - 10_000,
    );
    const roadCand = addRoad(
      db,
      {
        id: "road_desk_1",
        parentId: dir.id,
        projectId: "proj-1",
        title: "Automate release notes",
        kind: "option",
        source: "lead",
        why: "Repeated 3 times",
        class: "process",
        payload: { key: "cand:release-notes", count: 3 },
      },
      t0 - 5_000,
    );
    proposeRoad(db, roadCand.id, "dec-desk-1", t0 - 4_000);

    const draft = createDraftStore(db, () => t0 - 3_000).create({
      projectId: "proj-1",
      threadId: null,
      scope: "project",
      name: "Weekly digest draft",
      description: "Pending owner publish",
      metadata: { source: "path-capture" },
    });

    const handlers = deskRpc(ctx, { now: () => t0 });

    // Unknown item -> { ok: false, reason: "item_not_found" }
    const missing = await handlers.desk_answer({ itemId: "road:missing", option: "later" });
    expect(() => rpcConsole.desk_answer.output.parse(missing)).not.toThrow();
    expect(missing).toEqual({ ok: false, reason: "item_not_found" });

    // Invalid option -> { ok: false, reason: "invalid_option:..." }
    const badOpt = await handlers.desk_answer({ itemId: "road:road_desk_1", option: "not_an_option" });
    expect(() => rpcConsole.desk_answer.output.parse(badOpt)).not.toThrow();
    expect(badOpt).toMatchObject({ ok: false, reason: expect.stringContaining("invalid_option:") });

    // Answer road item -> updates DB road state and shows answered in desk_get
    const ansRoad = await handlers.desk_answer({ itemId: "road:road_desk_1", option: "later" });
    expect(() => rpcConsole.desk_answer.output.parse(ansRoad)).not.toThrow();
    expect(ansRoad).toMatchObject({
      ok: true,
      item: {
        id: "road:road_desk_1",
        section: "candidates",
        answered: "later",
      },
    });
    expect(getRoad(db, "road_desk_1")?.state).toBe("later");
    expect(logs.some((l) => l.level === "info" && l.message === "[desk] answer item=road:road_desk_1 option=later")).toBe(true);

    // Answer draft item -> creates owner grant (same as CLI) and shows answered in desk_get
    const ansDraft = await handlers.desk_answer({ itemId: `draft:${draft.id}`, option: "publish" });
    expect(() => rpcConsole.desk_answer.output.parse(ansDraft)).not.toThrow();
    expect(ansDraft).toMatchObject({
      ok: true,
      item: { id: `draft:${draft.id}`, answered: "publish" },
    });
    const auth = peekAuthority(db, draft.id, draftSha256(draft.definition));
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.authority.kind).toBe("owner");
      if (auth.authority.kind === "owner") expect(auth.authority.via).toBe("desk");
    }

    const view = await handlers.desk_get({});
    expect(() => rpcConsole.desk_get.output.parse(view)).not.toThrow();
    expect(view.items.find((i) => i.id === "road:road_desk_1")?.answered).toBe("later");
    expect(view.items.find((i) => i.id === `draft:${draft.id}`)?.answered).toBe("publish");
  });

  it("desk_accept_defaults answers all open items with their defaults and closes review-desk owner item", async () => {
    const { db, ctx, logs } = setupHarness();
    const t0 = Date.parse("2026-11-27T12:00:00Z");
    savePushConfig(db, { timezone: "UTC" }, t0);
    const week = deskWeekKey(t0, "UTC");

    const dir = addRoad(
      db,
      { id: "dir:proj-1", projectId: "proj-1", title: "Directions", kind: "direction", source: "lead", why: "Seed direction" },
      t0 - 10_000,
    );
    const cand1 = addRoad(
      db,
      {
        id: "road_open_1",
        parentId: dir.id,
        projectId: "proj-1",
        title: "Open candidate 1",
        kind: "option",
        source: "lead",
        why: "Repeated",
        class: "process",
        payload: { key: "cand:open-1", count: 4 },
      },
      t0 - 5_000,
    );
    const cand2 = addRoad(
      db,
      {
        id: "road_answered_first",
        parentId: dir.id,
        projectId: "proj-1",
        title: "Pre-answered candidate",
        kind: "option",
        source: "lead",
        why: "Repeated",
        class: "branch",
        payload: { key: "cand:pre", count: 2 },
      },
      t0 - 4_500,
    );
    proposeRoad(db, cand1.id, "dec-1", t0 - 4_000);
    proposeRoad(db, cand2.id, "dec-2", t0 - 3_500);

    const draft = createDraftStore(db, () => t0 - 3_000).create({
      projectId: "proj-1",
      threadId: null,
      scope: "project",
      name: "Keep draft by default",
      description: "Draft awaiting owner",
      metadata: { source: "path-capture" },
    });

    postOwnerItem(
      db,
      {
        key: reviewDeskOwnerItemKey(week),
        source: "reports",
        kind: "review_desk",
        reason: "decision",
        wake: false,
        what: `Review desk ${week}`,
        why: "Weekly summary",
        evidence: [],
        actions: [{ id: "accept_defaults", label: "Accept defaults", cli: "bb lane-pilot desk accept-defaults" }],
      },
      t0 - 2_000,
    );

    let loopMode: "on" | "report" | "off" = "on";
    const handlers = deskRpc(ctx, {
      now: () => t0,
      readLoopHealth: () =>
        loopMode === "on"
          ? [{ loop: "branches", mode: "on", metric: 0.1, threshold: 0.3, failing: true, evidence: { reason: "low_accept_rate" } }]
          : [],
    });

    // Answer one item first; it should preserve its explicit answer and not be overwritten by accept-defaults.
    await handlers.desk_answer({ itemId: "road:road_answered_first", option: "reject" });

    // Mismatched week is refused.
    const mismatch = await handlers.desk_accept_defaults({ week: "2026-W01" });
    expect(() => rpcConsole.desk_accept_defaults.output.parse(mismatch)).not.toThrow();
    expect(mismatch).toEqual({ ok: false, accepted: 0 });

    // Accept defaults for current week answers all 3 open items (road_open_1 -> later, draft -> keep draft, loop -> switch to report-only).
    const accepted = await handlers.desk_accept_defaults({ week });
    loopMode = "report";
    expect(() => rpcConsole.desk_accept_defaults.output.parse(accepted)).not.toThrow();
    expect(accepted).toEqual({ ok: true, accepted: 3 });

    expect(getRoad(db, "road_open_1")?.state).toBe("later");
    expect(getRoad(db, "road_answered_first")?.state).toBe("rejected");
    expect(readLoopModes(db, GLOBAL_SETTINGS_PROJECT_ID).branches).toBe("report");
    expect(createDraftStore(db).get(draft.id)?.status).toBe("draft");
    expect(listOpenOwnerItems(db, { key: reviewDeskOwnerItemKey(week) })).toEqual([]);
    expect(logs.some((l) => l.level === "info" && l.message === `[desk] accept-defaults week=${week} n=3`)).toBe(true);

    const after = await handlers.desk_get({ week });
    expect(after.items.find((i) => i.id === "road:road_open_1")?.answered).toBe("later");
    expect(after.items.find((i) => i.id === "road:road_answered_first")?.answered).toBe("reject");
    expect(after.items.find((i) => i.id === `draft:${draft.id}`)?.answered).toBe("keep draft");
    expect(after.items.find((i) => i.id === "loop:branches")?.answered).toBe("switch to report-only");
    expect(after.items.every((i) => i.answered !== null)).toBe(true);
  });

  it("registers desk_answer and desk_accept_defaults in plugin rpcContract", async () => {
    const { bb, harness, db } = setupHarness();
    await plugin(bb);
    const dir = addRoad(
      db,
      { id: "dir:proj-rpc", projectId: "proj-rpc", title: "Directions", kind: "direction", source: "lead", why: "Seed" },
      Date.now() - 10_000,
    );
    const cand = addRoad(
      db,
      {
        id: "road_rpc_1",
        parentId: dir.id,
        projectId: "proj-rpc",
        title: "Candidate via RPC",
        kind: "option",
        source: "lead",
        why: "Repeated",
        class: "process",
      },
      Date.now() - 5_000,
    );
    proposeRoad(db, cand.id, "dec-rpc-1", Date.now() - 4_000);

    const ans = await harness.behavior.callRpc("desk_answer", { itemId: "road:road_rpc_1", option: "save" });
    expect(() => rpcConsole.desk_answer.output.parse(ans)).not.toThrow();
    expect(ans).toMatchObject({ ok: true, item: { id: "road:road_rpc_1", answered: "save as draft" } });
    expect(getRoad(db, "road_rpc_1")?.state).toBe("accepted");

    const view = await harness.behavior.callRpc("desk_get", {}) as { week: string; items: Array<{ id: string; answered: string | null }> };
    expect(view.items.find((i) => i.id === "road:road_rpc_1")?.answered).toBe("save as draft");
    const createdDraftItem = view.items.find((i) => i.id.startsWith("draft:") && i.answered === null);
    expect(createdDraftItem).toBeDefined();

    const defaults = await harness.behavior.callRpc("desk_accept_defaults", { week: view.week });
    expect(() => rpcConsole.desk_accept_defaults.output.parse(defaults)).not.toThrow();
    expect(defaults).toEqual({ ok: true, accepted: 1 });

    const afterDefaults = await harness.behavior.callRpc("desk_get", { week: view.week }) as {
      week: string;
      items: Array<{ id: string; answered: string | null }>;
    };
    expect(afterDefaults.items.find((i) => i.id === createdDraftItem!.id)?.answered).toBe("keep draft");
  });
});
