/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useCockpitPageTitle } from "../src/rooms/ui-shell/ui";

describe("cockpit page title (B-x4)", () => {
  it("carries the owner-waiting count in the window title", async () => {
    let seen: { title: string; windowTitle: string } | null = null;
    const Probe = () => { seen = useCockpitPageTitle(); return null; };
    const slot = renderSlot({ component: Probe } as never, {}, {
      context: { projectId: "proj_1", threadId: null },
      rpc: { owner_waiting: () => ({ items: [{}, {}] }) },
    });
    await waitFor(() => expect(seen?.windowTitle).toContain("(2)"));
    expect(seen!.title).toBeTruthy();
    expect(seen!.windowTitle).toBe(`(2) ${seen!.title}`);
    slot.lifecycle.unmount();
  });
});
