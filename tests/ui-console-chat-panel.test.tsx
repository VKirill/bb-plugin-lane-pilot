/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { HelperThreadsList } from "../src/rooms/native-agent/ui";
import { ChatPanel, ThreadLivePanel } from "../src/rooms/runs/ui";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const OLD_TS = NOW - 3 * 86_400_000;

const threadSends: unknown[] = [];

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    useSdk: () => ({
      threads: {
        send: async (req: unknown) => {
          threadSends.push(req);
          return { id: "msg_1" };
        },
      },
    }),
  };
});

function makeDefaultRpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  return {
    thread_scope: () => ({
      threadId: "thr_pm",
      projectId: "proj_1",
      sectionId: "sec_admin",
      hostId: "host_1",
      cwd: "/srv/treba-online",
      repo: {
        root: "/srv/treba-online",
        remote: "git@github.com:VKirill/treba-online.git",
        githubRepoId: "VKirill/treba-online",
      },
    }),
    repo_trust: () => ({
      repo: {
        root: "/srv/treba-online",
        remote: "git@github.com:VKirill/treba-online.git",
      },
      gate: { state: "passed", at: NOW - 60_000, fresh: true, reason: null },
      tests: { lastCount: 1240 },
      rollbacks30d: 0,
      acceptedFirstTry30d: 0.9,
      level: "high",
      rules: [
        { actionClass: "merge_without_owner", mode: "auto" },
        { actionClass: "migrations", mode: "ask" },
        { actionClass: "deploy", mode: "owner_only" },
      ],
    }),
    thread_live: () => ({
      role: "pm",
      pmThreadId: "thr_pm",
      session: null,
      strips: {},
      items: [
        {
          key: "task:r1:t1",
          runId: "r1",
          taskId: "t1",
          title: "Фильтр заказов",
          column: "running",
          phase: "checking",
          stage: "code-critique",
          model: "claude-opus-4",
          since: NOW - 24 * 60_000,
          threadId: "thr_w1",
          updatedAt: NOW - 10_000,
          detail: null,
          projectId: "proj_1",
          kind: "task",
          state: "running",
        },
        {
          key: "task:r1:t4",
          runId: "r1",
          taskId: "t4",
          title: "Старая закрытая задача",
          column: "done",
          phase: "accepted",
          stage: null,
          model: null,
          since: null,
          threadId: null,
          updatedAt: OLD_TS,
          detail: null,
          projectId: "proj_1",
          kind: "task",
          state: "accepted",
        },
      ],
    }),
    task_board: () => ({
      items: [
        {
          kind: "task",
          key: "task:r1:t2",
          runId: "r1",
          taskId: "t2",
          title: "Экспорт заказов в Excel",
          techTitle: null,
          taskKind: "feature",
          area: null,
          objective: null,
          projectId: "proj_1",
          pmThreadId: "thr_pm",
          pmThreadTitle: null,
          column: "blocked",
          state: "blocked",
          phase: "blocked",
          stage: null,
          model: null,
          since: NOW - 60 * 60_000,
          waitingFor: [],
          detail: "план прошёл критику",
          attemptNo: 1,
          threadId: null,
          attemptId: "att_2",
          updatedAt: NOW - 120_000,
          held: false,
          gates: null,
          wave: null,
        },
        {
          kind: "task",
          key: "task:r1:t3",
          runId: "r1",
          taskId: "t3",
          title: "Письмо клиенту после оплаты",
          techTitle: null,
          taskKind: "feature",
          area: null,
          objective: null,
          projectId: "proj_1",
          pmThreadId: "thr_pm",
          pmThreadTitle: null,
          column: "queued",
          state: "queued",
          phase: "queued",
          stage: null,
          model: null,
          since: null,
          waitingFor: [],
          detail: null,
          attemptNo: 1,
          threadId: null,
          attemptId: "att_3",
          updatedAt: NOW - 60_000,
          held: false,
          gates: null,
          wave: null,
        },
        {
          key: "task:r1:t5",
          kind: "task",
          runId: "r1",
          taskId: "t5",
          title: "Кнопка «повторить заказ»",
          techTitle: null,
          taskKind: "feature",
          area: null,
          objective: null,
          projectId: "proj_1",
          pmThreadId: "thr_pm",
          pmThreadTitle: null,
          column: "done",
          state: "accepted",
          phase: "accepted",
          stage: null,
          model: null,
          since: null,
          waitingFor: [],
          detail: null,
          attemptNo: 1,
          threadId: null,
          attemptId: "att_5",
          updatedAt: NOW - 30_000,
          held: false,
          gates: null,
          wave: null,
        },
        {
          key: "task:r2:t_other",
          kind: "task",
          runId: "r2",
          taskId: "t_other",
          title: "Задача из другого раздела",
          techTitle: null,
          taskKind: "feature",
          area: null,
          objective: null,
          projectId: "proj_1",
          pmThreadId: "thr_other_pm",
          pmThreadTitle: null,
          column: "running",
          state: "running",
          phase: "writing",
          stage: "writer-agent",
          model: null,
          since: NOW - 10_000,
          waitingFor: [],
          detail: null,
          attemptNo: 1,
          threadId: null,
          attemptId: "att_other",
          updatedAt: NOW - 10_000,
          held: false,
          gates: null,
          wave: null,
        },
      ],
    }),
    memory_records_list: () => ({
      records: [
        {
          id: "mem_sec",
          kind: "note",
          audience: "subagent",
          content: "Фильтр в админке хранится в query string",
          concepts: ["admin"],
          createdAt: NOW - 5_000,
          rule: false,
          useCount: 1,
          acceptedCount: 1,
          originTaskId: null,
          originRunId: null,
          sourceFileId: null,
          noTrace: false,
          origin: "session",
          scope: ["section:sec_admin"],
          sources: 1,
        },
        {
          id: "mem_other",
          kind: "core",
          audience: "subagent",
          content: "Публичный каталог кешируется на 5 минут",
          concepts: ["cache"],
          createdAt: NOW - 8_000,
          rule: true,
          useCount: 3,
          acceptedCount: 3,
          originTaskId: null,
          originRunId: null,
          sourceFileId: null,
          noTrace: false,
          origin: "rule",
          scope: ["section:sec_catalog"],
          sources: 1,
        },
      ],
    }),
    task_history: () => ({
      rows: [
        {
          runId: "r_hist_1",
          taskId: "t_hist_1",
          projectId: "proj_1",
          title: "Опечатки в оферте",
          outcome: "accepted",
          attempts: 1,
          finishedAt: NOW - 1_000,
          durationMs: 42_000,
          costUsd: 0.12,
          mergeSha: "77be0d1abcdef",
          failureReason: null,
          lessonMemoryId: null,
        },
      ],
      nextCursor: null,
    }),
    list_helper_threads: () => ({
      threads: [
        { id: "thr_h1", title: "Writer 1", status: "active", role: "writer", detail: null, phase: "работает" },
      ],
      queued: [],
      graph: {
        nodes: [
          {
            id: "t_blocked",
            title: "Broken task",
            state: "blocked",
            threadId: "thr_h1",
            attemptId: "att_cancel_1",
            reason: "failed check",
          },
        ],
        edges: [],
      },
    }),
    cancel_attempt: () => ({ ok: true, state: "canceled", reason: null }),
    ...overrides,
  };
}

describe("Chat right panel (C1)", () => {
  beforeEach(() => {
    cleanup();
    threadSends.length = 0;
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("caps a long group at a few rows and shows the rest on request", async () => {
    const blocked = Array.from({ length: 12 }, (_, n) => ({
      ...makeDefaultRpc().task_board().items[0]!,
      key: `workflow:wf_${n}`,
      runId: `wf_${n}`,
      taskId: null,
      title: `Сбой ${n}`,
      pmThreadId: "thr_pm",
    }));
    const slot = renderSlot(
      { component: () => <ChatPanel threadId="thr_pm" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_pm" },
        rpc: makeDefaultRpc({ task_board: () => ({ items: blocked }), thread_live: () => null }) as never,
      },
    );
    const group = await slot.findByTestId("chat-tasks-group-waiting");
    expect(group.querySelectorAll("[data-testid^='chat-task-row-']")).toHaveLength(5);
    fireEvent.click(slot.getByTestId("chat-tasks-more-waiting"));
    await waitFor(() => expect(group.querySelectorAll("[data-testid^='chat-task-row-']")).toHaveLength(12));
    expect(slot.queryByTestId("chat-tasks-more-waiting")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows section/project switch in section chat, hides in whole-project chat, and toggles scope queries", async () => {
    const repoTrustCalls: unknown[] = [];
    const historyCalls: unknown[] = [];
    const slot = renderSlot(
      { component: () => <ChatPanel threadId="thr_pm" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_pm" },
        rpc: makeDefaultRpc({
          repo_trust: (input) => {
            repoTrustCalls.push(input);
            return makeDefaultRpc().repo_trust();
          },
          task_history: (input) => {
            historyCalls.push(input);
            return makeDefaultRpc().task_history();
          },
        }) as never,
      },
    );

    await slot.findByTestId("chat-panel-scope");
    expect(slot.getByTestId("chat-scope-section").getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByTestId("chat-panel-repo").textContent).toContain("VKirill/treba-online");
    expect(slot.getByTestId("chat-panel-repo").textContent).toContain("1240 тестов");
    expect(slot.getByTestId("chat-panel-repo").textContent).toContain("0 откатов за 30 дн.");
    expect(slot.getByTestId("chat-panel-autonomy").textContent).toContain("сливает сам");
    expect(slot.getByTestId("chat-panel-autonomy").textContent).toContain("спрашивает");
    expect(slot.getByTestId("chat-panel-autonomy").textContent).toContain("только вы");

    // In section mode, tasks from other PM threads are hidden.
    await slot.findByTestId("chat-task-row-task:r1:t2");
    expect(slot.queryByTestId("chat-task-row-task:r2:t_other")).toBeNull();

    // Switch to Whole project: reveals other section tasks & calls repo_trust without sectionId.
    fireEvent.click(slot.getByTestId("chat-scope-project"));
    await waitFor(() => expect(slot.queryByTestId("chat-task-row-task:r2:t_other")).toBeTruthy());
    expect(repoTrustCalls).toContainEqual({ projectId: "proj_1", sectionId: "sec_admin" });
    expect(repoTrustCalls).toContainEqual({ projectId: "proj_1" });

    // Switch to History tab: verifies limit 20.
    fireEvent.click(slot.getByTestId("chat-tab-history"));
    await slot.findByTestId("chat-history-row-t_hist_1");
    expect(historyCalls).toContainEqual({ projectId: "proj_1", limit: 20 });
    slot.lifecycle.unmount();

    // When sectionId is null, scope switch is hidden.
    const noSection = renderSlot(
      { component: () => <ChatPanel threadId="thr_proj" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_proj" },
        rpc: makeDefaultRpc({
          thread_scope: () => ({
            threadId: "thr_proj",
            projectId: "proj_1",
            sectionId: null,
            hostId: "host_1",
            cwd: "/srv/treba-online",
            repo: { root: "/srv/treba-online", remote: null, githubRepoId: null },
          }),
        }) as never,
      },
    );
    await noSection.findByTestId("chat-panel-repo");
    expect(noSection.queryByTestId("chat-panel-scope")).toBeNull();
    expect(noSection.getByTestId("chat-panel-repo").textContent).toContain("treba-online");
    noSection.lifecycle.unmount();
  });

  it("shows «Нет репозитория» for chats without Git and groups tasks with task route navigation", async () => {
    const slot = renderSlot(
      { component: () => <ThreadLivePanel threadId="thr_pm" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_pm" },
        rpc: makeDefaultRpc({
          thread_scope: () => ({
            threadId: "thr_pm",
            projectId: "proj_1",
            sectionId: "sec_admin",
            hostId: "host_1",
            cwd: "/srv/docs",
            repo: null,
          }),
        }) as never,
      },
    );

    const noRepo = await slot.findByTestId("chat-panel-no-repo");
    expect(noRepo.textContent).toContain("Нет репозитория");

    // Tasks are grouped into the 4 groups; older done item is excluded from Закрыто сегодня.
    expect((await slot.findByTestId("chat-tasks-group-running")).textContent).toContain("Фильтр заказов");
    expect(slot.getByTestId("chat-tasks-group-waiting").textContent).toContain("Экспорт заказов в Excel");
    expect(slot.getByTestId("chat-tasks-group-queued").textContent).toContain("Письмо клиенту после оплаты");
    expect(slot.getByTestId("chat-tasks-group-done-today").textContent).toContain("Кнопка «повторить заказ»");
    expect(slot.queryByTestId("chat-task-row-task:r1:t4")).toBeNull();

    // Clicking a task row navigates to plugin panel task route.
    fireEvent.click(slot.getByTestId("chat-task-row-task:r1:t1"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "work/task/r1/t1" },
    });

    // Memory tab shows read-only scope records and link «Открыть в Памяти».
    fireEvent.click(slot.getByTestId("chat-tab-memory"));
    await slot.findByTestId("chat-memory-row-mem_sec");
    expect(slot.queryByTestId("chat-memory-row-mem_other")).toBeNull();
    expect(slot.queryByRole("button", { name: /удалить|delete/i })).toBeNull();
    fireEvent.click(slot.getByTestId("chat-memory-open-link"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "memory/records" },
    });

    // Follow-up box sends via sdk.threads.send with queue-if-active.
    fireEvent.change(slot.getByTestId("thread-live-followup-input"), { target: { value: "Продолжай" } });
    fireEvent.click(slot.getByTestId("thread-live-followup-send"));
    await waitFor(() => expect(threadSends).toEqual([
      {
        threadId: "thr_pm",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Продолжай", mentions: [] }],
      },
    ]));

    slot.lifecycle.unmount();
  });

  it("requires ConfirmDialog confirmation before canceling a helper attempt and handles unlinked chats", async () => {
    const cancelSpy = vi.fn(() => ({ ok: true, state: "canceled", reason: null }));
    const slot = renderSlot(
      { component: () => <ChatPanel threadId="thr_pm" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_pm" },
        rpc: makeDefaultRpc({ cancel_attempt: cancelSpy }) as never,
      },
    );

    await slot.findByTestId("chat-tab-helpers");
    fireEvent.click(slot.getByTestId("chat-tab-helpers"));
    await slot.findByTestId("task-cancel-t_blocked");

    fireEvent.click(slot.getByTestId("task-cancel-t_blocked"));
    const dialog = await slot.findByRole("alertdialog");
    expect(cancelSpy).not.toHaveBeenCalled();

    const confirmBtn = dialog.querySelector('button[class*="bg-destructive"]') ??
      Array.from(dialog.querySelectorAll("button")).find((btn) => /остановить|stop/i.test(btn.textContent ?? ""))!;
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(cancelSpy).toHaveBeenCalledWith({ attemptId: "att_cancel_1", code: "owner_cancel" }),
    );
    slot.lifecycle.unmount();

    // Unlinked chat (projectId: null) shows note «Чат не привязан к проекту», Helpers, and follow-up only.
    const unlinked = renderSlot(
      { component: () => <ChatPanel threadId="thr_free" locale="ru" HelpersList={HelperThreadsList} /> },
      {},
      {
        context: { projectId: null, threadId: "thr_free" },
        rpc: makeDefaultRpc({
          thread_scope: () => ({
            threadId: "thr_free",
            projectId: null,
            sectionId: null,
            hostId: null,
            cwd: null,
            repo: null,
          }),
        }) as never,
      },
    );
    const note = await unlinked.findByTestId("chat-panel-no-project");
    expect(note.textContent).toContain("Чат не привязан к проекту");
    expect(unlinked.queryByTestId("chat-panel-scope")).toBeNull();
    expect(unlinked.queryByTestId("chat-panel-tabs")).toBeNull();
    expect(unlinked.queryByTestId("chat-panel-autonomy")).toBeNull();
    expect(unlinked.getByTestId("chat-panel-helpers-only")).toBeTruthy();
    expect(unlinked.getByTestId("thread-live-followup")).toBeTruthy();
    unlinked.lifecycle.unmount();
  });
});
