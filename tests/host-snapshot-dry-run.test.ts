import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotDryRun } from "../src/host-handlers";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lp-dry-")); });
afterEach(async () => { await rm(dir, { recursive:true, force:true }); });

describe("snapshotDryRun symlinks", () => {
  it("reports what a symlink points at, so a read_first alias of a file is accepted", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "x\n");
    await mkdir(join(dir, "folder"));
    await symlink("CLAUDE.md", join(dir, "AGENTS.md"));
    await symlink("folder", join(dir, "alias-dir"));
    await symlink("nowhere", join(dir, "dangling"));
    const paths = ["AGENTS.md", "alias-dir", "dangling", "CLAUDE.md"].map((name) => join(dir, name));
    const out = await snapshotDryRun({ requestedHostId:"h", paths } as never, {} as never);
    expect(out.entries.map((entry) => [entry.kind, (entry as { targetKind?:string }).targetKind])).toEqual([
      ["symlink", "file"], ["symlink", "directory"], ["symlink", "missing"], ["file", undefined],
    ]);
  });
});
