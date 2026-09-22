import { describe, expect, it, vi } from "vitest";
import { spawnWithSeam } from "../src/spawn-seam";

describe("E5 spawn transport seam", () => {
  it("models server-created then response timeout", async () => {
    const send = vi.fn(async () => ({id:"thread_created"}));
    await expect(spawnWithSeam(send, "timeout_after_ack_created")).rejects.toMatchObject({code:"ETIMEDOUT"});
    expect(send).toHaveBeenCalledOnce();
  });
  it("models acknowledged transport with no created thread", async () => {
    const send = vi.fn(async () => ({id:"must_not_run"}));
    await expect(spawnWithSeam(send, "timeout_after_ack_not_created")).rejects.toMatchObject({code:"ETIMEDOUT"});
    expect(send).not.toHaveBeenCalled();
  });
});
