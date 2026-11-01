import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LEAD_MD, identityBlock, leadDir, loadIdentity, sha256, writeRoadExport } from "../../src/rooms/lead/server/identity";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "lead-id-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.LANE_PILOT_LEAD_DIR; });

describe("the lead's identity file", () => {
  it("seeds LEAD.md once with the default text and reads it back with its sha", () => {
    const dir = fresh();
    const first = loadIdentity(dir);
    expect(first).toMatchObject({ seeded: true, text: DEFAULT_LEAD_MD, path: join(dir, "LEAD.md"), sha: sha256(DEFAULT_LEAD_MD) });
    expect(first.bytes).toBe(Buffer.byteLength(DEFAULT_LEAD_MD));
    const second = loadIdentity(dir);
    expect(second.seeded).toBe(false);
    expect(second.sha).toBe(first.sha);
  });

  it("follows the owner's edits: a changed file is a new sha and the block carries it", () => {
    const dir = fresh();
    loadIdentity(dir);
    writeFileSync(join(dir, "LEAD.md"), "# Штурман\n\nНикогда не трогать прод.\n", "utf8");
    const edited = loadIdentity(dir);
    expect(edited.sha).not.toBe(sha256(DEFAULT_LEAD_MD));
    const block = identityBlock(edited);
    expect(block.startsWith(`<lead_identity sha="${edited.sha.slice(0, 12)}"`)).toBe(true);
    expect(block).toContain("Никогда не трогать прод.");
    expect(block.endsWith("</lead_identity>")).toBe(true);
  });

  it("writes ROAD.md next to LEAD.md and honours LANE_PILOT_LEAD_DIR", () => {
    const dir = fresh();
    process.env.LANE_PILOT_LEAD_DIR = dir;
    expect(leadDir()).toBe(dir);
    const path = writeRoadExport("---\ntitle: ROAD\n---\n");
    expect(path).toBe(join(dir, "ROAD.md"));
    expect(readFileSync(path, "utf8")).toContain("title: ROAD");
    expect(loadIdentity().path).toBe(join(dir, "LEAD.md"));
  });
});
