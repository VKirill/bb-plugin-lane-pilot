import { describe, expect, it } from "vitest";
import { employeeRoleLines, withRoleLines } from "../src/rooms/native-agent";

const compiled = { description: "3D artist", prompt: "You model game assets.", tools: ["Bash"], skills: ["blender-director"] };

describe("withRoleLines", () => {
  it("appends the dated-lines block to the role prompt", () => {
    const next = withRoleLines(compiled as never, ["2026-10-30: triangulate on export", "2026-10-29: keep under 20k tris"]);
    expect(next.prompt).toContain("Lines added to your role");
    expect(next.prompt).toContain("triangulate on export");
    expect(next.prompt).toContain("keep under 20k tris");
  });
  it("returns the profile untouched with no lessons", () => {
    expect(withRoleLines(compiled as never, [])).toEqual(compiled);
  });
});

describe("employeeRoleLines", () => {
  it("resolves an empty list until the role-memory seam lands (swe/empmem)", async () => {
    await expect(employeeRoleLines(null, "proj_x", "3d-artist")).resolves.toEqual([]);
  });
});
