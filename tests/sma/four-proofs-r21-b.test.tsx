/** @vitest-environment jsdom */
// Region 21 · k_t_progress: the progress counter of a run card in the PM's message, read from the run's tasks as the plugin server gives them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanup());

type Task = { id: string; title: string; state: string | null; threadId: string | null; checkLog: null };
const task = (id: string, state: string | null): Task => ({ id, title: `Task ${id}`, state, threadId: null, checkLog: null });
async function counter(tasks: Task[], closed = false): Promise<string> {
  const app = await loadPluginApp(() => import("../../app"));
  const directive = app.messageDirectives.find((row) => row.id === "lane-run")!;
  const slot = renderSlot({ component: directive.component }, { attributes: { id: "run_1" }, source: '::lane-run{id="run_1"}', message: { id: "m1", threadId: "thr_pm", turnId: null, projectId: "p" }, openWorkspaceFile: null },
    { rpc: { get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }), get_run_card: () => ({ runId: "run_1", state: closed ? "closed" : "running", closed, tasks }) } as never });
  const root = await slot.findByTestId("run-card");
  // The header is the first row of the card: the title and the counter.
  const header = root.firstElementChild!.textContent!;
  cleanup();
  return header;
}

describe("region 21 · progress", () => {
  it("[sma:k_t_progress] the run card counts accepted work out of the work there is: a task sent again is one, an empty run reads 0 of 0, a closed run says closed instead of a count", async () => {
    expect(await counter([task("t1", "accepted"), task("t2", "accepted"), task("t3", "blocked")])).toBe("Lane Pilot run2 of 3 tasks accepted");
    // T3, T3.2 and T3.4 are one piece of work sent again: done when the latest member is accepted.
    expect(await counter([task("T3", "blocked"), task("T3.2", "failed"), task("T3.4", "accepted"), task("F1", "queued")])).toBe("Lane Pilot run1 of 2 tasks accepted");
    expect(await counter([task("T3", "accepted"), task("T3.2", "blocked")])).toBe("Lane Pilot run0 of 1 tasks accepted");
    expect(await counter([])).toBe("Lane Pilot run0 of 0 tasks accepted");
    expect(await counter([task("t1", "accepted")], true)).not.toContain("tasks accepted");
  });
});
