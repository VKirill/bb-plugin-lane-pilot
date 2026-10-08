import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCODE_BASH_DENY, withBashDeny } from "../src/rooms/native-install/opencode-min-config";
import { BB_SHIM_NAMES, prepareBbShim } from "../src/rooms/native-agent/bb-shim";

// Audit 2026-10-08 round 3, P0-2: Codex, OpenCode and Cursor writers run `bb` through guard wrappers at the front of PATH (since the owner decision of 2026-10-08 they stop only plugin admin and the hub).
const temp = () => mkdtempSync(join(tmpdir(), "bb-shim-"));

async function setup() {
  const dataDir = temp();
  const real = temp();
  for (const name of BB_SHIM_NAMES) {
    writeFileSync(join(real, name), `#!/bin/sh\necho "REAL ${name} $*"\n`);
    chmodSync(join(real, name), 0o755);
  }
  const shim = await prepareBbShim({ dataDir, path: `${real}:/usr/bin:/bin` });
  const run = (program: string, ...args: string[]) => spawnSync(join(shim.dir, program), args, { encoding: "utf8", env: { PATH: shim.path, HOME: dataDir } });
  return { shim, real, run, dataDir };
}

describe("the PATH wrappers of a Codex, OpenCode or Cursor helper", () => {
  it("writes executable wrappers under the data dir and puts them first on PATH, once", async () => {
    const { shim, dataDir, real } = await setup();
    expect(shim.dir).toBe(join(dataDir, "bb-shim"));
    expect(shim.path.split(":")[0]).toBe(shim.dir);
    for (const name of BB_SHIM_NAMES) expect(statSync(join(shim.dir, name)).mode & 0o111).not.toBe(0);
    const again = await prepareBbShim({ dataDir, path: shim.path });
    expect(again.path).toBe(shim.path);
    expect(again.path.split(":").filter((part) => part === shim.dir)).toHaveLength(1);
    expect(shim.path).toContain(real);
  });

  const DENIED: Array<[string, string[]]> = [
    ["bb", ["plugin", "config", "lane-pilot", "set", "x", "y"]],
    ["bb", ["plugin", "token", "lane-pilot"]],
    ["bb", ["plugin", "disable", "lane-pilot"]],
    ["bb", ["plugin", "enable", "lane-pilot"]],
    ["bb", ["plugin", "reload", "lane-pilot"]],
    ["bb", ["plugin", "remove", "lane-pilot"]],
    ["bb", ["plugin", "safe-mode", "on"]],
    ["ssh", ["ovh-main", "cat ~/.bb/master.key"]],
    ["ssh", ["-i", "k", "ubuntu@10.8.0.1", "id"]],
    ["ssh", ["54.37.129.153"]],
    ["scp", ["ovh-main:~/.bb/plugins/env-catalog/data.db", "/tmp/x"]],
    ["sftp", ["vechkasov-ovh"]],
    ["ssh", ["-o", "StrictHostKeyChecking=no", "selfystudio-work", "ls"]],
  ];
  for (const [program, args] of DENIED) {
    it(`refuses ${program} ${args.join(" ")}`, async () => {
      const { run } = await setup();
      const res = run(program, ...args);
      expect(res.status).toBe(126);
      expect(res.stderr).toContain("[hub-guard]");
      expect(res.stdout).not.toContain("REAL");
    });
  }

  const ALLOWED: Array<[string, string[]]> = [
    ["bb", ["plugin", "list"]],
    ["bb", ["plugin", "logs", "lane-pilot"]],
    ["bb", ["plugin", "rpc", "call", "lane-pilot", "get_run", "--input", "{}"]],
    ["bb", ["env-catalog", "list"]],
    ["bb", ["env-catalog", "get", "OPENAI_API_KEY"]],
    ["bb", ["env-catalog", "request", "NEW_KEY"]],
    ["bb", ["env-catalog", "set", "A", "secret"]],
    ["bb", ["env-catalog", "delete", "A"]],
    ["bb", ["env-catalog", "export", "--format", "json"]],
    ["bb", ["env-catalog", "get", "OPENAI_API_KEY", "--raw"]],
    ["bb", ["plugin", "rpc", "call", "env-catalog", "env_delete", "--input", "{\"name\":\"A\"}"]],
    ["bb", ["plugin", "rpc", "call", "lane-pilot", "save_setting", "--input", "{}"]],
    ["bb", ["lane-pilot", "schedule", "create", "{}"]],
    ["bb", ["lane-pilot", "anamnesis", "forget", "--all", "--yes"]],
    ["bb", ["lane-pilot", "configure", "--set", "x=1"]],
    ["bb", ["threads", "message", "thr_1", "please do not plugin reload or env-catalog set anything"]],
    ["bb", ["thread", "list", "--json"]],
    ["ssh", ["vast", "nvidia-smi"]],
    ["scp", ["a.txt", "vast:/tmp/a.txt"]],
  ];
  for (const [program, args] of ALLOWED) {
    it(`runs the real ${program} ${args.join(" ")}`, async () => {
      const { run } = await setup();
      const res = run(program, ...args);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(`REAL ${program} ${args.join(" ")}`);
    });
  }

  it("never runs itself when there is no real program, and says so", async () => {
    const dataDir = temp();
    const shim = await prepareBbShim({ dataDir, path: "/nonexistent-dir-a:/nonexistent-dir-b" });
    const res = spawnSync(join(shim.dir, "bb"), ["plugin", "list"], { encoding: "utf8", env: { PATH: shim.path } });
    expect(res.status).toBe(127);
    expect(res.stderr).toContain("bb: command not found");
  });

  it("finds the real program behind a PATH with an empty entry and a glob character", async () => {
    const { shim, real } = await setup();
    const odd = join(temp(), "x*y");
    mkdirSync(odd, { recursive: true });
    const res = spawnSync(join(shim.dir, "bb"), ["plugin", "list"], { encoding: "utf8", env: { PATH: `${shim.dir}::${odd}:${real}` } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("REAL bb plugin list");
  });
});

describe("the OpenCode bash permission rules", () => {
  it("add the deny list after what the machine's config allows", () => {
    const merged = withBashDeny({ bash: { "git push*": "ask", "*": "allow" }, edit: "allow" }) as { bash: Record<string, string>; edit: string };
    expect(merged.edit).toBe("allow");
    expect(merged.bash["git push*"]).toBe("ask");
    const keys = Object.keys(merged.bash);
    expect(merged.bash["*bb plugin reload*"]).toBe("deny");
    expect(merged.bash["*ssh *ovh-main*"]).toBe("deny");
    // Env Catalog and Lane Pilot's own commands are not fenced any more (owner decision 2026-10-08).
    expect(OPENCODE_BASH_DENY.filter((pattern) => /env-catalog|lane-pilot|rpc/.test(pattern))).toEqual([]);
    // last match wins in OpenCode: every deny stands after the machine's own catch-all
    expect(keys.indexOf("*bb plugin reload*")).toBeGreaterThan(keys.indexOf("*"));
    expect(OPENCODE_BASH_DENY.every((pattern) => merged.bash[pattern] === "deny")).toBe(true);
  });

  it("copes with a string rule, a global string and no permission at all", () => {
    expect((withBashDeny({ bash: "allow" }) as { bash: Record<string, string> }).bash["*"]).toBe("allow");
    const globalString = withBashDeny("allow") as unknown as Record<string, unknown>;
    expect(globalString["*"]).toBe("allow");
    expect((globalString.bash as Record<string, string>)["*bb plugin token*"]).toBe("deny");
    expect((withBashDeny(undefined) as { bash: Record<string, string> }).bash["*bb plugin config*"]).toBe("deny");
  });

  it("are written into the minimal config home", async () => {
    const { prepareOpencodeMinimal } = await import("../src/rooms/native-install/opencode-min-config");
    const home = temp();
    const real = join(home, ".config", "opencode");
    mkdirSync(join(real, "plugins"), { recursive: true });
    writeFileSync(join(real, "opencode.json"), JSON.stringify({ plugin: ["cursor-acp", "./plugins/opencode-lane.ts"], agent: { x: {} }, permission: { bash: { "*": "allow" } } }));
    writeFileSync(join(real, "plugins", "opencode-lane.ts"), "export default {}");
    const result = await prepareOpencodeMinimal({ home, dataDir: temp(), model: null, env: {} });
    expect(result).not.toBeNull();
    const config = JSON.parse(readFileSync(join(result!.configHome, "opencode", "opencode.json"), "utf8")) as { permission: { bash: Record<string, string> } };
    expect(config.permission.bash["*"]).toBe("allow");
    expect(config.permission.bash["*bb plugin remove*"]).toBe("deny");
  });
});
