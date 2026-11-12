import { describe, expect, it } from "vitest";
import { createAutonomy } from "../../src/rooms/learning/autonomy";
import { getItem, insertItem, type Item } from "../../src/rooms/learning/store";
import { NOW, database } from "./helpers";

describe("learning without the owner", () => {
  it("accepts what waited for the owner's yes; the server saves the global preference itself", async () => {
    const db = database();
    const base: Item = { id: "lrn_g", obsId: "thr_a:1:0", projectId: "proj_1", threadId: "thr_a", kind: "preference", text: "Always answer in Russian", audience: "both", reach: "owner", dueAt: null,
      state: "pending_owner", target: "bb-memory", evidence: "owner message thr_a:1:0", duplicateOf: null, confirmations: 0, note: null, createdAt: NOW, decidedAt: null, announcedAt: null };
    insertItem(db, base);
    insertItem(db, { ...base, id: "lrn_d", kind: "deadline", reach: "project", target: "reminder", text: "Release on Friday" });
    const autonomy = createAutonomy({
      db, log: () => {},
      decisions: { accept: async (id) => ({ item: { ...getItem(db, id)!, state: "accepted", ...(id === "lrn_g" ? { target: "bb-memory:mem_1" } : {}) }, ...(id === "lrn_g" ? { note: "Saved as a global preference (mem_1)." } : {}) }) },
    });
    const settled = await autonomy.settleWaiting();
    expect(settled.map((row) => row.id).sort()).toEqual(["lrn_d", "lrn_g"]);
  });

  it("leaves an item for the owner's own word when the project asks for it", async () => {
    const db = database();
    insertItem(db, { id: "lrn_w", obsId: "thr_a:2:0", projectId: "proj_1", threadId: "thr_a", kind: "deadline", text: "Release on Friday", audience: null, reach: "project", dueAt: NOW,
      state: "pending_owner", target: "reminder", evidence: "owner message thr_a:2:0", duplicateOf: null, confirmations: 0, note: null, createdAt: NOW, decidedAt: null, announcedAt: null });
    const autonomy = createAutonomy({ db, log: () => {}, ownerWords: () => true, decisions: { accept: async () => { throw new Error("must not be called"); } } });
    expect(await autonomy.settleWaiting()).toEqual([]);
  });
});
