import { describe, expect, it } from "vitest";
import { resolveWriterBinding } from "../src/rooms/native-agent/project-binding";

describe("resolveWriterBinding", () => {
  it("rejects a same-host foreign-project environment with a different path", () => {
    const resolved = resolveWriterBinding({
      projectId: "proj_a",
      sources: [
        { hostId: "host-1", path: "/work/a", projectId: "proj_a" },
        { hostId: "host-1", path: "/work/b", projectId: "proj_b" },
      ],
      session: { environmentId: "env-b", projectId: "proj_b" },
      environment: {
        id: "env-b",
        hostId: "host-1",
        path: "/work/b",
        status: "ready",
        projectId: "proj_b",
      },
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.source).toBe("unique_source");
    expect(resolved.path).toBe("/work/a");
    expect(resolved.hostId).toBe("host-1");
  });

  it("takes the default folder of a project with several folders", () => {
    const resolved = resolveWriterBinding({
      projectId: "proj_a",
      sources: [
        { hostId: "host-1", path: "/work/a", isDefault: true },
        { hostId: "host-2", path: "/work/a2", isDefault: false },
      ],
    });
    expect(resolved).toMatchObject({ status: "resolved", hostId: "host-1", path: "/work/a" });
  });

  it("keeps a project with several folders and no single default ambiguous", () => {
    const resolved = resolveWriterBinding({
      projectId: "proj_a",
      sources: [
        { hostId: "host-1", path: "/work/a" },
        { hostId: "host-2", path: "/work/a2" },
      ],
    });
    expect(resolved.status).toBe("ambiguous");
  });

  it("lets a picked folder override the default one", () => {
    const resolved = resolveWriterBinding({
      projectId: "proj_a",
      sources: [
        { hostId: "host-1", path: "/work/a", isDefault: true },
        { hostId: "host-2", path: "/work/a2" },
      ],
      selected: { hostId: "host-2", path: "/work/a2" },
    });
    expect(resolved).toMatchObject({ status: "resolved", hostId: "host-2", path: "/work/a2" });
  });
});
