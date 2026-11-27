/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { boardFixture, cardFixture, screenFixture } from "./ui-harness";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
];

const SAMPLE_RECORDS = [
  {
    id: "rec_fact_111111",
    kind: "note" as const,
    audience: "subagent",
    content: "Payments run through YooKassa; source of truth is orders table.",
    concepts: ["payments", "orders"],
    createdAt: 1_790_000_000_000,
    rule: false,
    useCount: 12,
    acceptedCount: 9,
    originTaskId: "task_42",
    originRunId: "run_42",
    sourceFileId: null,
    noTrace: false,
    origin: "maintainer",
    scope: ["section:billing"],
    sources: 3,
  },
  {
    id: "rec_rule_222222",
    kind: "core" as const,
    audience: "subagent",
    content: "Never promise guaranteed outcomes in ad headlines.",
    concepts: ["rule", "ads"],
    createdAt: 1_789_500_000_000,
    rule: true,
    useCount: 41,
    acceptedCount: 38,
    originTaskId: null,
    originRunId: null,
    sourceFileId: null,
    noTrace: false,
    origin: "rule",
    scope: [],
    sources: 2,
  },
  {
    id: "rec_dec_333333",
    kind: "note" as const,
    audience: "subagent",
    content: "Decision: order queue uses Postgres advisory locks instead of Redis.",
    concepts: ["decision", "queue"],
    createdAt: 1_789_000_000_000,
    rule: false,
    useCount: 4,
    acceptedCount: 4,
    originTaskId: "task_19",
    originRunId: "run_19",
    sourceFileId: null,
    noTrace: false,
    origin: "session",
    scope: [],
    sources: 1,
  },
  {
    id: "rec_les_444444",
    kind: "note" as const,
    audience: "subagent",
    content: "Admin tests fail unless TZ=Europe/Moscow is set in check env.",
    concepts: ["lesson", "tests"],
    createdAt: 1_788_500_000_000,
    rule: false,
    useCount: 3,
    acceptedCount: 2,
    originTaskId: null,
    originRunId: null,
    sourceFileId: null,
    noTrace: false,
    origin: "lesson",
    scope: [],
    sources: 1,
  },
];

const SAMPLE_CARDS = [
  {
    id: "card_stale_5555",
    kind: "platform",
    title: "Telegram limit 4096 chars.",
    concepts: ["card:platform:telegram", "card"],
    verifiedAt: 1_785_000_000_000,
    ttlDays: 5,
    stale: true,
    ref: "https://core.telegram.org/bots/api",
    version: 2,
  },
  {
    id: "card_fresh_6666",
    kind: "brand",
    title: "Calm and factual brand tone.",
    concepts: ["card:brand:tone", "card"],
    verifiedAt: 1_790_000_000_000,
    ttlDays: 30,
    stale: false,
    ref: "docs/brand.md",
    version: 1,
  },
];

function defaultRpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const baseScreen = screenFixture();
  return {
    get_preferences: (input: unknown) => ({
      locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale,
      preference: "auto",
      lastProjectId: "proj_ui",
    }),
    set_locale: () => ({ locale: "en", preference: "en" }),
    remember_project: () => ({ ok: true }),
    list_projects: () => ({ projects: PROJECTS, lastProjectId: "proj_ui" }),
    list_sections: () => ({ sections: [] }),
    get_routing_hint: () => ({ current: null, stats: [] }),
    get_screen: (input: unknown) => ({ ...baseScreen, projectId: (input as { projectId?: string }).projectId ?? "proj_ui" }),
    task_board: () => boardFixture(),
    task_card: () => cardFixture(),
    work_graph_strips: () => ({}),
    specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
    owner_waiting: () => ({
      generatedAt: 1_800_000_000_000,
      now: 0,
      counts: {},
      overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 },
      answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
      items: [],
    }),
    memory_records_list: () => ({ records: SAMPLE_RECORDS }),
    memory_cards_list: () => ({ cards: SAMPLE_CARDS }),
    session_memory_search: () => ({ records: [] }),
    memory_record_delete: () => ({ deleted: true, reason: null, leftovers: [] }),
    ...overrides,
  };
}

async function mountMemory({
  subPath = "memory",
  projectId = "proj_ui",
  rpc = {},
}: {
  subPath?: string;
  projectId?: string | null;
  rpc?: Record<string, (input: unknown) => unknown>;
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, {
    context: { projectId, threadId: null },
    providers: { status: "ready", providers: [] } as never,
    rpc: defaultRpc(rpc),
  });
}

describe("console memory screen (P7)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.useRealTimers();
  });

  it("hides delete button for rules, shows detail metadata & task route link, and omits edit/pin buttons", async () => {
    const slot = await mountMemory();

    await slot.findByTestId("memory-screen");
    await slot.findByTestId("memory-item-rec_fact_111");

    // Default selected first record is fact: check detail pane fields and task link.
    const detail = slot.getByTestId("memory-detail");
    expect(detail.textContent).toContain("Payments run through YooKassa");
    expect(detail.textContent).toContain("maintainer");
    expect(detail.textContent).toContain("section:billing");
    expect(detail.textContent).toContain("12");
    expect(detail.textContent).toContain("9");
    expect(detail.textContent).toContain("3");

    // No edit or pin buttons anywhere in the detail pane.
    expect(detail.querySelectorAll("button").length).toBe(2); // only task link + Delete
    expect(slot.queryByRole("button", { name: /edit|исправить|pin|закрепить/i })).toBeNull();

    // Clicking task link navigates to work/task/<runId>/<taskId>.
    fireEvent.click(slot.getByTestId("memory-detail-task-link"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "work/task/run_42/task_42" },
    });

    // Switch back to Memory and select rule record: rule must have NO delete button.
    fireEvent.click(slot.getByTestId("console-nav-memory"));
    await slot.findByTestId("memory-item-rec_rule_222");
    fireEvent.click(slot.getByTestId("memory-item-rec_rule_222"));
    expect(slot.getByTestId("memory-detail-text").textContent).toContain("Never promise guaranteed outcomes");
    expect(slot.queryByTestId("memory-detail-delete")).toBeNull();

    slot.lifecycle.unmount();
  });

  it("requires ConfirmDialog confirmation before calling memory_record_delete on non-rule records", async () => {
    const deleteSpy = vi.fn(() => ({ deleted: true, reason: null, leftovers: [] }));
    const recordsSpy = vi.fn(() => ({ records: SAMPLE_RECORDS }));
    const slot = await mountMemory({
      rpc: {
        memory_records_list: recordsSpy,
        memory_record_delete: deleteSpy,
      },
    });

    await slot.findByTestId("memory-item-rec_fact_111");
    fireEvent.click(slot.getByTestId("memory-detail-delete"));

    // Dialog is open, delete RPC has NOT been called yet.
    const dialog = await slot.findByRole("alertdialog");
    expect(deleteSpy).not.toHaveBeenCalled();

    const confirmBtn = dialog.querySelector('button[class*="bg-destructive"]') ??
      Array.from(dialog.querySelectorAll("button")).find((btn) => /delete|удалить/i.test(btn.textContent ?? ""))!;
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith({ projectId: "proj_ui", id: "rec_fact_111111" }),
    );
    await waitFor(() => expect(recordsSpy).toHaveBeenCalledTimes(2));

    slot.lifecycle.unmount();
  });

  it("filters by facts/decisions/rules/lessons/cards, displays card stale pill, and debounces search 300ms", async () => {
    const searchSpy = vi.fn((input: unknown) => {
      const { query } = input as { query: string };
      return {
        records: query.includes("YooKassa")
          ? [{ id: "rec_fact_111111", kind: "note", content: SAMPLE_RECORDS[0]!.content, concepts: SAMPLE_RECORDS[0]!.concepts }]
          : [],
      };
    });
    const slot = await mountMemory({
      rpc: { session_memory_search: searchSpy },
    });

    await slot.findByTestId("memory-screen");
    await slot.findByTestId("memory-card-card_stale_5");

    // Stale card displays stale pill; fresh card does not have stale pill.
    expect(slot.getByTestId("memory-card-stale-card_stale_5").textContent).toMatch(/stale|устарело/i);
    expect(slot.queryByTestId("memory-card-stale-card_fresh_6")).toBeNull();

    // Filter chips isolate each category.
    fireEvent.click(slot.getByTestId("memory-filter-decisions"));
    expect(slot.queryByTestId("memory-item-rec_dec_3333")).toBeTruthy();
    expect(slot.queryByTestId("memory-item-rec_fact_111")).toBeNull();

    fireEvent.click(slot.getByTestId("memory-filter-lessons"));
    expect(slot.queryByTestId("memory-item-rec_les_4444")).toBeTruthy();
    expect(slot.queryByTestId("memory-item-rec_dec_3333")).toBeNull();

    fireEvent.click(slot.getByTestId("memory-filter-rules"));
    expect(slot.queryByTestId("memory-item-rec_rule_222")).toBeTruthy();
    expect(slot.queryByTestId("memory-item-rec_les_4444")).toBeNull();

    fireEvent.click(slot.getByTestId("memory-filter-cards"));
    expect(slot.queryByTestId("memory-card-card_stale_5")).toBeTruthy();
    expect(slot.queryByTestId("memory-item-rec_rule_222")).toBeNull();

    fireEvent.click(slot.getByTestId("memory-filter-all"));

    // Search box triggers session_memory_search after 300ms debounce.
    const searchInput = slot.getByTestId("memory-search");
    fireEvent.change(searchInput, { target: { value: "YooKassa" } });
    expect(searchSpy).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(searchSpy).toHaveBeenCalledWith({ projectId: "proj_ui", query: "YooKassa" }),
    );
    await waitFor(() => {
      expect(slot.queryByTestId("memory-item-rec_fact_111")).toBeTruthy();
      expect(slot.queryByTestId("memory-item-rec_rule_222")).toBeNull();
    });

    slot.lifecycle.unmount();
  });
});
