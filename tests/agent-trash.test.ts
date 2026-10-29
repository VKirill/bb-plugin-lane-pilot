import { spawnSync } from "node:child_process";
import { chmod, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeAgentTrash, ownedAgentTrashPath } from "../src/rooms/writer/agent-trash";

const moduleUrl = pathToFileURL(join(__dirname, "../src/rooms/writer/agent-trash.ts")).href;

describe("bundled agent-trash", () => {
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
