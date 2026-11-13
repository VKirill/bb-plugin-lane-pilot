import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_LEAN_CHECKED_ON, CODEX_LEAN_COMMON_OFF, CODEX_LEAN_SURFACE_OFF, JUDGE_OFF_FEATURES, codexLeanOffFeatures, codexLeanProfile, leanCodexConfig, setTomlKeys } from "../src/rooms/contracts";
import { CodexFailure, codexChat, codexJudgeArgs, codexJudgeEffort, readCodexStream } from "../src/rooms/memory/codex-chat";
import { CODEX_PREFIX, judgeRoutes, openLuxJudge } from "../src/rooms/memory/server/memory-judge";
import { disableCodexMemories } from "../src/rooms/host-worker/handlers/machine";
import type { MemoryRecord } from "../packages/memory-core/src";

const record = (id: string, content: string): MemoryRecord => ({ id, content, kind: "note", concepts: [], projectId: "P", personalBot: "", sourceSha256: "", createdAt: 1 });
const candidates = [record("a", "alpha port is 4000"), record("b", "beta uses sqlite"), record("c", "gamma has a cron")];

describe("the trimmed codex config", () => {
  const owner = 'model = "x"\nweb_search = "cached"\n\n[agents]\nenabled = true\nmax_depth = 1\n\n[agents.planner]\nconfig_file = "agents/planner.toml"\n\n[features]\nhooks = true\ngoals = true\nmulti_agent = true\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[[skills.config]]\npath = "/s"\nenabled = true\n';
  it("turns the listed flags off, keeps the rest of the owner's file, drops the agent role tables and the web for code roles", () => {
    const out = leanCodexConfig(disableCodexMemories(owner), "code");
    expect(out).toContain('web_search = "disabled"');
    expect(out).toContain("[agents]\nenabled = false");
    expect(out).toContain("max_depth = 1");
    expect(out).not.toContain("agents.planner");
    expect(out).toContain("goals = false");
    expect(out).toContain("hooks = true");
    expect(out).toContain("memories = false");
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain("[[skills.config]]\npath = \"/s\"");
    for (const name of CODEX_LEAN_COMMON_OFF) expect(out).toContain(`${name} = false`);
    expect(out.match(/^model = "x"$/m)).not.toBeNull();
  });
  it("a code role keeps shell, exec, view_image; a quiet one loses view_image; an open one keeps the web and the browser tools", () => {
    const code = codexLeanOffFeatures("code"), quiet = codexLeanOffFeatures("quiet"), open = codexLeanOffFeatures("open");
    for (const kept of ["shell_tool", "unified_exec", "apply_patch"]) for (const list of [code, quiet, open]) expect(list).not.toContain(kept);
    expect(code).not.toContain("view_image");
    expect(quiet).toContain("view_image");
    expect(code).toEqual(expect.arrayContaining([...CODEX_LEAN_SURFACE_OFF]));
    expect(open).not.toContain("browser_use");
    expect(leanCodexConfig(owner, "open")).toContain('web_search = "cached"');
    expect(leanCodexConfig(owner, "quiet")).toContain('web_search = "disabled"');
  });
  it("is idempotent and adds the table or key a short file lacks", () => {
    const once = leanCodexConfig("", "code");
    expect(leanCodexConfig(once, "code")).toBe(once);
    expect(setTomlKeys("[features]\nhooks = true\n", [{ table: "features", key: "goals", value: "false" }])).toBe("[features]\ngoals = false\nhooks = true\n");
    expect(setTomlKeys("a = 1\n[t]\nb = 2\n", [{ table: "", key: "c", value: "3" }])).toBe("c = 3\na = 1\n[t]\nb = 2\n");
  });
  it("names the codex version it was checked on and sorts roles into profiles", () => {
    expect(CODEX_LEAN_CHECKED_ON).toBe("0.169.0");
    expect(codexLeanProfile("writer")).toBe("code");
    expect(codexLeanProfile("code-critic")).toBe("quiet");
    expect(codexLeanProfile("specialist:tavily")).toBe("open");
    expect(JUDGE_OFF_FEATURES).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "view_image"]));
  });
});

/** A stand-in `codex`: records its argv, env and stdin, then prints a --json stream. */
function fakeCodex(dir: string, body: string): string {
  const bin = join(dir, "fake-codex");
  writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\nprintf '%s|%s' "$HOME" "$CODEX_HOME" > "${dir}/env.txt"\ncat > "${dir}/stdin.txt"\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("prepareWorkerHome seeds a trimmed home", () => {
  it("copies the owner's config trimmed, links the login, leaves AGENTS.md out, and honours the profile", async () => {
    const { prepareWorkerHome } = await import("../src/rooms/host-worker/handlers/machine");
    const { mkdirSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "lp-home-"));
    const owner = join(home, ".codex");
    mkdirSync(owner);
    writeFileSync(join(owner, "config.toml"), 'web_search = "cached"\n[features]\ngoals = true\n');
    writeFileSync(join(owner, "AGENTS.md"), "personal instructions");
    writeFileSync(join(owner, "auth.json"), "{}");
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = home; delete process.env.CODEX_HOME;
    try {
      const code = await prepareWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never);
      const text = readFileSync(join(code.codexHome, "config.toml"), "utf8");
      expect(text).toContain("goals = false");
      expect(text).toContain('web_search = "disabled"');
      expect(existsSync(join(code.codexHome, "AGENTS.md"))).toBe(false);
      expect(lstatSync(join(code.codexHome, "auth.json")).isSymbolicLink()).toBe(true);
      const open = await prepareWorkerHome({ requestedHostId: "h", key: "lean-open", profile: "open" } as never, {} as never);
      expect(readFileSync(join(open.codexHome, "config.toml"), "utf8")).toContain('web_search = "cached"');
    } finally { if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME; if (saved.CODEX_HOME !== undefined) process.env.CODEX_HOME = saved.CODEX_HOME; }
  });
});

describe("codex/<model> judge route", () => {
  const stream = '{"type":"thread.started","thread_id":"t"}\n{"type":"item.completed","item":{"id":"i0","type":"error","message":"noise"}}\n{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"2"}}\n{"type":"turn.completed","usage":{"input_tokens":5856,"output_tokens":6}}';
  it("reads the last agent message and the usage out of the stream", () => {
    expect(readCodexStream(stream)).toEqual({ text: "2", tokensIn: 5856, tokensOut: 6 });
    expect(readCodexStream("garbage").text).toBeNull();
  });
  it("builds the minimal argument list: ephemeral, read-only, instructions file, every flag off, prompt on stdin", () => {
    const args = codexJudgeArgs("gpt-6-luna", "/i.md", "low", "/root");
    expect(args.slice(0, 6)).toEqual(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only"]);
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-6-luna", 'model_instructions_file="/i.md"', 'model_reasoning_effort="low"', "features.shell_tool=false", "features.apps=false", "include_permissions_instructions=false", "-"]));
    expect(args.at(-1)).toBe("-");
    expect(codexJudgeEffort(undefined)).toBe("low");
    expect(codexJudgeEffort("high")).toBe("high");
    expect(codexJudgeEffort("bogus")).toBe("low");
  });
  it("runs the binary in its own home with the system text as the instructions file and the prompt on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-codex-"));
    const auth = join(dir, "owner-auth.json");
    writeFileSync(auth, "{}");
    const bin = fakeCodex(dir, `printf '%s\\n' '${stream.replace(/'/g, "")}'`);
    const root = join(dir, "judge");
    const turn = await codexChat("gpt-6-luna", "SYSTEM TEXT", "the question", 10_000, bin, root, auth);
    expect(turn).toEqual({ content: "2", tokensIn: 5856, tokensOut: 6 });
    expect(readFileSync(join(dir, "stdin.txt"), "utf8")).toBe("the question");
    expect(readFileSync(join(dir, "env.txt"), "utf8")).toBe(`${root}|${join(root, "codex")}`);
    expect(lstatSync(join(root, "codex", "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "codex", "config.toml"), "utf8")).toContain("memories = false");
    const file = readdirSync(join(root, "codex")).find((name) => name.startsWith("instructions-"))!;
    expect(readFileSync(join(root, "codex", file), "utf8")).toBe("SYSTEM TEXT");
    expect(readFileSync(join(dir, "argv.txt"), "utf8")).toContain("--ephemeral");
    expect(existsSync(auth)).toBe(true);
  });
  it("a failing or silent binary, no binary, and a slot limit are failures the fallback takes over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-codex-"));
    const auth = join(dir, "a.json");
    writeFileSync(auth, "{}");
    await expect(codexChat("m", "s", "u", 1000, null, join(dir, "r"), auth)).rejects.toBeInstanceOf(CodexFailure);
    const silent = fakeCodex(dir, "echo '{\"type\":\"turn.completed\"}'");
    await expect(codexChat("m", "s", "u", 5000, silent, join(dir, "r"), auth)).rejects.toThrow(/nothing readable/);
    const quota = fakeCodex(dir, "echo 'usage limit reached 429' >&2; exit 1");
    await expect(codexChat("m", "s", "u", 5000, quota, join(dir, "r"), auth)).rejects.toMatchObject({ status: 429 });
    const slow = fakeCodex(dir, "sleep 5");
    await expect(codexChat("m", "s", "u", 200, slow, join(dir, "r"), auth)).rejects.toMatchObject({ timedOut: true });
    const hold = fakeCodex(dir, `sleep 1; printf '%s\\n' '${stream.replace(/'/g, "")}'`);
    const six = Array.from({ length: 6 }, () => codexChat("m", "s", "u", 10_000, hold, join(dir, "r"), auth));
    await expect(codexChat("m", "s", "u", 10_000, hold, join(dir, "r"), auth)).rejects.toThrow(/busy/);
    await Promise.all(six);
  }, 30_000);
  it("codex/<id> is routed to the local CLI; a quota error locks it and the fallback answers", async () => {
    const seen: string[] = [];
    const codex = async (model: string, system: string, user: string) => { seen.push(model); expect(system.length).toBeGreaterThan(0); expect(user).toContain("q"); return { content: "1", tokensIn: 5, tokensOut: 1 }; };
    const routes = judgeRoutes(async () => "lux", async () => undefined, undefined, undefined, codex, async () => "local");
    expect(routes(`${CODEX_PREFIX}gpt-6-luna`)).toMatchObject({ name: "codex", model: "gpt-6-luna" });
    const judge = openLuxJudge(async () => "lux", (async () => new Response(JSON.stringify({ choices: [{ message: { content: "none" } }] }), { status: 200 })) as unknown as typeof fetch, Date.now, undefined, routes);
    const out = await judge({ query: "q", candidates, settings: { model: "codex/gpt-6-luna", fallbackModel: "gemini-3.8-flash", timeoutMs: 12_000 } });
    expect(seen).toEqual(["gpt-6-luna"]);
    expect(out.chosen).toHaveLength(1);
    const failing = judgeRoutes(async () => "lux", async () => undefined, undefined, undefined, async () => { throw new CodexFailure("usage limit", 429); }, async () => "local");
    const second = await openLuxJudge(async () => "lux", (async () => new Response(JSON.stringify({ choices: [{ message: { content: "none" } }] }), { status: 200 })) as unknown as typeof fetch, Date.now, undefined, failing)({ query: "q2", candidates, settings: { model: "codex/gpt-6-luna", fallbackModel: "gemini-3.8-flash", timeoutMs: 12_000 } });
    expect(second.receipt.retriedWith).toBe("gemini-3.8-flash");
  });
});
