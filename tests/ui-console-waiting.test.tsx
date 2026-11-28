/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 10_000 });

const NOW = 1_800_000_000_000;
const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
  { id: "proj_alpha", name: "Alpha app" },
];

function waitingFixture(extra: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW,
    now: 3,
    counts: { writer: 2, deferral_overdue: 1, schedule: 1 },
    overnight: { windowMs: 86_400_000, red: [], accepted: 2, rulesAdopted: 0, rulesConfirmed: 0 },
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
          { kind: "file", ref: "src/billing/guard.ts" },
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
            rpc: { method: "task_word", input: { runId: "run_1", taskId: "t1", decision: "no", text: "Нет, не сливать" } },
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
      {
        key: "run-budget:run_2",
        source: "writer",
        kind: "budget_spent",
        projectId: "proj_ui",
        what: "Лимит прогона исчерпан",
        why: "Остались незаконченные задачи.",
        since: NOW - 120_000,
        wake: true,
        tier: "now",
        evidence: [{ kind: "run", ref: "run_2" }, { kind: "task", ref: "t2" }],
        actions: [
          {
            id: "finish",
            label: "Завершить прогон",
            cli: "echo finish",
            rpc: { method: "finish_run", input: { projectId: "proj_ui", runId: "run_2" } },
          },
        ],
      },
      {
        key: "sch:fail:1",
        source: "schedule",
        kind: "schedule_failed",
        projectId: "proj_alpha",
        what: "Расписание «Daily» не сработало",
        why: "Timeout",
        since: NOW - 180_000,
        wake: false,
        tier: "later",
        evidence: [{ kind: "text", ref: "schrun_1" }],
        actions: [
          {
            id: "pause",
            label: "Поставить на паузу",
            cli: "echo pause",
            rpc: { method: "schedule_pause", input: { id: "sch_1", reason: "остановлено владельцем" } },
          },
        ],
      },
    ],
    ...extra,
  };
}

function defaultProviders() {
  return {
    status: "ready",
    providers: [{
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
    }],
  } as never;
}

async function mountDecisions(rpcOverrides: Record<string, (input: unknown) => unknown> = {}, subPath = "decisions/waiting") {
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
      owner_waiting: () => waitingFixture(),
      desk_get: () => ({ week: "2026-W48", items: [] }),
      actions_log: () => ({ rows: [] }),
      ...rpcOverrides,
    } as never,
  });
}

const hasPanelSubPath = (calls: ReadonlyArray<Record<string, unknown>>, subPath: string) =>
  calls.some((call) => call.method === "toPluginPanel" && (call as { options?: { subPath?: string } }).options?.subPath === subPath);

describe("Decisions screen — waiting tab (P2)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    toast.success.mockClear();
    toast.error.mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.restoreAllMocks();
  });

  it("renders attention counter «3 из 5», binds tabs waiting/desk/autonomous to route.view, and replaces PushSettings with a settings link", async () => {
    const slot = await mountDecisions();
    await slot.findByTestId("console-decisions");
    await slot.findByTestId("owner-waiting");

    expect(slot.getByTestId("owner-attention").textContent).toContain("3 из 5");
    expect(slot.getByTestId("owner-attention").textContent).toContain("3 из 5 сегодня");
    expect(slot.queryByTestId("owner-push")).toBeNull();
    expect(slot.getByTestId("owner-push-link")).toBeTruthy();

    fireEvent.click(slot.getByTestId("seg-decisions-view-desk"));
    await slot.findByTestId("review-desk");
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "decisions/desk")).toBe(true);

    fireEvent.click(slot.getByTestId("seg-decisions-view-autonomous"));
    await slot.findByTestId("actions-log");
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "decisions/autonomous")).toBe(true);

    fireEvent.click(slot.getByTestId("seg-decisions-view-waiting"));
    await slot.findByTestId("owner-waiting");

    fireEvent.click(slot.getByTestId("owner-open-settings"));
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "system/settings")).toBe(true);
  });

  it("filters waiting items by scope project", async () => {
    const slot = await mountDecisions();
    await slot.findByTestId("owner-item-task-word:run_1:t1:att_1");
    expect(slot.getByTestId("owner-item-deferral:dfr_b")).toBeTruthy();

    fireEvent.click(slot.getByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-project-proj_ui"));

    await waitFor(() => {
      expect(slot.queryByTestId("owner-item-deferral:dfr_b")).toBeNull();
    });
    expect(slot.getByTestId("owner-item-task-word:run_1:t1:att_1")).toBeTruthy();
  });

  it("asks for the term in the chat instead of sending a deferral with an owner message the console cannot prove", async () => {
    // A term comes only from the owner's own message with a date (deferral-service verifies it); the console used to send «console#0» and always failed.
    const deferRpc = vi.fn().mockResolvedValue({ entry: { id: "dfr_b" }, created: false });
    const slot = await mountDecisions({ owner_waiting: () => waitingFixture(), deferral_defer: deferRpc });

    const hint = await slot.findByTestId("owner-defer-hint-deferral:dfr_b");
    expect(hint.textContent).toContain("в чате");
    expect(slot.queryByTestId("owner-defer-deferral:dfr_b")).toBeNull();
    expect(slot.queryByTestId("owner-defer-hint-task-word:run_1:t1:att_1")).toBeNull();
    expect(deferRpc).not.toHaveBeenCalled();
  });

  it("opens ConfirmDialog for «Нет» (task_word no), requires reason, and sends task_word with typed reason without window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => "should not be called");
    const taskWordRpc = vi.fn().mockResolvedValue({ ok: true });
    const slot = await mountDecisions({ task_word: taskWordRpc });

    const noBtn = await slot.findByTestId("owner-run-task-word:run_1:t1:att_1-no");
    fireEvent.click(noBtn);

    const reasonInput = await slot.findByTestId("owner-confirm-reason");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(taskWordRpc).not.toHaveBeenCalled();

    fireEvent.change(reasonInput, { target: { value: "Нужны тесты на крайний случай" } });
    const confirmButtons = slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button");
    const confirmBtn = Array.from(confirmButtons).find((btn) => btn.textContent === "Нет");
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn!);

    await waitFor(() => expect(taskWordRpc).toHaveBeenCalledWith({
      runId: "run_1",
      taskId: "t1",
      decision: "no",
      text: "Нужны тесты на крайний случай",
    }));
  });

  it("routes finish_run and schedule_pause through ConfirmDialog and displays server error on the card on failure", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
    const finishRpc = vi.fn().mockRejectedValue(new Error("Run is already closed"));
    const pauseRpc = vi.fn().mockResolvedValue({ schedule: {} });

    const slot = await mountDecisions({
      finish_run: finishRpc,
      schedule_pause: pauseRpc,
    });

    const finishBtn = await slot.findByTestId("owner-run-run-budget:run_2-finish");
    fireEvent.click(finishBtn);
    await waitFor(() => expect(slot.container.ownerDocument.querySelector("[role='alertdialog']")).not.toBeNull());
    expect(finishRpc).not.toHaveBeenCalled();

    const finishConfirm = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Завершить прогон");
    fireEvent.click(finishConfirm!);

    await waitFor(() => expect(finishRpc).toHaveBeenCalledWith({ projectId: "proj_ui", runId: "run_2" }));
    const errEl = await slot.findByTestId("owner-error-run-budget:run_2");
    expect(errEl.textContent).toContain("Run is already closed");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("opens task route or file preview from evidence chips and keeps copy as a secondary icon", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const slot = await mountDecisions();
    await slot.findByTestId("owner-item-task-word:run_1:t1:att_1");

    const copyBtn = slot.getByTestId("owner-evidence-copy-task-word:run_1:t1:att_1-2");
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/billing/guard.ts"));

    const fileChip = slot.getByTestId("owner-evidence-open-task-word:run_1:t1:att_1-2");
    fireEvent.click(fileChip);
    expect(slot.inspection.navigateCalls.some((call) =>
      call.method === "experimental_openFilePreview" &&
      (call as { options?: { target?: { path?: string } } }).options?.target?.path === "src/billing/guard.ts")).toBe(true);

    const taskChip = slot.getByTestId("owner-evidence-open-task-word:run_1:t1:att_1-1");
    fireEvent.click(taskChip);
    expect(hasPanelSubPath(slot.inspection.navigateCalls, "work/task/run_1/t1")).toBe(true);
  });
});
