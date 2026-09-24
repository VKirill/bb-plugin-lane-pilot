import { describe, expect, it } from "vitest";
import { resolveWriterBinding } from "../src/project-binding";

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
});
