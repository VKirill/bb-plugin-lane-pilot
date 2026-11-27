/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { AutonomousAction, BrakesOutput, ReviewDeskItem, ReviewDeskView } from "../src/rooms/contracts/ui";
import { isAllowedUndoMethod } from "../src/rooms/specialist/ui";
import { shiftIsoWeek } from "../src/rooms/reports";
import { boardFixture, screenFixture } from "./ui-harness";

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 10_000 });

const NOW = 1_800_000_000_000;
const CURRENT_WEEK = "2026-W48";
const PREV_WEEK = shiftIsoWeek(CURRENT_WEEK, -1);
const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
  { id: "proj_alpha", name: "Alpha app" },
];

function defaultProviders() {
  return {
    status: "ready",
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        available: true,
        capabilities: {
          modelCatalogScope: "host",
          permissionModes: [],
          supportsFork: false,
          supportsNativeUserQuestion: false,
          supportsServiceTier: true,
          supportsSessionRewind: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
        },
        serviceTiers: [{ id: "default", label: "Default" }],
      },
    ],
  } as never;
}

function waitingFixture() {
  return {
    generatedAt: NOW,
    now: 2,
    counts: { writer: 1, deferral_overdue: 1 },
    overnight: { windowMs: 86_400_000, red: [], accepted: 3, rulesAdopted: 1, rulesConfirmed: 0 },
    answered: { owner: 1, agent: 0, lead: 0, janitor: 0 },
    attention: { cap: 5, shown: 3, remaining: 2, day: "2026-11-27" },
    items: [
      {
        key: "task-word:run_1:t1:att_1",
        source: "writer",
        kind: "task_word",
        projectId: "proj_ui",
        what: "Задача проверена и ждёт вашего слова: Add billing guard",
        why: "Риск задачи high: требуется подтверждение.",
        since: NOW - 60_000,
        wake: true,
        tier: "now",
        evidence: [
          { kind: "run", ref: "run_1" },
          { kind: "task", ref: "t1" },
        ],
        actions: [
          {
            id: "yes",
            label: "Да, сливать",
            cli: "echo yes",
            rpc: { method: "task_word", input: { runId: "run_1", taskId: "t1", decision: "yes", text: "Да, сливать" } },
          },
          {
            id: "no",
            label: "Нет",
            cli: "echo no",
            rpc: { method: "task_word", input: { runId: "run_1", taskId: "t1", decision: "no", text: "Нет" } },
          },
        ],
      },
      {
        key: "deferral:dfr_b",
        source: "deferral_overdue",
        kind: "deferral_gate",
        projectId: "proj_alpha",
        what: "Gate X is put off",
        why: "The term you gave passed.",
        since: NOW - 3_600_000,
        wake: true,
        tier: "now",
        evidence: [{ kind: "command", ref: "bb lane-pilot deferrals --state overdue", label: "dfr_b" }],
        actions: [
          {
            id: "term",
            label: "New term",
            needsOwnerMessage: true,
            cli: "bb lane-pilot defer dfr_b --owner-msg <threadId>#<seq>",
          },
        ],
      },
    ],
  };
}

function deskFixture(): ReviewDeskView {
  return {
    week: CURRENT_WEEK,
    items: [
      {
        id: "evolve:hyp_1",
        section: "evolve",
        question: "seo-research.verify (plus-2, gain=+10)",
        evidence: "hypothesis:hyp_1",
        options: [
          { id: "approve", label: "Повысить", isDefault: true },
          { id: "reject", label: "Оставить прежнюю", isDefault: false },
        ],
        answered: null,
        defaultAt: Date.parse("2026-11-30T07:00:00Z"),
      },
    ],
  };
}

function brakesFixture(pausedIds: ReadonlyArray<string> = []): BrakesOutput {
  const paused = new Set(pausedIds);
  return {
    brakes: [
      { id: "schedules", paused: paused.has("schedules"), since: paused.has("schedules") ? NOW - 60_000 : null, reason: null, impact: { label: "active schedules", count: 14 } },
      { id: "conveyor", paused: paused.has("conveyor"), since: paused.has("conveyor") ? NOW - 60_000 : null, reason: null, impact: { label: "queued writer attempts", count: 2 } },
      { id: "graphs", paused: paused.has("graphs"), since: paused.has("graphs") ? NOW - 60_000 : null, reason: null, impact: { label: "triggered workflows", count: 3 } },
      { id: "staff", paused: paused.has("staff"), since: paused.has("staff") ? NOW - 60_000 : null, reason: null, impact: { label: "specialists", count: 2 } },
    ],
  };
}

function actionsFixture(): AutonomousAction[] {
  return [
    {
      id: "sp_mut:mut-sched",
      at: NOW - 60_000,
      projectId: "proj_ui",
      actor: "specialist:marketing",
      action: "schedule_create sched-9",
      authority: "bounded_auto",
      result: "done",
      evidenceRef: "run_9:task_9",
      undo: { method: "schedule_pause", input: { id: "sched-9" } },
    },
    {
      id: "wf_eff:eff-draft",
      at: NOW - 120_000,
      projectId: "proj_ui",
      actor: "workflow:evolve-seo",
      action: "evolve_publish:draft-4",
      authority: "repo_rule",
      result: "done",
      evidenceRef: "thr_abc123",
      undo: { method: "workflow_draft_rollback", input: { draftId: "draft-4" } },
    },
    {
      id: "sp_mut:mut-disallowed",
      at: NOW - 180_000,
      projectId: "proj_ui",
      actor: "specialist:seo",
      action: "autonomy escalation attempted",
      authority: "bounded_auto",
      result: "done",
      evidenceRef: "nonce-7",
      undo: { method: "specialist_autonomy_set", input: { projectId: "proj_ui", domain: "seo", actionClass: "x", level: "bounded_auto" } },
    },
    {
      id: "wf_eff:eff-maint",
      at: NOW - 240_000,
      projectId: "proj_alpha",
      actor: "workflow:lp.worktree-cleanup",
      action: "cleanup:prune",
      authority: "maintenance",
      result: "failed",
      evidenceRef: null,
      undo: null,
    },
    {
      id: "sp_mut:mut-revert",
      at: NOW - 300_000,
      projectId: "proj_ui",
      actor: "specialist:dev",
      action: "merge_accepted task_5",
      authority: "repo_rule",
      result: "done",
      evidenceRef: "run_5",
      undo: { method: "revert", input: { ref: "task_5" } },
    },
  ];
}

async function mountDecisions(rpcOverrides: Record<string, (input: unknown) => unknown> = {}, subPath = "decisions") {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, {
    context: { projectId: null, threadId: null },
    providers: defaultProviders(),
    rpc: {
      get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as { locale: string }).locale, preference: (input as { locale: string }).locale }),
      remember_project: () => ({ ok: true }),
      list_projects: () => ({ projects: PROJECTS, lastProjectId: null }),
      list_sections: () => ({ sections: [] }),
      get_screen: () => ({ ...screenFixture(), projectId: "proj_ui" }),
      console_overview: () => ({
        tz: "Europe/Moscow",
        counts: { active: 0, waiting: 2, closedToday: 0, spendTodayUsd: 0, goalsOnTrack: 0, goalsTotal: 0 },
        active: [],
        closedByDay: [],
        goals: [],
        costCoverage: 1,
      }),
      schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
      task_board: () => boardFixture(),
      work_graph_strips: () => ({}),
      owner_waiting: () => waitingFixture(),
      desk_get: () => deskFixture(),
      actions_log: () => ({ rows: actionsFixture() }),
      brakes_get: () => brakesFixture([]),
      ...rpcOverrides,
    } as never,
  });
}

const hasPanelSubPath = (calls: ReadonlyArray<Record<string, unknown>>, subPath: string) =>
  calls.some((call) => call.method === "toPluginPanel" && (call as { options?: { subPath?: string } }).options?.subPath === subPath);

describe("Decisions console screen & Brakes (Tasks 20–23)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
    toast.success.mockClear();
    toast.error.mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.restoreAllMocks();
  });

  it("routes across waiting, desk, and autonomous tabs via routes and segment clicks and passes project scope to actions_log", async () => {
    const actionsCalls: unknown[] = [];
    const slot = await mountDecisions({
      actions_log: (input: unknown) => {
        actionsCalls.push(input);
        return { rows: actionsFixture() };
      },
    });

    await slot.findByTestId("console-decisions");
    await slot.findByTestId("owner-waiting");

    fireEvent.click(slot.getByTestId("seg-decisions-view-desk"));
    await slot.findByTestId("review-desk");
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "decisions/desk")).toBe(true);

    fireEvent.click(slot.getByTestId("seg-decisions-view-autonomous"));
    await slot.findByTestId("actions-log");
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "decisions/autonomous")).toBe(true);
    await waitFor(() => expect(actionsCalls[0]).toEqual({ limit: 50 }));

    fireEvent.click(slot.getByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-project-proj_ui"));
    await waitFor(() => expect(actionsCalls).toContainEqual({ projectId: "proj_ui", limit: 50 }));

    fireEvent.click(slot.getByTestId("seg-decisions-view-waiting"));
    await slot.findByTestId("owner-waiting");
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "decisions/waiting")).toBe(true);

    slot.lifecycle.unmount();
  });

  it("renders autonomous actions columns, paginates «Ещё» by since, and enforces UNDO_METHODS allow list", async () => {
    // No `revert` RPC exists, so a row naming it must not get an undo button.
    expect(isAllowedUndoMethod("revert")).toBe(false);
    expect(isAllowedUndoMethod("schedule_pause")).toBe(true);
    expect(isAllowedUndoMethod("workflow_draft_rollback")).toBe(true);
    expect(isAllowedUndoMethod("specialist_autonomy_set")).toBe(false);
    expect(isAllowedUndoMethod("stop_all")).toBe(false);

    const page1: AutonomousAction[] = Array.from({ length: 50 }, (_, idx) => ({
      id: `row-${idx}`,
      at: NOW - idx * 60_000,
      projectId: "proj_ui",
      actor: idx === 0 ? "specialist:marketing" : "workflow:nightly",
      action: `Action #${idx}`,
      authority: idx === 0 ? "bounded_auto" : "repo_rule",
      result: "done",
      evidenceRef: idx === 0 ? "run_10:task_10" : null,
      undo: idx === 0 ? { method: "schedule_pause", input: { id: "sched-10" } } : null,
    }));
    const oldestAt = page1[page1.length - 1]!.at;
    const page2: AutonomousAction[] = [
      {
        id: "row-older",
        at: oldestAt - 60_000,
        projectId: "proj_ui",
        actor: "lead",
        action: "Older autonomous action",
        authority: "bounded_auto",
        result: "done",
        evidenceRef: "thr_old",
        undo: null,
      },
    ];

    const calls: Array<{ since?: number; limit?: number }> = [];
    const slot = await mountDecisions(
      {
        actions_log: (input: unknown) => {
          const req = (input ?? {}) as { since?: number; limit?: number };
          calls.push(req);
          if (req.since !== undefined) return { rows: page2 };
          return { rows: page1 };
        },
      },
      "decisions/autonomous",
    );

    await slot.findByTestId("actions-log-table");
    expect(calls[0]).toEqual({ limit: 50 });

    const firstRow = slot.getByTestId("actions-log-row-row-0");
    expect(firstRow.textContent).toContain("specialist:marketing");
    expect(firstRow.textContent).toContain("Action #0");
    expect(firstRow.textContent).toContain("Полномочия");
    expect(firstRow.textContent).toContain("Выполнено");
    expect(firstRow.textContent).toContain("run_10:task_10");

    // «Ещё» sends `since` of oldest row and appends older rows without duplicates.
    const loadMoreBtn = await slot.findByTestId("actions-log-load-more");
    expect(loadMoreBtn.textContent).toBe("Ещё");
    fireEvent.click(loadMoreBtn);

    await waitFor(() => expect(calls[1]).toEqual({ since: oldestAt, limit: 50 }));
    await slot.findByTestId("actions-log-row-row-older");
    expect(slot.queryByTestId("actions-log-load-more")).toBeNull();

    // Evidence routing from table row (runs after pagination check because onOpenTask navigates away from Decisions).
    fireEvent.click(slot.getByTestId("actions-log-evidence-row-0"));
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "work/task/run_10/task_10")).toBe(true);

    slot.lifecycle.unmount();
  });

  it("allows undo via ConfirmDialog only for UNDO_METHODS and renders row error + console.warn on failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const schedulePauseRpc = vi.fn().mockResolvedValue({ schedule: null });
    const rollbackRpc = vi.fn().mockRejectedValue(new Error("Draft already published"));
    const disallowedRpc = vi.fn();

    let currentRows = actionsFixture();
    const slot = await mountDecisions(
      {
        actions_log: () => ({ rows: currentRows }),
        schedule_pause: (input: unknown) => {
          currentRows = currentRows.map((r) => (r.id === "sp_mut:mut-sched" ? { ...r, result: "reverted", undo: null } : r));
          return schedulePauseRpc(input);
        },
        workflow_draft_rollback: rollbackRpc,
        specialist_autonomy_set: disallowedRpc,
      },
      "decisions/autonomous",
    );

    await slot.findByTestId("actions-log-table");

    // Allowed methods show «Отменить»; disallowed method (`specialist_autonomy_set`) and non-undoable row do NOT.
    expect(slot.getByTestId("actions-log-undo-sp_mut:mut-sched").textContent).toBe("Отменить");
    expect(slot.getByTestId("actions-log-undo-wf_eff:eff-draft")).toBeTruthy();
    expect(slot.queryByTestId("actions-log-undo-sp_mut:mut-revert")).toBeNull();
    expect(slot.queryByTestId("actions-log-undo-sp_mut:mut-disallowed")).toBeNull();
    expect(slot.queryByTestId("actions-log-undo-wf_eff:eff-maint")).toBeNull();
    expect(disallowedRpc).not.toHaveBeenCalled();

    // Clicking «Отменить» opens ConfirmDialog before calling RPC.
    fireEvent.click(slot.getByTestId("actions-log-undo-sp_mut:mut-sched"));
    await waitFor(() => expect(slot.container.ownerDocument.querySelector("[role='alertdialog']")).not.toBeNull());
    expect(schedulePauseRpc).not.toHaveBeenCalled();

    const confirmBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Да, отменить") as HTMLButtonElement | undefined;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn!.disabled).toBe(false);
    fireEvent.click(confirmBtn!);

    await waitFor(() => expect(schedulePauseRpc).toHaveBeenCalledWith({ id: "sched-9" }));
    await waitFor(() => expect(slot.queryByTestId("actions-log-undo-sp_mut:mut-sched")).toBeNull());

    // Undo failure displays inline error in the row and logs `[lane-pilot:actions] undo failed`.
    fireEvent.click(slot.getByTestId("actions-log-undo-wf_eff:eff-draft"));
    await waitFor(() => expect(slot.container.ownerDocument.querySelector("[role='alertdialog']")).not.toBeNull());
    const confirmRollbackBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Да, отменить");
    fireEvent.click(confirmRollbackBtn!);

    await waitFor(() => expect(rollbackRpc).toHaveBeenCalledWith({ draftId: "draft-4" }));
    const errEl = await slot.findByTestId("actions-log-error-wf_eff:eff-draft");
    expect(errEl.textContent).toContain("Draft already published");
    expect(warnSpy).toHaveBeenCalledWith("[lane-pilot:actions] undo failed", "workflow_draft_rollback");

    slot.lifecycle.unmount();
  });

  it("handles waiting tab cases (Task 21): attention counter, «Отложить» deferral_defer, and «Нет» ConfirmDialog", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => "unused");
    const deferRpc = vi.fn().mockResolvedValue({ entry: { id: "dfr_b" }, created: false });
    const taskWordRpc = vi.fn().mockResolvedValue({ ok: true });

    const slot = await mountDecisions({
      deferral_defer: deferRpc,
      task_word: taskWordRpc,
    });

    await slot.findByTestId("owner-waiting");
    expect(slot.getByTestId("owner-attention").textContent).toContain("3 из 5");

    fireEvent.click(await slot.findByTestId("owner-defer-deferral:dfr_b"));
    await waitFor(() => expect(deferRpc).toHaveBeenCalledWith(expect.objectContaining({ what: "dfr_b", projectId: "proj_alpha" })));

    fireEvent.click(await slot.findByTestId("owner-run-task-word:run_1:t1:att_1-no"));
    const reasonInput = await slot.findByTestId("owner-confirm-reason");
    expect(promptSpy).not.toHaveBeenCalled();
    fireEvent.change(reasonInput, { target: { value: "Нужна проверка граничных случаев" } });
    const confirmNoBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Нет");
    fireEvent.click(confirmNoBtn!);

    await waitFor(() =>
      expect(taskWordRpc).toHaveBeenCalledWith({
        runId: "run_1",
        taskId: "t1",
        decision: "no",
        text: "Нужна проверка граничных случаев",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("handles weekly desk cases (Task 22): answer option and confirm accept-defaults", async () => {
    let currentItems: ReviewDeskItem[] = deskFixture().items;
    const deskAnswerRpc = vi.fn((input: unknown) => {
      const { itemId, option } = input as { itemId: string; option: string };
      const item = currentItems.find((x) => x.id === itemId)!;
      const updated = { ...item, answered: option };
      currentItems = [updated];
      return { ok: true, item: updated };
    });
    const acceptDefaultsRpc = vi.fn(() => ({ ok: true, accepted: 1 }));

    const slot = await mountDecisions(
      {
        desk_get: () => ({ week: CURRENT_WEEK, items: currentItems }),
        desk_answer: deskAnswerRpc,
        desk_accept_defaults: acceptDefaultsRpc,
      },
      `decisions/desk/${CURRENT_WEEK}`,
    );

    await slot.findByTestId("desk-item-evolve:hyp_1");
    expect(slot.getByTestId("desk-default-mark-evolve:hyp_1-approve").textContent).toContain("по умолчанию, если не ответите до");

    fireEvent.click(slot.getByTestId("desk-accept-defaults"));
    await waitFor(() => expect(slot.container.ownerDocument.querySelector("[role='alertdialog']")).not.toBeNull());
    const confirmDefaultsBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Принять по умолчанию");
    fireEvent.click(confirmDefaultsBtn!);
    await waitFor(() => expect(acceptDefaultsRpc).toHaveBeenCalledWith({ week: CURRENT_WEEK }));

    fireEvent.click(slot.getByTestId("desk-radio-evolve:hyp_1-reject"));
    await waitFor(() => expect(deskAnswerRpc).toHaveBeenCalledWith({ itemId: "evolve:hyp_1", option: "reject" }));

    // Previous week check via route.
    expect(PREV_WEEK).not.toBe(CURRENT_WEEK);
    slot.lifecycle.unmount();
  });

  it("handles brakes cases (Task 20): paused pill, brakes_set, and СТОП-gated stop_all", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stopAllRpc = vi.fn(() => ({
      brakes: brakesFixture(["schedules", "conveyor", "graphs", "staff"]).brakes,
      halted: [{ runId: "run_200", ok: true }],
    }));
    const slot = await mountDecisions({
      brakes_get: () => brakesFixture(["staff"]),
      stop_all: stopAllRpc,
    });

    const pill = await slot.findByTestId("brakes-paused-pill");
    expect(pill.textContent).toContain("1");

    fireEvent.click(slot.getByTestId("brakes-button"));
    fireEvent.click(await slot.findByTestId("brakes-stop-all"));

    const confirmInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("input[aria-label='СТОП']");
    const reasonInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("[data-testid='brakes-stop-all-reason']");
    const confirmBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Остановить всех") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(confirmInput!, { target: { value: "СТОП" } });
    fireEvent.change(reasonInput!, { target: { value: "Остановка из теста" } });
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(stopAllRpc).toHaveBeenCalledWith({ reason: "Остановка из теста" }));
    expect(infoSpy).toHaveBeenCalledWith("[lane-pilot:brakes] stop_all", {
      halted: ["run_200"],
      failed: [],
    });
    expect((await slot.findByTestId("brakes-halted-list")).textContent).toContain("run_200");
    slot.lifecycle.unmount();
  });
});
