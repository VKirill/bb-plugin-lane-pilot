/** @vitest-environment jsdom */
// Kept beside parity-d9-records-2.test.ts: the board is a page, so this file needs the document (the other one runs on the node side).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { AcceptanceCard } from "../../src/rooms/acceptance/ui";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
const realMatchMedia = window.matchMedia;
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); window.matchMedia = realMatchMedia; });

const task = (taskId: string, column: string) => ({
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: null, objective: null,
  projectId: "proj_a", pmThreadId: null, pmThreadTitle: null, column, state: "running", phase: "writing", stage: null, model: null, since: null, waitingFor: [], detail: null,
  attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, held: false, gates: null, wave: null,
});

async function mount(narrow: boolean) {
  window.matchMedia = ((query: string) => ({ matches: narrow && query.includes("max-width: 639px"), media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never;
  await loadPluginApp(() => import("../../app"));
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  return renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, {
    context: { projectId: null, threadId: null },
    rpc: { task_board: () => ({ items: [task("w1", "running"), task("q1", "queued")] }) } as never,
  });
}

describe("[sma:m_wnr_tasks] the task board on a phone", () => {
  it("under 640px the board opens as the list, not as fixed columns", async () => {
    const slot = await mount(true);
    await waitFor(() => expect(slot.container.textContent).toContain("Title w1"));
    expect(slot.queryByTestId("board-columns")).toBeNull();
  });

  it("on a wide screen the board keeps its columns, as before", async () => {
    const slot = await mount(false);
    const columns = await slot.findByTestId("board-columns");
    expect(columns.getAttribute("data-narrow")).toBeNull();
    expect(slot.getByTestId("board-col-running").textContent).toContain("Title w1");
  });
});
