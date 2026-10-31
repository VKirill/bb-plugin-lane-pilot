import { spawnSync } from "node:child_process";
import { chmod, readFile, mkdtemp, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeAgentTrash, ownedAgentTrashPath } from "../src/rooms/writer/agent-trash";
import incidents from "./fixtures/native-install-agent-trash-2026-10-30.json";

const moduleUrl = pathToFileURL(join(__dirname, "../src/rooms/writer/agent-trash.ts")).href;

describe("bundled agent-trash", () => {
  it.each(incidents)("installs from the single-file host artifact on $hostId at $ts", async ({ sourcePath }) => {
    const home = await mkdtemp(join(tmpdir(), "lp-trash-artifact-"));
    const artifactUrl = pathToFileURL(sourcePath.replace(/lane-stack\/bin\/agent-trash$/, "host.mjs")).href;
    const result = await materializeAgentTrash({ homeDir: home, moduleUrl: artifactUrl });
    expect(await readFile(result.path, "utf8")).toBe(await readFile(join(__dirname, "../lane-stack/bin/agent-trash"), "utf8"));
    expect((await stat(result.path)).mode & 0o777).toBe(0o755);
    expect(spawnSync("python3", [result.path, "-f", join(home, "missing")]).status).toBe(0);
    expect(await materializeAgentTrash({ homeDir: home, moduleUrl: artifactUrl })).toMatchObject({ changed: false });
  });

  it("keeps explicit source validation and preserves a symlink at the destination", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-trash-source-"));
    const source = join(home, "custom-trash");
    await writeFile(source, "#!/bin/sh\nexit 0\n");
    const link = join(home, "source-link");
    await symlink(source, link);
    await expect(materializeAgentTrash({ homeDir: home, moduleUrl, sourcePath: link })).rejects.toThrow("source is not a regular file");
    const installed = await materializeAgentTrash({ homeDir: home, moduleUrl, sourcePath: source });
    expect(await readFile(installed.path, "utf8")).toBe(await readFile(source, "utf8"));
    const otherHome = await mkdtemp(join(tmpdir(), "lp-trash-link-"));
    const other = await materializeAgentTrash({ homeDir: otherHome, moduleUrl });
    await unlink(other.path);
    await symlink(source, other.path);
    await expect(materializeAgentTrash({ homeDir: otherHome, moduleUrl })).rejects.toThrow("was preserved");
    expect(await readFile(source, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("does not follow a pre-existing staging symlink during an upgrade", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-trash-stage-"));
    const installed = await materializeAgentTrash({ homeDir: home, moduleUrl });
    await writeFile(installed.path, "older copy\n");
    const preserved = join(home, "preserved");
    await writeFile(preserved, "keep this\n");
    await symlink(preserved, `${installed.path}.next`);
    expect(await materializeAgentTrash({ homeDir: home, moduleUrl })).toMatchObject({ changed: true });
    expect(await readFile(preserved, "utf8")).toBe("keep this\n");
  });

  it("copies the script, treats a missing path with -f as success, and replaces an older copy with the bundled one (Lane Pilot owns it)", async () => {
    const home = await mkdtemp(join(tmpdir(), "lp-trash-"));
    const first = await materializeAgentTrash({ homeDir: home, moduleUrl });
    expect(first).toEqual({ path: ownedAgentTrashPath(home), changed: true });
    const missing = spawnSync("python3", [first.path, "-f", join(home, "no-such-file")], { encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(await materializeAgentTrash({ homeDir: home, moduleUrl })).toMatchObject({ changed: false });
    await writeFile(first.path, "diverged\n");
    await chmod(first.path, 0o755);
    expect(await materializeAgentTrash({ homeDir: home, moduleUrl })).toMatchObject({ changed: true });
    expect(await readFile(first.path, "utf8")).not.toBe("diverged\n");
  });
});
