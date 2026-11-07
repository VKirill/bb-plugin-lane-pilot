import { describe, expect, it } from "vitest";
import { ToolError } from "../src/rooms/contracts/server";
import { requirePmThread, requirePmThreadRun } from "../src/rooms/platform/server";

const bb = {} as never;
const pmThread = { threadId: "thr_pm", experimental_vkPluginMetadata: { role: "pm" } };

describe("the PM-thread check the PM-only tools share", () => {
  it("accepts a PM thread that names no run, for a tool that acts on the thread itself", async () => {
    await expect(requirePmThread(bb, pmThread)).resolves.toBeUndefined();
  });

  it("refuses a PM thread that names no run, for a tool that acts on its run", async () => {
    await expect(requirePmThreadRun(bb, pmThread)).rejects.toThrow(ToolError);
  });

  it("returns the run id of a PM thread that has one", async () => {
    await expect(requirePmThreadRun(bb, { threadId: "thr_pm", experimental_vkPluginMetadata: { role: "pm", lanePilotRunId: "lprun_1" } })).resolves.toBe("lprun_1");
  });

  it("refuses a thread that is not a PM thread at all", async () => {
    const writer = { threadId: "thr_w", experimental_vkPluginMetadata: { role: "writer" } };
    for (const check of [requirePmThread, requirePmThreadRun]) {
      const thrown = await check(bb, writer).then(() => null, (cause: unknown) => cause);
      expect(thrown).toBeInstanceOf(ToolError);
      expect((thrown as ToolError).code).toBe("not_pm_thread");
    }
  });
});
