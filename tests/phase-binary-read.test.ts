import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { runCommand } from "../src/rooms/host-worker/host-handlers";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { binaryFileCommand, binaryFileFingerprint } from "../src/rooms/phase/stages";
import { getPhase, savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase, setRunThread } from "../src/rooms/storage";

// Live ph_26f65b142d: lp.draw failed with «cannot read …/design/00-kit.png: lane_pilot_read_binary_rejected» although the PNG was the stage's own product.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0xff]);
const sha = createHash("sha256").update(PNG).digest("hex");

describe("the fingerprint of a binary file", () => {
  it("refuses a path that leaves the checkout and quotes one that does not", () => {
    expect(binaryFileCommand("../x.png")).toBeNull();
    expect(binaryFileCommand("/etc/passwd")).toBeNull();
    expect(binaryFileCommand("a/../b.png")).toBeNull();
    expect(binaryFileCommand("d/it's.png")).toContain(`'d/it'\\''s.png'`);
  });

  it("is read from what the command prints", () => {
    expect(binaryFileFingerprint(`${sha}  a.png\n18\n`)).toEqual({ sha256: sha, sizeBytes: 18 });
    expect(binaryFileFingerprint("")).toBeNull();
    expect(binaryFileFingerprint("sha256sum: a.png: No such file\n")).toBeNull();
  });

  it("matches the file on a real shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-bin-"));
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d", "it's.png"), PNG);
    const out = execFileSync("sh", ["-c", binaryFileCommand("d/it's.png")!], { cwd: dir, encoding: "utf8" });
    expect(binaryFileFingerprint(out)).toEqual({ sha256: sha, sizeBytes: PNG.length });
  });
});

describe("a drawing whose files include a PNG", () => {
  it("is recorded with the PNG's hash instead of failing the stage", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "lp-draw-"));
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
        if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
        throw new Error(`unexpected host method ${call.method}`);
      }) as never,
    });
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.list", async () => []);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", checkout, "none", undefined, "local");
    setRunThread(db, "run1", "thr_pm");
    const reads: string[] = [];
    const services = { readWriterWorkspaceFile: async (args: { path: string }) => {
      reads.push(args.path);
      if (args.path.endsWith(".png")) throw new Error("lane_pilot_read_binary_rejected");
      return { sha256: "t".repeat(64), sizeBytes: 5 };
    } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Kit", goal: "a kit" });
    savePhase(db, phase.id, { stage: "design", at: 1 });
    const folder = `.agents/phases/${phase.id}/design`;
    mkdirSync(join(checkout, folder), { recursive: true });
    writeFileSync(join(checkout, folder, "00-kit.png"), PNG);
    // The plan gate may still ask for more (a separate reviewer); what matters is that the PNG did not stop the report.
    await phases.drawing({ phaseId: phase.id, paths: [`${folder}/index.html`, `${folder}/00-kit.png`], designer: "d", feasible: true, by: "lp.draw" }).catch((cause: Error) => expect(cause.message).not.toMatch(/cannot read/));
    expect(reads).toContain(`${folder}/00-kit.png`);
    const drawn = getPhase(db, phase.id)!.record.design?.drawing;
    expect(drawn?.paths).toContain(`${folder}/00-kit.png`);
    const expected = createHash("sha256").update([`${folder}/index.html:${"t".repeat(64)}`, `${folder}/00-kit.png:${sha}`].join("\n")).digest("hex");
    expect(drawn?.sha256).toBe(expected);
  });
});
