import { describe, expect, it } from "vitest";
import { writerLeftWorktree } from "../src/rooms/writer/server/left-worktree";

const notFound = (): Error & { code: string } => Object.assign(new Error("HTTP 404: no such thread"), { code: "thread_not_found" });

describe("writerLeftWorktree", () => {
  it("a gone thread reads as null (the writer stays put)", async () => {
    const sdk = { threads: { get: async () => { throw notFound(); } }, environments: { get: async () => ({}) } };
    await expect(writerLeftWorktree(sdk as never, "t", "/w")).resolves.toBe(null);
  });

  it("a transport failure surfaces instead of reading as 'stays put'", async () => {
    const sdk = { threads: { get: async () => { throw new Error("offline"); } }, environments: { get: async () => ({}) } };
    await expect(writerLeftWorktree(sdk as never, "t", "/w")).rejects.toThrow("offline");
  });
});
