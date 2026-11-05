/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { downloadBlob } from "../src/rooms/workflow/ui/workflow-download";

vi.mock("../src/rooms/workflow/ui/workflow-download", () => ({ downloadBlob: vi.fn() }));
configure({ asyncUtilTimeout: 10_000 });
afterEach(() => { cleanup(); setLocaleOverride(null); vi.clearAllMocks(); });

async function mount(rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { ExportGraphsButton } = await import("../src/rooms/workflow/ui/workflow-export");
  return renderSlot({ component: () => <ExportGraphsButton locale="en" projectId={null} {...props} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

const output = {
  manifest: { lanePilotVersion: "0.0.0", commit: null, exportedAt: "2026-11-06T00:00:00.000Z", redacted: true, graphs: [{ id: "errand", version: 1, category: "routines", scope: "builtin" }] },
  files: [{ path: "workflows/errand.json", text: "{}\n" }],
  markdown: "# Lane Pilot graphs",
};

describe("ExportGraphsButton", () => {
  it("opens a dialog with what/format/redact options and exports the chosen rows", async () => {
    const calls: unknown[] = [];
    const rpc = { workflow_export: async (input: unknown) => { calls.push(input); return output; } };
    const slot = await mount(rpc, { selectedIds: ["errand", "debug"] });
    fireEvent.click(slot.getByTestId("wfx-open"));
    await slot.findByTestId("wfx-dialog");
    expect((slot.getByTestId("wfx-what-selected") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(slot.getByTestId("wfx-what-selected"));
    fireEvent.click(slot.getByTestId("wfx-format-md"));
    fireEvent.click(slot.getByTestId("wfx-download"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ ids: ["errand", "debug"], redact: true, includeProjectGraphs: false });
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledWith(expect.stringMatching(/^lane-pilot-graphs-.*\.md$/), expect.any(Blob));
  });

  it("disables «Selected» when nothing is selected and sends a category when asked", async () => {
    const calls: unknown[] = [];
    const rpc = { workflow_export: async (input: unknown) => { calls.push(input); return output; } };
    const slot = await mount(rpc, { categories: [{ key: "seo", label: "SEO" }] });
    fireEvent.click(slot.getByTestId("wfx-open"));
    await slot.findByTestId("wfx-dialog");
    expect((slot.getByTestId("wfx-what-selected") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(slot.getByTestId("wfx-what-category"));
    fireEvent.click(slot.getByTestId("wfx-redact")); // uncheck
    fireEvent.click(slot.getByTestId("wfx-include-project")); // check
    fireEvent.click(slot.getByTestId("wfx-download"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ category: "seo", redact: false, includeProjectGraphs: true });
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledWith(expect.stringMatching(/\.zip$/), expect.any(Blob));
  });
});
