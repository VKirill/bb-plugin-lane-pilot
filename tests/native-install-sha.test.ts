import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_STACK_SHA, claudeLaneEnv } from "../src/rooms/native-install/native-install-bootstrap";
import { NATIVE_OPENCODE_SOURCES } from "../src/rooms/native-install/native-opencode-sources";
import { reconcileClaudeLane } from "../src/rooms/native-agent/native-lane-reconcile";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A host with an OpenCode config, a fake opencode2 binary, and a Lane Stack checkout holding the OpenCode profile. */
async function openCodeHost(guard: string) {
  const root = await mkdtemp(join(tmpdir(), "lp-sha-")); roots.push(root);
  const home = join(root, "home"), source = join(home, ".local/share/claude-lane-stack-installed");
  const profile = join(source, "profiles/opencode");
  await mkdir(join(profile, "opencode-lane"), { recursive: true }); await mkdir(join(profile, "commands"), { recursive: true }); await mkdir(join(profile, "agents"), { recursive: true });
  await writeFile(join(profile, "opencode-lane.ts"), "entry"); await writeFile(join(profile, "opencode-lane/guard.ts"), guard);
  await writeFile(join(profile, "commands/opencode-lane.md"), "command"); await writeFile(join(profile, "agents/lane-writer.md"), "writer");
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  await writeFile(join(home, ".config/opencode/opencode.jsonc"), '{\n  "plugin": []\n}\n');
  await mkdir(join(home, "bin")); await writeFile(join(home, "bin/opencode2"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { ...claudeLaneEnv(home), PATH: `${join(home, "bin")}:/usr/bin:/bin` };
  return { home, source, profile, env };
}

describe("native install pinned Lane Stack revision", () => {
  it("pins Lane Stack 1.66.0 (8cfe994), the first whose OpenCode plugin loads in OpenCode v2", () => {
    expect(NATIVE_STACK_SHA).toBe("6acbe4a3030750e5d10bfe71233653dc1c99a333");
    expect(NATIVE_STACK_SHA).not.toBe("b9dd6473bbbe772d39a317486979b075635e63b5");
  });

  it("writes the bundled OpenCode plugin and ignores a mutated checkout", async () => {
    const { home, source, profile, env } = await openCodeHost("from-checkout");
    expect((await reconcileClaudeLane({ home, source, env })).openCode).toBe("newly-registered");
    const installed = join(home, ".config/opencode/opencode-lane/guard.ts");
    expect(await readFile(installed, "utf8")).toBe(NATIVE_OPENCODE_SOURCES["opencode-lane/guard.ts"]);
    await writeFile(join(profile, "opencode-lane/guard.ts"), "mutated");
    expect((await reconcileClaudeLane({ home, source, env })).openCode).toBe("registered");
    expect(await readFile(installed, "utf8")).toBe(NATIVE_OPENCODE_SOURCES["opencode-lane/guard.ts"]);
    expect(await readFile(join(home, ".config/opencode/agents/lane-pilot.md"), "utf8")).toBe(NATIVE_OPENCODE_SOURCES["agents/lane-pilot.md"]);
  });

  it("lays the plugin out for OpenCode v2: modules beside plugins/, the entry pointing one level up, no v1 folder", async () => {
    const { home, source, env } = await openCodeHost("guard");
    await mkdir(join(home, ".config/opencode/plugins/opencode-lane"), { recursive: true });
    await writeFile(join(home, ".config/opencode/plugins/opencode-lane/old.ts"), "v1");
    await mkdir(join(home, ".config/opencode/opencode-lane"), { recursive: true });
    await writeFile(join(home, ".config/opencode/opencode-lane/removed.ts"), "gone upstream");
    await reconcileClaudeLane({ home, source, env });
    expect(await readFile(join(home, ".config/opencode/plugins/opencode-lane.ts"), "utf8")).toBe(
      NATIVE_OPENCODE_SOURCES["opencode-lane.ts"]!.replaceAll('"./opencode-lane/', '"../opencode-lane/'),
    );
    expect(await readFile(join(home, ".config/opencode/opencode-lane/guard.ts"), "utf8")).toBe(NATIVE_OPENCODE_SOURCES["opencode-lane/guard.ts"]);
    await expect(readFile(join(home, ".config/opencode/opencode-lane/removed.ts"))).rejects.toThrow();
    await expect(readFile(join(home, ".config/opencode/plugins/opencode-lane/old.ts"))).rejects.toThrow();
  });

  it("leaves a machine without OpenCode v2 alone", async () => {
    const { home, source, env } = await openCodeHost("guard");
    await rm(join(home, "bin/opencode2"));
    expect((await reconcileClaudeLane({ home, source, env })).openCode).toBe("absent");
  });
});
