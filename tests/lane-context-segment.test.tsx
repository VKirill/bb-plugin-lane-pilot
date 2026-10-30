/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { LaneContextSummary, useLaneContextVisible } from "../src/rooms/runs/ui";

const liveRpc = { thread_live: () => ({ role: "pm", pmThreadId: "thr_1", items: [{ column: "running" }, { column: "checking" }, { column: "done" }], strips: {} }) };

describe("thread context segment (A-u3)", () => {
  it("registers the segment on the experimental slot", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const segments = (app as unknown as { threadContextSegments: Array<{ id: string }> }).threadContextSegments;
    expect(segments.some((segment) => segment.id === "lane-pilot-live-segment")).toBe(true);
  });

  it("is visible only with live work and summarizes the active count", async () => {
    let visible: boolean | null = null;
    const Probe = () => { visible = useLaneContextVisible({ threadId: "thr_1" }); return <LaneContextSummary threadId="thr_1" />; };
    const slot = renderSlot({ component: Probe } as never, {}, {
      context: { projectId: "proj_1", threadId: "thr_1" },
      rpc: liveRpc,
    });
    await waitFor(() => expect(visible).toBe(true));
    await waitFor(() => expect(slot.getByTestId("lane-context-summary").textContent).toContain("2"));
    slot.lifecycle.unmount();
  });

  it("hides on a thread with no Lane Pilot work", async () => {
    let visible: boolean | null = null;
    const Probe = () => { visible = useLaneContextVisible({ threadId: "thr_2" }); return null; };
    const slot = renderSlot({ component: Probe } as never, {}, {
      context: { projectId: "proj_1", threadId: "thr_2" },
      rpc: { thread_live: () => null },
    });
    await waitFor(() => expect(visible).toBe(false));
    slot.lifecycle.unmount();
  });
});
