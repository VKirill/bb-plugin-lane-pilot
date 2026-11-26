import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocsPages } from "../../src/rooms/host-worker";
import { parseDocsSettings } from "../../src/rooms/docs/models";

describe("living docs read-only inventory & settings policy", () => {
  it("inventories only regular Markdown files under docs and apps, never symlinked roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-pilot-docs-"));
    try {
      await mkdir(join(root, "docs"));
      await mkdir(join(root, "apps"));
      await mkdir(join(root, "src"));
      await mkdir(join(root, ".agents"));
      await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
      await writeFile(join(root, "apps", "app.md"), "# App\n");
      await writeFile(join(root, "src", "private.md"), "# Source\n");
      await writeFile(join(root, ".agents", "LESSONS.md"), "# Private\n");
      await symlink(join(root, ".agents"), join(root, "docs", "linked"));
      const result = await listDocsPages({ requestedHostId: "host-test", projectCwd: root }, undefined as never);
      expect(result.hostId).toBe("host-test");
      expect(result.pages.map((item) => item.path).sort()).toEqual(["apps/app.md", "docs/guide.md"]);
      expect(result.pages.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
      expect(result.pages.every((item) => Number.isInteger(item.modifiedAt))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses only supported controls and applies the defaults", () => {
    // Unset means auto since 0.1.44: the folder's worthiness verdict decides per place.
    expect(parseDocsSettings({})).toEqual({ enabled: true, mode: "auto", maintain: true, since: "yesterday", pageCap: 0, hour: 5 });
    expect(parseDocsSettings({ "docs.enabled": "auto" })).toMatchObject({ enabled: true, mode: "auto" });
    expect(parseDocsSettings({ "docs.enabled": false })).toMatchObject({ enabled: false, mode: "off" });
    expect(parseDocsSettings({ "docs.enabled": "on", "docs.maintain": false, "docs.since": "7 days ago", "docs.page_cap": "8", "docs.hour": 23 }))
      .toEqual({ enabled: true, mode: "on", maintain: false, since: "7 days ago", pageCap: 8, hour: 23 });
    expect(() => parseDocsSettings({ "docs.hour": 24 })).toThrow("docs.hour");
    expect(() => parseDocsSettings({ "docs.since": "last month" })).toThrow("docs.since");
  });
});
