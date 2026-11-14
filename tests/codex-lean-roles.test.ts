import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_LEAN_DEFAULT_ROLES, ROLE_PROFILES, codexLeanEnabled, parseCodexLeanRoles } from "../src/rooms/contracts";
import { createBbShimEnv } from "../src/rooms/native-agent/server/helper-bb-shim";

// Per-role choice of the lean Codex home (setting codex.lean_roles) and the contents of the role profiles it goes with.
describe("codex.lean_roles", () => {
  it("unset and `default` mean docs and the one-shot judges and critics; the writer and the open roles stay out", () => {
    for (const raw of [undefined, null, "", "default", " DEFAULT "]) {
      for (const role of CODEX_LEAN_DEFAULT_ROLES) expect(codexLeanEnabled(role, raw), `${role}/${String(raw)}`).toBe(true);
      for (const role of ["writer", "code-repair", "specialist:tavily", "analyst", "errand", "self-repair", "wall-hunter", "debugger"]) expect(codexLeanEnabled(role, raw), role).toBe(false);
    }
    expect(CODEX_LEAN_DEFAULT_ROLES).toEqual(expect.arrayContaining(["docs-maintainer", "plan-critic", "code-critic", "pm-reader"]));
  });

  it("`off` is the escape hatch, `all` takes every role, a list names exactly those and `default` inside it expands", () => {
    expect(parseCodexLeanRoles("off")).toEqual({ mode: "off" });
    expect(codexLeanEnabled("docs-maintainer", "off")).toBe(false);
    expect(codexLeanEnabled("writer", "all")).toBe(true);
    expect(codexLeanEnabled("writer", "writer, wall-hunter")).toBe(true);
    expect(codexLeanEnabled("docs-maintainer", "writer, wall-hunter")).toBe(false);
    expect(codexLeanEnabled("docs-maintainer", "default,wall-hunter")).toBe(true);
    expect(codexLeanEnabled("wall-hunter", "default,wall-hunter")).toBe(true);
  });

  it("the host env LANE_PILOT_CODEX_LEAN_HOME=off beats the setting; `on` is the old all-roles switch only while the setting is unset", () => {
    expect(codexLeanEnabled("docs-maintainer", "all", "off")).toBe(false);
    expect(codexLeanEnabled("writer", undefined, "on")).toBe(true);
    expect(codexLeanEnabled("writer", "default", "on")).toBe(false);
  });
});

describe("the shim picks the home per role", () => {
  const SHIM = { dir: "/data/bb-shim", path: "/data/bb-shim:/usr/bin" };
  function setup(role: string, settings: Record<string, unknown>) {
    const host = { call: vi.fn(async (method: string, input: { key?: string; profile?: string }) => (method === "prepareBbShim" ? SHIM : { codexHome: `/h/${input.key}`, seeded: [] })) };
    const rows = Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    const db = { prepare: () => ({ all: () => rows, get: () => undefined }) };
    const bb = { log: { warn: () => undefined, info: () => undefined }, sdk: { threads: { getPluginMetadata: async () => ({ role }) } } };
    return { host, contribute: createBbShimEnv({ bb, host, db } as never) };
  }
  const homeOf = async (role: string, settings: Record<string, unknown>) => {
    const { contribute, host } = setup(role, settings);
    const entries = await contribute({ threadId: "thr_1", hostId: "h" }, "codex");
    return { home: entries.find((entry) => entry.name === "CODEX_HOME")?.value ?? null, calls: host.call.mock.calls.filter(([method]) => method === "prepareWorkerHome").map(([, input]) => input) };
  };

  it("with nothing set, docs and the critics start in the lean home of their profile and the writer does not", async () => {
    const docs = await homeOf("docs-maintainer", {});
    expect(docs.home).toBe("/h/lean-quiet");
    expect(docs.calls).toEqual([expect.objectContaining({ key: "lean-quiet", profile: "quiet" })]);
    expect((await homeOf("code-critic", {})).home).toBe("/h/lean-quiet");
    expect(await homeOf("writer", {})).toEqual({ home: null, calls: [] });
    expect((await homeOf("specialist:tavily", {})).home).toBeNull();
  });

  it("the setting turns it off, widens it to a role, or to every role (the open roles get their own profile)", async () => {
    expect((await homeOf("docs-maintainer", { "codex.lean_roles": "off" })).home).toBeNull();
    expect((await homeOf("writer", { "codex.lean_roles": "default,writer" })).home).toBe("/h/lean-code");
    expect((await homeOf("analyst", { "codex.lean_roles": "all" })).home).toBe("/h/lean-open");
  });

  it("other providers never get a codex home", async () => {
    const { contribute } = setup("docs-maintainer", {});
    const entries = await contribute({ threadId: "thr_1", hostId: "h" }, "opencode2");
    expect(entries.map((entry) => entry.name)).not.toContain("CODEX_HOME");
  });
});

describe("a lean home shared by parallel sessions", () => {
  it("is prepared by concurrent calls without a torn or duplicated config, keeps what Codex added, and links the login once", async () => {
    const { prepareWorkerHome } = await import("../src/rooms/host-worker/handlers/machine");
    const home = mkdtempSync(join(tmpdir(), "lp-shared-"));
    const owner = join(home, ".codex");
    mkdirSync(owner);
    writeFileSync(join(owner, "config.toml"), 'web_search = "cached"\n[features]\ngoals = true\n');
    writeFileSync(join(owner, "auth.json"), "{}");
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = home; delete process.env.CODEX_HOME;
    try {
      const input = { requestedHostId: "h", key: "lean-quiet", profile: "quiet" } as never;
      const first = await Promise.all(Array.from({ length: 12 }, () => prepareWorkerHome(input, {} as never)));
      const dir = first[0]!.codexHome;
      const text = readFileSync(join(dir, "config.toml"), "utf8");
      expect(text.match(/^goals = false$/gm)).toHaveLength(1);
      expect(text).toContain('web_search = "disabled"');
      // Codex records a trusted project in the home's own config; the next session's preparation leaves it be and leaves the file as it was.
      writeFileSync(join(dir, "config.toml"), `${text}\n[projects."/work"]\ntrust_level = "trusted"\n`);
      await Promise.all(Array.from({ length: 12 }, () => prepareWorkerHome(input, {} as never)));
      const again = readFileSync(join(dir, "config.toml"), "utf8");
      expect(again).toContain('[projects."/work"]');
      expect(again.match(/^goals = false$/gm)).toHaveLength(1);
      expect(readdirSync(dir).sort()).toEqual(["auth.json", "config.toml"]);
    } finally { if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME; if (saved.CODEX_HOME !== undefined) process.env.CODEX_HOME = saved.CODEX_HOME; }
  });
});

describe("role profiles by evidence (audit 2026-11-14)", () => {
  it("keeps the code graph where it is wanted and drops it where it never was called", () => {
    for (const role of ["writer", "code-repair", "night-fixer", "code-critic", "specialist-reviewer", "debugger"] as const) expect(ROLE_PROFILES[role].mcpServers, role).toEqual(["gitnexus"]);
    for (const role of ["docs-maintainer", "onboarder", "project-life", "plan-critic", "pm-reader", "gate-triage"] as const) expect(ROLE_PROFILES[role].mcpServers, role).toEqual([]);
  });
  it("gives no role but the specialists a metamcp gateway; the writer reads docs through its own tools", () => {
    for (const [role, profile] of Object.entries(ROLE_PROFILES)) if (role !== "specialist:design-lead") expect(profile.mcpServers, role).not.toContain("metamcp");
    expect(ROLE_PROFILES.debugger.skills).toEqual(["gitnexus-debugging"]);
    expect(ROLE_PROFILES.writer.skills).toEqual(["lp-writer", "karpathy-guidelines"]);
  });
});
