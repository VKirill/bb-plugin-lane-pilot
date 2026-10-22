/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { ReturnStage } = await import("../src/rooms/stage-return/ui");
  return renderSlot({ component: () => <ReturnStage runId="run" taskId="t1" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("«Return to a stage…» in the task card", () => {
  it("sends the chosen stage and the note as an action, then says what was reset and kept", async () => {
    const calls: unknown[] = [];
    const slot = await mount({ task_return_stage: (input: unknown) => { calls.push(input); return { ok: true, state: "handed_to_pm", paused: "attempt a1 stopped (exit confirmed, its work is on record)",
      stale: [{ stage: "plan-critique", why: "returned to planning" }, { stage: "writer-agent", why: "after plan-critique" }], reused: ["pm-read"], restarted: { by: "pm", note: "the PM has the note and the list of stale receipts" } }; } });
    fireEvent.click(await slot.findByText("Return to a stage…"));
    const send = await slot.findByTestId("return-send");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByTestId("return-to-writer"));
    fireEvent.change(slot.getByTestId("return-note"), { target: { value: "Use the csv helper." } });
    expect((slot.getByTestId("return-send") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByTestId("return-send"));
    await waitFor(() => expect(calls).toEqual([{ ref: "t1", to: "writer", note: "Use the csv helper.", by: "owner" }]));
    const result = await slot.findByTestId("return-result");
    expect(result.getAttribute("data-ok")).toBe("true");
    expect(result.textContent).toContain("attempt a1 stopped");
    expect(result.textContent).toContain("plan-critique, writer-agent");
    expect(result.textContent).toContain("pm-read");
    expect((slot.getByTestId("return-note") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the refusal and what to do next, and keeps the note", async () => {
    const slot = await mount({ task_return_stage: () => ({ ok: false, state: "refused", reason: "attempt a1 of t1 was accepted and merged: its work is in main", next: "take it out with `bb lane-pilot revert t1`, then send the task again" }) });
    fireEvent.click(await slot.findByText("Return to a stage…"));
    fireEvent.change(await slot.findByTestId("return-note"), { target: { value: "Change of plan." } });
    fireEvent.click(slot.getByTestId("return-send"));
    const result = await slot.findByTestId("return-result");
    expect(result.getAttribute("data-ok")).toBe("false");
    expect(result.textContent).toContain("accepted and merged");
    expect(result.textContent).toContain("bb lane-pilot revert t1");
    expect((slot.getByTestId("return-note") as HTMLTextAreaElement).value).toBe("Change of plan.");
  });

  it("reads in Russian too", async () => {
    setLocaleOverride("ru");
    const slot = await mount({ task_return_stage: () => ({ ok: true }) });
    expect(await slot.findByText("Вернуть на стадию…")).toBeTruthy();
  });
});
