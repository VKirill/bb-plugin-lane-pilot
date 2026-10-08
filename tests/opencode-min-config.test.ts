import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepsPlugin, prepareOpencodeMinimal } from "../src/opencode-min-config";

// N1 (review 2): on OVH the global OpenCode config loads plugins that add ~21k tokens to every helper session. The helpers run with
// a config home of their own that keeps Lane Pilot's plugin and the auth plugin of the model's provider.
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-ocmin-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const CONFIG = `{
  // the machine's own config, with comments
  "$schema": "https://opencode.ai/config.json",
  "model": "router9/ag/gemini-3.8-flash-medium",
  "plugin": ["opencode-gemini-auth@latest", "./plugins/agentmemory-capture.ts", "@rama_nigg/open-cursor@latest", "cursor-acp", "./plugins/opencode-lane.ts"],
  "agent": { "wiki-linter": { "description": "x" } },
  "command": { "wiki-init": { "template": "y" } },
  "mcp": { "gitnexus": { "type": "local", "command": ["gitnexus", "mcp"] }, },
  "provider": { "router9": { "options": { "baseURL": "https://example.test/v1" } } },
}`;

function machine(config = CONFIG) {
  const home = temp();
  const real = join(home, ".config", "opencode");
  mkdirSync(join(real, "plugins", "opencode-lane"), { recursive: true });
  mkdirSync(join(real, "plugin"), { recursive: true });
  mkdirSync(join(real, "agents"), { recursive: true });
  mkdirSync(join(real, "node_modules"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(real, "opencode.json"), config);
  writeFileSync(join(real, "opencode.json.bak.1"), "{}");
  writeFileSync(join(real, "AGENTS.md"), "global rules");
  writeFileSync(join(real, "opencode-lane.jsonl"), "{}\n");
  writeFileSync(join(real, "package.json"), "{}");
  writeFileSync(join(real, "agents", "lane-writer.md"), "writer");
  writeFileSync(join(real, "plugins", "opencode-lane.ts"), "export default {}");
  writeFileSync(join(real, "plugins", "opencode-lane", "index.ts"), "export {}");
  writeFileSync(join(real, "plugins", "agentmemory-capture.ts"), "export default {}");
  writeFileSync(join(real, "plugin", "cursor-acp.js"), "module.exports = {}");
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "token");
  return { home, real, dataDir: temp() };
}

const names = (dir: string) => readdirSync(dir).sort();

describe("which plugins a helper thread keeps", () => {
  it("keeps Lane Pilot's plugin, the owner's list, every auth plugin and the plugin named for the model's provider, nothing else", () => {
    expect(keepsPlugin("./plugins/opencode-lane.ts", null, [])).toBe(true);
    // Auth plugins add no tools or text, and a helper whose provider's plugin was left out cannot sign in (B7).
    for (const auth of ["opencode-gemini-auth@latest", "opencode-openai-codex-auth", "opencode-anthropic-auth", "opencode-antigravity-auth", "some-oauth-plugin"]) {
      expect(keepsPlugin(auth, "router9", []), auth).toBe(true);
      expect(keepsPlugin(auth, null, []), `${auth} with no known model`).toBe(true);
    }
    expect(keepsPlugin("opencode-openai-codex", "openai", [])).toBe(true);
    expect(keepsPlugin("opencode-openai-codex", "router9", [])).toBe(false);
    expect(keepsPlugin("cursor-acp", "zai-coding-plan", [])).toBe(false);
    expect(keepsPlugin("cursor-acp", "cursor-acp", [])).toBe(true);
    expect(keepsPlugin("./plugins/agentmemory-capture.ts", "router9", [])).toBe(false);
    expect(keepsPlugin("./plugins/agentmemory-capture.ts", "router9", ["agentmemory"])).toBe(true);
  });
});

describe("the minimal config home", () => {
  it("is the machine's config without the other plugins, agents and commands, and links the rest", async () => {
    const { home, real, dataDir } = machine();
    const before = readFileSync(join(real, "opencode.json"), "utf8");
    const result = await prepareOpencodeMinimal({ home, dataDir, model: "router9/ag/gemini-3.8-flash-high", env: {} });
    expect(result).not.toBeNull();
    expect(result!.kept.sort()).toEqual(["./plugins/opencode-lane.ts", "opencode-gemini-auth@latest", "plugins/opencode-lane", "plugins/opencode-lane.ts"].sort());
    expect(result!.left).toEqual(expect.arrayContaining(["cursor-acp", "@rama_nigg/open-cursor@latest", "plugins/agentmemory-capture.ts", "plugin/cursor-acp.js"]));
    const dir = join(result!.configHome, "opencode");
    const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(config.plugin).toEqual(["opencode-gemini-auth@latest", "./plugins/opencode-lane.ts"]);
    expect(config).not.toHaveProperty("agent");
    expect(config).not.toHaveProperty("command");
    // The MCP names and providers stay: BB's session policy reads the servers it switches off from this file.
    expect(Object.keys(config.mcp as object)).toEqual(["gitnexus"]);
    expect(config.provider).toEqual({ router9: { options: { baseURL: "https://example.test/v1" } } });
    // Local plugins: only the kept one and the folder it imports from; the singular `plugin/` dir (auto-loaded) is not there.
    expect(names(join(dir, "plugins"))).toEqual(["opencode-lane", "opencode-lane.ts"]);
    expect(names(dir)).not.toContain("plugin");
    // What the kept plugin and the tools need is linked to the real thing; logs, backups and global rules are not carried.
    expect(names(dir)).toEqual(expect.arrayContaining(["agents", "node_modules", "opencode.json", "package.json", "plugins"]));
    expect(names(dir)).not.toContain("AGENTS.md");
    expect(names(dir).some((name) => name.includes("bak") || name.includes("jsonl"))).toBe(false);
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(real, "node_modules"));
    expect(readlinkSync(join(dir, "plugins", "opencode-lane.ts"))).toBe(join(real, "plugins", "opencode-lane.ts"));
    // The rest of the config home (git, gh ...) stays reachable for the tools a helper runs.
    expect(readlinkSync(join(result!.configHome, "gh"))).toBe(join(home, ".config", "gh"));
    expect(lstatSync(join(result!.configHome, "gh")).isSymbolicLink()).toBe(true);
    // The machine's own files are not touched.
    expect(readFileSync(join(real, "opencode.json"), "utf8")).toBe(before);
    expect(names(real)).toEqual(expect.arrayContaining(["AGENTS.md", "plugin", "plugins", "opencode.json.bak.1"]));
  });

  it("keeps the auth plugin whatever the model, so one config home serves every model of the machine", async () => {
    const { home, dataDir } = machine();
    const plain = await prepareOpencodeMinimal({ home, dataDir, model: "router9/x", env: {} });
    const google = await prepareOpencodeMinimal({ home, dataDir, model: "google/gemini-3-pro", env: {} });
    const unknown = await prepareOpencodeMinimal({ home, dataDir, model: null, env: {} });
    expect(google!.configHome).toBe(plain!.configHome);
    expect(unknown!.configHome).toBe(plain!.configHome);
    expect((JSON.parse(readFileSync(join(unknown!.configHome, "opencode", "opencode.json"), "utf8")) as { plugin: string[] }).plugin).toEqual(["opencode-gemini-auth@latest", "./plugins/opencode-lane.ts"]);
  });

  it("is safe to build many times at once: a fan-out of helpers shares the files and the links", async () => {
    const { home, dataDir } = machine();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => prepareOpencodeMinimal({ home, dataDir, model: index % 2 ? "google/x" : "router9/x", env: {} })));
    expect(new Set(results.map((row) => row?.configHome)).size).toBe(1);
    expect(results.every((row) => row !== null)).toBe(true);
    const dir = join(results[0]!.configHome, "opencode");
    expect(JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"))).toHaveProperty("plugin");
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("follows the machine's config when it changes and drops links whose source is gone", async () => {
    const { home, real, dataDir } = machine();
    const first = await prepareOpencodeMinimal({ home, dataDir, model: null, env: {} });
    const dir = join(first!.configHome, "opencode");
    writeFileSync(join(real, "opencode.json"), CONFIG.replace("router9/ag/gemini-3.8-flash-medium", "router9/other"));
    rmSync(join(real, "agents"), { recursive: true });
    await prepareOpencodeMinimal({ home, dataDir, model: null, env: {} });
    expect((JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as { model: string }).model).toBe("router9/other");
    expect(names(dir)).not.toContain("agents");
  });

  it("uses the config home the machine names in XDG_CONFIG_HOME", async () => {
    const { home, real, dataDir } = machine();
    const moved = temp();
    mkdirSync(join(moved, "opencode"), { recursive: true });
    writeFileSync(join(moved, "opencode", "opencode.jsonc"), CONFIG);
    symlinkSync(real, join(moved, "elsewhere"));
    const result = await prepareOpencodeMinimal({ home, dataDir, model: null, env: { XDG_CONFIG_HOME: moved } });
    expect(result).not.toBeNull();
    expect(names(result!.configHome)).toEqual(["elsewhere", "opencode"]);
  });

  it("changes nothing when there is nothing to leave out, no config, or the owner switched it off", async () => {
    const clean = machine(`{ "model": "router9/x", "plugin": ["./plugins/opencode-lane.ts"], "mcp": {} }`);
    rmSync(join(clean.real, "plugin"), { recursive: true });
    rmSync(join(clean.real, "plugins", "agentmemory-capture.ts"));
    expect(await prepareOpencodeMinimal({ home: clean.home, dataDir: clean.dataDir, model: null, env: {} })).toBeNull();

    expect(await prepareOpencodeMinimal({ home: temp(), dataDir: temp(), model: null, env: {} })).toBeNull();

    const off = machine();
    mkdirSync(join(off.home, ".lane-pilot"), { recursive: true });
    writeFileSync(join(off.home, ".lane-pilot", "opencode-min.json"), `{ "enabled": false }`);
    expect(await prepareOpencodeMinimal({ home: off.home, dataDir: off.dataDir, model: null, env: {} })).toBeNull();

    const keep = machine();
    mkdirSync(join(keep.home, ".lane-pilot"), { recursive: true });
    writeFileSync(join(keep.home, ".lane-pilot", "opencode-min.json"), `{ "keepPlugins": ["agentmemory"] }`);
    const kept = await prepareOpencodeMinimal({ home: keep.home, dataDir: keep.dataDir, model: null, env: {} });
    expect(names(join(kept!.configHome, "opencode", "plugins"))).toEqual(["agentmemory-capture.ts", "opencode-lane", "opencode-lane.ts"]);
    expect((JSON.parse(readFileSync(join(kept!.configHome, "opencode", "opencode.json"), "utf8")) as { plugin: string[] }).plugin).toEqual(["opencode-gemini-auth@latest", "./plugins/agentmemory-capture.ts", "./plugins/opencode-lane.ts"]);
  });
});
