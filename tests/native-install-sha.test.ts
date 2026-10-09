import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_STACK_SHA, claudeLaneEnv } from "../src/rooms/native-install/native-install-bootstrap";
import { reconcileClaudeLane } from "../src/rooms/native-agent/native-lane-reconcile";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A host with an OpenCode config, a fake opencode binary, and a Lane Stack checkout holding the OpenCode profile. */
async function openCodeHost(guard: string) {
  const root = await mkdtemp(join(tmpdir(), "lp-sha-")); roots.push(root);
  const home = join(root, "home"), source = join(home, ".local/share/claude-lane-stack-installed");
  const profile = join(source, "profiles/opencode");
  await mkdir(join(profile, "opencode-lane"), { recursive: true }); await mkdir(join(profile, "commands"), { recursive: true }); await mkdir(join(profile, "agents"), { recursive: true });
  await writeFile(join(profile, "opencode-lane.ts"), "entry"); await writeFile(join(profile, "opencode-lane/guard.ts"), guard);
  await writeFile(join(profile, "commands/opencode-lane.md"), "command"); await writeFile(join(profile, "agents/lane-writer.md"), "writer");
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await writeFile(join(home, ".config/opencode/opencode.jsonc"), '{\n  "plugin": []\n}\n');
  await mkdir(join(home, "bin")); await writeFile(join(home, "bin/opencode"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { ...claudeLaneEnv(home), PATH: `${join(home, "bin")}:/usr/bin:/bin` };
  return { home, source, profile, env };
}

describe("native install pinned Lane Stack revision", () => {
  it("pins Lane Stack 45fa19e, the revision whose OpenCode guard allows writer-practices and karpathy-guidelines", () => {
    expect(NATIVE_STACK_SHA).toBe("45fa19eab528d92d8ce2744d49153ecb4133ea33");
    expect(NATIVE_STACK_SHA).not.toBe("c3a88d0dc829f20934f37ebe40ad01ba7bfe67c3");
  });

  it("re-copies the OpenCode guard from the checkout on reconcile, replacing a stale copy", async () => {
    const stale = 'export const allowed = ["ui-ux-pro-max"];';
    const fresh = 'export const allowed = ["ui-ux-pro-max", "writer-practices", "karpathy-guidelines"];';
    const { home, source, profile, env } = await openCodeHost(stale);
    expect((await reconcileClaudeLane({ home, source, env })).openCode).toBe("newly-registered");
    const installed = join(home, ".config/opencode/plugins/opencode-lane/guard.ts");
    expect(await readFile(installed, "utf8")).toBe(stale);

    // The bumped checkout carries the fixed guard; the next reconcile must copy it over the old one.
    await writeFile(join(profile, "opencode-lane/guard.ts"), fresh);
    expect((await reconcileClaudeLane({ home, source, env })).openCode).toBe("registered");
    expect(await readFile(installed, "utf8")).toBe(fresh);
    expect(await readFile(join(home, ".config/opencode/agents/lane-writer.md"), "utf8")).toBe("writer");
  });
});
