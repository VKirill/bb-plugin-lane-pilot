import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeWorkflowFile } from "../../src/rooms/host-worker/host-handlers";
import { casWriteWorkflowFile, sha256Text } from "@lane-pilot/workflow-engine";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-wff-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("writing a chain file", () => {
  it("creates it whole, replaces only the version it last saw, and leaves no temp file", async () => {
    const dir = join(temp(), "workflows");
    const first = await casWriteWorkflowFile(dir, "demo", "{\"v\":1}\n", null);
    expect(first).toMatchObject({ status: "applied", beforeSha256: null, afterSha256: sha256Text("{\"v\":1}\n") });
    expect(await casWriteWorkflowFile(dir, "demo", "{\"v\":2}\n", null)).toMatchObject({ status: "conflict" });
    expect(await casWriteWorkflowFile(dir, "demo", "{\"v\":2}\n", sha256Text("{\"v\":0}\n"))).toMatchObject({ status: "conflict" });
    expect(await casWriteWorkflowFile(dir, "demo", "{\"v\":2}\n", first.afterSha256)).toMatchObject({ status: "applied" });
    expect(readFileSync(join(dir, "demo.json"), "utf8")).toBe("{\"v\":2}\n");
    expect(readdirSync(dir)).toEqual(["demo.json"]);
    await expect(casWriteWorkflowFile(dir, "../escape", "{}", null)).rejects.toThrow(/not a file name/);
  });

  it("the host writes into the project's .lane-pilot/workflows and refuses a folder that is a link out of the project", async () => {
    const project = temp();
    const done = await writeWorkflowFile({ requestedHostId: "h", projectCwd: project, id: "demo", content: "{\"a\":1}\n", expectedSha256: null }, undefined as never);
    expect(done).toMatchObject({ status: "applied", path: ".lane-pilot/workflows/demo.json" });
    expect(readFileSync(join(project, ".lane-pilot", "workflows", "demo.json"), "utf8")).toBe("{\"a\":1}\n");
    const outside = temp(), hijacked = temp();
    mkdirSync(join(hijacked, ".lane-pilot"));
    symlinkSync(outside, join(hijacked, ".lane-pilot", "workflows"));
    await expect(writeWorkflowFile({ requestedHostId: "h", projectCwd: hijacked, id: "demo", content: "{}\n", expectedSha256: null }, undefined as never)).rejects.toThrow(/real directory/);
    expect(readdirSync(outside)).toEqual([]);
    writeFileSync(join(project, ".lane-pilot", "workflows", "other.json"), "mine");
    expect(await writeWorkflowFile({ requestedHostId: "h", projectCwd: project, id: "other", content: "{}\n", expectedSha256: null }, undefined as never)).toMatchObject({ status: "conflict" });
  });
});
