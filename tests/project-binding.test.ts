import { describe, expect, it } from "vitest";
import { resolveWriterBinding } from "../src/rooms/native-agent/project-binding";
import incident from "./fixtures/learning-stale-binding-2026-10-30.json";

describe("resolveWriterBinding", () => {
  it("replays the learning failures: an obsolete prototype path cannot override current project folders", () => {
    expect(resolveWriterBinding(incident)).toMatchObject({
      status: "resolved", hostId: incident.sources[0]!.hostId, path: incident.sources[0]!.path,
      source: "unique_source", bindingId: incident.sources[0]!.id,
    });
  });

  it("keeps a legacy explicit workspace when the project has no sources", () => {
    expect(resolveWriterBinding({ ...incident, sources: [] })).toMatchObject({
      status: "resolved", ...incident.explicit, source: "explicit_override",
    });
  });

  it("keeps an explicit binding that matches a current non-default project folder", () => {
    const source = incident.sources[1]!;
    expect(resolveWriterBinding({ ...incident, explicit: source })).toMatchObject({
      status: "resolved", hostId: source.hostId, path: source.path, source: "explicit_override", bindingId: source.id,
    });
  });

  it("uses a selected folder when the prototype override is obsolete", () => {
    const source = incident.sources[1]!;
    expect(resolveWriterBinding({ ...incident, selected: source })).toMatchObject({
      status: "resolved", hostId: source.hostId, path: source.path, bindingId: source.id,
    });
  });

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
