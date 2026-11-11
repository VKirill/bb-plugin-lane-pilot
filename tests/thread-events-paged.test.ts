import { describe, expect, it } from "vitest";
import { listThreadEventsPaged, listThreadEventsRaw, THREAD_EVENTS_PAGE } from "@lane-pilot/thread-observe";

/** A stand-in for BB's events route: 400 past one page, as the live server answers (checked 2026-11-11: limit=101 → «Thread event limit cannot exceed 100»). */
function fakeBb(total: number) {
  const asked: Array<Record<string, string>> = [];
  const all = Array.from({ length: total }, (_, index) => ({ seq: index + 1 }));
  const list = async (query: Record<string, string>) => {
    asked.push({ ...query });
    if (Number(query.limit) > THREAD_EVENTS_PAGE) throw new Error("Thread event limit cannot exceed 100");
    let rows = query.order === "asc" ? [...all] : [...all].reverse();
    if (query.beforeSeq) rows = rows.filter((row) => row.seq < Number(query.beforeSeq));
    if (query.afterSeq) rows = rows.filter((row) => row.seq > Number(query.afterSeq));
    return rows.slice(0, Number(query.limit));
  };
  return { bb: { sdk: { threads: { events: { list } } } } as never, asked };
}
const seqs = (events: unknown) => (events as Array<{ seq: number }>).map((event) => event.seq);

describe("thread events past BB's page of 100", () => {
  it("newest first: 250 asked comes back as the newest 250 in order, no request above one page", async () => {
    const { bb, asked } = fakeBb(400);
    const listed = await listThreadEventsRaw(bb, { threadId: "thr_x", order: "desc", limit: "250" });
    expect(listed.ok && seqs(listed.events)).toEqual(Array.from({ length: 250 }, (_, index) => 400 - index));
    expect(asked.map((query) => query.limit)).toEqual(["100", "100", "50"]);
    expect(asked.map((query) => query.beforeSeq)).toEqual([undefined, "301", "201"]);
  });
  it("oldest first: a thread shorter than the limit ends at its short page", async () => {
    const { bb, asked } = fakeBb(130);
    expect(seqs(await listThreadEventsPaged(bb, { threadId: "thr_x", order: "asc", limit: "500" }))).toEqual(Array.from({ length: 130 }, (_, index) => index + 1));
    expect(asked.map((query) => query.afterSeq)).toEqual([undefined, "100"]);
  });
  it("one page or less is the single request it always was", async () => {
    const { bb, asked } = fakeBb(400);
    await listThreadEventsRaw(bb, { threadId: "thr_x", order: "desc", limit: "50", beforeSeq: "90" });
    expect(asked).toEqual([{ threadId: "thr_x", order: "desc", limit: "50", beforeSeq: "90" }]);
  });
});
