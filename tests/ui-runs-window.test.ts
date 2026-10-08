import { describe, expect, it } from "vitest";
import { RUNS_MAX_LIMIT, readRunsWindow } from "../src/ui/runs-window";
import { rpcContract } from "../src/contracts";

// Audit 2026-10-08 round 4, item 22: the runs panel re-read its loaded window with one `list_runs` of `limit = window`; after ten
// "show more" (10 + 20 x 10 = 210) the contract's 200 refused every call, the error was swallowed and the panel stopped refreshing.
function server(total: number, open: string[] = []) {
  const calls: Array<{ offset: number; limit: number; pinOpen?: boolean }> = [];
  const call = async (_method: "list_runs", input: { offset: number; limit: number; pinOpen?: boolean; projectId: string }) => {
    if (input.limit > RUNS_MAX_LIMIT) throw new Error("limit above the contract");
    calls.push({ offset: input.offset, limit: input.limit, pinOpen: input.pinOpen });
    const ids = Array.from({ length: total }, (_, index) => `run-${index}`);
    const page = ids.slice(input.offset, input.offset + input.limit);
    // `pinOpen` adds the open runs beyond the page, as the server does.
    const pinned = input.pinOpen ? open.filter((id) => !page.includes(id)) : [];
    return { runs: [...page, ...pinned].map((id) => ({ id })), total };
  };
  return { call, calls };
}

describe("re-reading the runs the panel has loaded", () => {
  it("keeps the page size in the contract's limit", () => {
    expect(RUNS_MAX_LIMIT).toBe(200);
    const shape = (rpcContract as unknown as { list_runs: { input: { safeParse(value: unknown): { success: boolean } } } }).list_runs.input;
    expect(shape.safeParse({ projectId: "p", offset: 0, limit: RUNS_MAX_LIMIT }).success).toBe(true);
    expect(shape.safeParse({ projectId: "p", offset: 0, limit: RUNS_MAX_LIMIT + 1 }).success).toBe(false);
  });

  it("reads a window of 450 runs in pages of at most 200, every run once, open runs pinned once", async () => {
    const { call, calls } = server(900, ["run-880"]);
    const page = await readRunsWindow({ call } as never, { projectId: "p" }, 450);
    expect(calls.map((item) => item.limit)).toEqual([200, 200, 50]);
    expect(calls.map((item) => item.offset)).toEqual([0, 200, 400]);
    expect(calls.map((item) => item.pinOpen)).toEqual([true, undefined, undefined]);
    expect(page.total).toBe(900);
    expect(page.runs).toHaveLength(451);
    expect(new Set(page.runs.map((run) => (run as { id: string }).id)).size).toBe(451);
  });

  it("a small window is one call, as before; an empty window still asks for one run", async () => {
    const { call, calls } = server(30);
    expect((await readRunsWindow({ call } as never, { projectId: "p" }, 20)).runs).toHaveLength(20);
    expect(calls).toHaveLength(1);
    await readRunsWindow({ call } as never, { projectId: "p" }, 0);
    expect(calls.at(-1)).toMatchObject({ limit: 1 });
  });

  it("stops when the history ends before the window does", async () => {
    const { call, calls } = server(230);
    const page = await readRunsWindow({ call } as never, { projectId: "p" }, 600);
    expect(calls).toHaveLength(2);
    expect(page.runs).toHaveLength(230);
  });
});
