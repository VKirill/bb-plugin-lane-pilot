import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TARGET_SHA } from "../src/rooms/runs/constants";
import { hashPath } from "@lane-pilot/kit";
import { ownershipLedgerPath } from "../src/rooms/native-install/ownership";
import { installStack } from "../src/rooms/native-install/stack-ops";

const homes: string[] = [];
const hasTarget = (root: string): boolean => {
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${TARGET_SHA}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
};
/** A Lane Stack checkout that has the managed engine's commit: the job fixture, or the sibling source repository. */
const UPSTREAM_FIXTURE = [
  join(process.cwd(), "../../.agency/jobs/AG-252/tmp/upstream-ref"),
  join(process.cwd(), "../upstream-ref"),
  join(process.cwd(), "../claude-lane-stack"),
].find((root) => existsSync(root) && hasTarget(root));
const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lane-pilot-fault-integrity-"));
  homes.push(home);
  return home;
}

async function makeIncompatibleFallback(home: string): Promise<string> {
  if (!UPSTREAM_FIXTURE) throw new Error("A Lane Stack fixture with the target commit is unavailable.");
  const fallback = join(home, "dirty-source");
  execFileSync("git", ["clone", "--local", "--quiet", UPSTREAM_FIXTURE, fallback]);
  execFileSync("git", ["-C", fallback, "checkout", "--quiet", "--detach", TARGET_SHA]);
  const hook = join(fallback, "profiles/opencode/opencode-lane/v2.ts");
  const contents = await readFile(hook, "utf8");
  await writeFile(hook, contents.replaceAll('"execute.after"', '"execute.missing"'));
  return fallback;
}

async function treeHash(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; } catch { return null; }
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

// Needs a Lane Stack fixture with the target commit; on a clean clone it skips instead of crashing in makeIncompatibleFallback.
// deferral:dfr_seed_skip_fault_injection
describe.skipIf(!UPSTREAM_FIXTURE)("managed install metadata preflight", () => {
  it("rejects malformed ownership before rename and reports the unchanged write set", async () => {
    const home = await makeHome();
    const fallback = await makeIncompatibleFallback(home);
    const ledger = ownershipLedgerPath(home);
    await mkdir(join(home, ".agents/lane-pilot/coexistence"), { recursive: true });
    await writeFile(ledger, "{invalid\n");
    const claude = join(home, ".claude/settings.json");
    const openCode = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(claude, '{"env":{"KEEP":"yes"}}\n');
    await writeFile(openCode, '{"model":"user/model"}\n');
    const ordinaryBefore = { claude: await treeHash(claude), openCode: await treeHash(openCode) };

    const receipt = await installStack({
      requestedHostId: "host_test",
      homeDir: home,
      localFallbackPath: fallback,
      guardSourcePath: GUARD,
    });

    expect(receipt.status).toBe("failed");
    expect(receipt.exitCode).toBe(1);
    expect(receipt.filesChanged).toEqual([]);
    expect(receipt.notes.join("\n")).toContain("Ownership metadata preflight failed");
    expect(receipt.notes.join("\n")).not.toContain("failed before a write");
    expect(await treeHash(join(home, ".agents/lane-pilot/engines", TARGET_SHA))).toBeNull();
    expect(await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => [])).toEqual([]);
    expect(await readFile(ledger, "utf8")).toBe("{invalid\n");
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);
  }, 180_000);
});
