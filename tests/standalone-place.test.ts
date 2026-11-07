import { describe, expect, it } from "vitest";
import { projectFolder } from "../src/rooms/platform/server/standalone-place";
import type { ServerCore } from "../src/rooms/contracts/server";

const sources = [{ hostId: "host_macbook", path: "/Users/me/app" }, { hostId: "host_ovh", path: "/home/me/app" }];
const bbWith = (hosts: Array<{ id: string; status: string }> | Error) => ({ sdk: {
  projects: { get: async () => ({ id: "p", sources }) },
  hosts: { list: async () => { if (hosts instanceof Error) throw hosts; return hosts; } },
} }) as unknown as ServerCore["bb"];

describe("the folder a parentless helper starts in", () => {
  it("prefers the project's folder on a connected machine (the lead's first tick picked a MacBook that was off)", async () => {
    expect(await projectFolder(bbWith([{ id: "host_macbook", status: "disconnected" }, { id: "host_ovh", status: "connected" }]), "p")).toEqual({ hostId: "host_ovh", path: "/home/me/app" });
  });
  it("keeps the first folder when every machine is connected, when the hub lists none, or when the list fails", async () => {
    const first = { hostId: "host_macbook", path: "/Users/me/app" };
    expect(await projectFolder(bbWith([{ id: "host_macbook", status: "connected" }, { id: "host_ovh", status: "connected" }]), "p")).toEqual(first);
    expect(await projectFolder(bbWith([]), "p")).toEqual(first);
    expect(await projectFolder(bbWith(new Error("no hub")), "p")).toEqual(first);
  });
});
