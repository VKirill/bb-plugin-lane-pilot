// Region 7 · Providers, models, accounts, batch a: behaviour tests of the cards that had none (or none that a mutation of the node's own code fails).
// No real model, provider API or money: stand-in hosts, fixture trees, a scratch HOME. Package code (packages/models, packages/kit) is imported by
// relative path so that a mutation made under packages/ in a worktree is seen by the test (node_modules resolves to the main checkout).
import { mkdirSync, mkdtempSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { createSecrets, envForRecord, type CatalogRecord } from "../../src/rooms/secrets/server/secrets";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { walkWriterChain, waitingWriterReason, waitingWriterText, writerHold, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { asWorker, grantCommands } from "../../src/rooms/verification/worker-user";
import { CAPABILITIES, dueProbes, probeVerdict, type CapabilityReceipt } from "../../src/rooms/capability/logic";
import { criticAcrossFamilies, type CriticCatalog } from "../../src/rooms/critique/critic-pair";
import { buildCapsule } from "../../src/rooms/session-hooks/logic";
import { isPaid, priceOf } from "../../src/rooms/money/logic";
import { spawnAsync } from "../../packages/kit/src/spawn-async";
import { PROVIDER_CAPABILITIES, nativeProviderFamily, providerForwardsAgentOnly } from "../../packages/models/src/providers";
import { ROLE_MODEL_EFFORTS, ROLE_TABLE, roleDefaultModel, roleModelOption } from "../../packages/models/src/role-models";

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `sma-r07a-${name}-`));
/** Runs `body` with HOME (and no CODEX_HOME) pointing at a scratch folder: the handlers read os.homedir(). */
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; delete process.env.CODEX_HOME;
  try { return await body(); } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.CODEX_HOME !== undefined) process.env.CODEX_HOME = saved.CODEX_HOME;
  }
}

describe("accounts and the separate user", () => {
  it("[sma:m_ac_codex_home] the throwaway home is removed with its login link, only inside codex-homes, and never through a key that names a parent or the root", async () => {
    const { removeWorkerHome } = await import("../../src/rooms/host-worker/handlers/machine");
    const home = scratch("codex-home");
    const owner = join(home, ".codex");
    mkdirSync(owner, { recursive: true });
    writeFileSync(join(owner, "auth.json"), '{"owner":"login"}');
    const homes = join(home, ".lane-pilot", "codex-homes");
    mkdirSync(join(homes, "A-1"), { recursive: true });
    mkdirSync(join(homes, "A-2"), { recursive: true });
    symlinkSync(join(owner, "auth.json"), join(homes, "A-1", "auth.json"));
    await withHome(home, async () => {
      expect(await removeWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never)).toMatchObject({ removed: true });
      expect(existsSync(join(homes, "A-1"))).toBe(false);
      // The login the home linked is the owner's: the removal took the link, not the file.
      expect(readFileSync(join(owner, "auth.json"), "utf8")).toBe('{"owner":"login"}');
      for (const key of [".", "..", "", "../escape", "a/b", ".hidden"]) expect(await removeWorkerHome({ requestedHostId: "h", key } as never, {} as never)).toMatchObject({ removed: false });
      expect(existsSync(join(homes, "A-2"))).toBe(true);
      expect(await removeWorkerHome({ requestedHostId: "h", key: "A-gone" } as never, {} as never)).toMatchObject({ removed: false });
    });
  });

  it("[sma:m_ac_seed_codex] a fresh home gets the owner's config trimmed to the role's profile, a link to the login and no AGENTS.md; a second call lays nothing again", async () => {
    const { prepareWorkerHome } = await import("../../src/rooms/host-worker/handlers/machine");
    const home = scratch("seed");
    const owner = join(home, ".codex");
    mkdirSync(owner, { recursive: true });
    writeFileSync(join(owner, "config.toml"), 'web_search = "cached"\n[features]\ngoals = true\n');
    writeFileSync(join(owner, "AGENTS.md"), "personal instructions");
    writeFileSync(join(owner, "auth.json"), "{}");
    await withHome(home, async () => {
      const writer = await prepareWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never);
      expect(writer.codexHome).toBe(join(home, ".lane-pilot", "codex-homes", "A-1"));
      expect(writer.seeded).toEqual(["config.toml", "auth.json"]);
      const text = readFileSync(join(writer.codexHome, "config.toml"), "utf8");
      expect(text).toContain("goals = false");
      expect(text).toContain('web_search = "disabled"');
      expect(existsSync(join(writer.codexHome, "AGENTS.md"))).toBe(false);
      expect(lstatSync(join(writer.codexHome, "auth.json")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(writer.codexHome, "auth.json"))).toBe(join(owner, "auth.json"));
      expect((await prepareWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never)).seeded).toEqual([]);
      const open = await prepareWorkerHome({ requestedHostId: "h", key: "lean-open", profile: "open" } as never, {} as never);
      expect(readFileSync(join(open.codexHome, "config.toml"), "utf8")).toContain('web_search = "cached"');
    });
  });

  it("[sma:m_ac_readiness] a provider in use is due for a probe while its installed key lacks a receipt of any capability; a complete key, an unknown version and a receipt of another key are told apart", () => {
    const receipt = (providerId: string, version: string, capability: (typeof CAPABILITIES)[number]): CapabilityReceipt => ({ providerId, version, capability, state: "supported", model: "m", detail: null, at: 1 });
    const full = CAPABILITIES.map((capability) => receipt("claude-code", "v1#a", capability));
    const partial = CAPABILITIES.slice(0, -1).map((capability) => receipt("codex", "v1#a", capability));
    const otherKey = CAPABILITIES.map((capability) => receipt("opencode2", "v0#old", capability));
    const inUse = new Map([["claude-code", "sonnet"], ["codex", "luna"], ["opencode2", "glm"], ["devin", "d"]]);
    const versions = new Map<string, string | null>([["claude-code", "v1#a"], ["codex", "v1#a"], ["opencode2", "v1#a"], ["devin", null]]);
    expect(dueProbes(inUse, versions, [...full, ...partial, ...otherKey])).toEqual([
      { providerId: "codex", model: "luna", version: "v1#a" },
      { providerId: "opencode2", model: "glm", version: "v1#a" },
    ]);
    expect(dueProbes(inUse, versions, [...full, ...partial, receipt("codex", "v1#a", CAPABILITIES.at(-1)!), ...CAPABILITIES.map((capability) => receipt("opencode2", "v1#a", capability))])).toEqual([]);
  });

  it("[sma:m_ac_identity_list] a project with worker.strict_user on runs its check as worker.user (lp-worker when none is named) through the host call; off or unset sends no user", async () => {
    const root = realpathSync(scratch("strict"));
    const task = { schema_version: 2, id: "t", title: "t", risk: "low", lane: "writer", project_cwd: root, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "tests",
      verification: [{ command: "node plain.js", cwd: root }] } as unknown as TaskV2;
    const run = async (settings: Record<string, string>) => {
      const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
      const db = openDatabase(bb);
      for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "P", key, value);
      const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
      const host = { call: vi.fn(async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        return { hostId: "h", backend: "linux-bubblewrap", workspacePath: root, cwd: root, exitCode: 0, policySha256: "a".repeat(64), stdout: "ok\n", stderr: "" };
      }) };
      const verify = createWriterVerify({ bb, db, host, runPolicyFor: () => ({ pools: { verification: 2 } }), secrets: createSecrets({ bb }) } as never, { runWriterPool: { acquire: async () => () => undefined } } as never);
      await verify.runVerification({ hostId: "h", projectId: "P" } as never, task);
      return calls.filter((call) => call.method === "runSandboxedCommand").map((call) => call.input);
    };
    const on = await run({ "worker.strict_user": "on" });
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((input) => input.asUser === "lp-worker" && input.command === "node plain.js")).toBe(true);
    expect((await run({ "worker.strict_user": "on", "worker.user": "ci-bot" })).every((input) => input.asUser === "ci-bot")).toBe(true);
    for (const off of [{}, { "worker.strict_user": "off", "worker.user": "ci-bot" }] as Array<Record<string, string>>) {
      const inputs = await run(off);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => !("asUser" in input))).toBe(true);
    }
  });

  it("[sma:m_ac_probe_child] the launch as the worker is sudo -n -u <user> that keeps exactly the named variables and nothing else; a name that is not a user is refused before anything runs", () => {
    expect(asWorker("lp-worker", "/usr/bin/bwrap", ["--die-with-parent", "bash"], ["PATH", "TOKEN", "PATH"]))
      .toEqual({ program: "/usr/bin/sudo", args: ["-n", "-u", "lp-worker", "--preserve-env=PATH,TOKEN", "/usr/bin/bwrap", "--die-with-parent", "bash"] });
    expect(asWorker("lp-worker", "/bin/true", [], []).args).toEqual(["-n", "-u", "lp-worker", "/bin/true"]);
    expect(() => asWorker("root;rm -rf /", "/bin/true", [], [])).toThrow(/worker_user_invalid/);
  });

  it("[sma:m_ac_probe_verdicts] a probe that answered right is supported, one that ran and answered wrong is wrong, and every way of not running (limit, offline, timeout, empty, setup) is could_not_run and writes no red", () => {
    expect(probeVerdict({ ok: true })).toBe("supported");
    expect(probeVerdict({ ok: false, answered: true, reason: "helper_probe_output_unexpected: NO" })).toBe("wrong");
    expect(probeVerdict({ ok: false, reason: "helper_probe_pause_check_failed: it kept running" })).toBe("wrong");
    expect(probeVerdict({ ok: false, answered: true, reason: "some other wrong answer" })).toBe("wrong");
    for (const reason of ["helper_probe_timeout", "helper_probe_output_empty", "rate limit reached", "HTTP 429", "provider overloaded", "helper_probe_run_unusable: gone", "Parent thread is invalid"])
      expect(probeVerdict({ ok: false, answered: true, reason }), reason).toBe("could_not_run");
    expect(probeVerdict({ ok: false })).toBe("could_not_run");
    expect(probeVerdict({ ok: false, answered: false, reason: "something threw" })).toBe("could_not_run");
  });

  it("[sma:m_ac_copy_worker] the worker gets rights on the run folder that its new files inherit, and the owner keeps the same inherited rights on what the worker makes", () => {
    const darwin = grantCommands("darwin", "lp-worker", "owner", "/run/dir");
    expect(darwin.map((step) => [step.program, step.args[0], step.args[1], step.args[2].split(" allow ")[0], step.args[3]])).toEqual([
      ["/bin/chmod", "-R", "-a", "user:lp-worker", "/run/dir"],
      ["/bin/chmod", "-R", "+a", "user:lp-worker", "/run/dir"],
      ["/bin/chmod", "-R", "+a", "user:owner", "/run/dir"],
    ]);
    expect(darwin[2]!.args[2]).toContain("file_inherit,directory_inherit");
    const linux = grantCommands("linux", "lp-worker", "owner", "/run/dir");
    expect(linux).toEqual([{ program: "setfacl", args: ["-R", "-m", "u:lp-worker:rwX,d:u:lp-worker:rwX,u:owner:rwX,d:u:owner:rwX", "/run/dir"] }]);
  });

  it("[sma:m_ac_job] group:true kills the whole process group on a timeout and on an overflow, and leaves a background process of a normal finish alone", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
    const timedOut = await spawnAsync("/bin/bash", ["-c", "sleep 30 & sleep 30"], { group: true, timeout: 300 });
    expect(timedOut.error).toMatchObject({ code: "ETIMEDOUT" });
    await sleep(500);
    expect(alive(timedOut.pid!)).toBe(false);
    const overflow = await spawnAsync("/bin/bash", ["-c", "sleep 30 & head -c 200000 /dev/zero"], { group: true, maxBuffer: 100 });
    expect(overflow.error).toMatchObject({ code: "ENOBUFS" });
    await sleep(500);
    expect(alive(overflow.pid!)).toBe(false);
    const normal = await spawnAsync("/bin/bash", ["-c", "sleep 30 & exit 0"], { group: true });
    expect(normal.status).toBe(0);
    try { expect(alive(normal.pid!)).toBe(true); } finally { try { process.kill(-normal.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("vendor lanes", () => {
  it("[sma:m_ln_claude] the Claude lane serves the claude family only, forwards agent-only parts, reads hook settings and publishes its subscription windows; Codex does not publish windows", () => {
    expect(nativeProviderFamily("claude-code")).toBe("claude");
    expect(providerForwardsAgentOnly("claude-code")).toBe(true);
    expect(PROVIDER_CAPABILITIES["claude-code"]).toMatchObject({ family: "claude", supportsHookSettings: true, publishesUsageWindows: true, forwardsAgentOnly: true });
    expect(PROVIDER_CAPABILITIES["codex"]).toMatchObject({ family: "gpt", requiresWorkerHome: true });
    expect(PROVIDER_CAPABILITIES["codex"]?.publishesUsageWindows).toBeUndefined();
    expect(PROVIDER_CAPABILITIES["codex"]?.supportsHookSettings).toBeUndefined();
  });

  it("[sma:m_ln_api] a token-paid lane is told from a subscription one, only a paid lane has a price, and with money.strict on the free subscription member wins over a free paid one", async () => {
    for (const paid of ["openlux", "anthropic", "openai", "api", "api-acme"]) expect(isPaid(paid), paid).toBe(true);
    for (const subscription of ["claude-code", "codex", "opencode2", "apiary"]) expect(isPaid(subscription), subscription).toBe(false);
    expect(priceOf("claude-code", "claude-sonnet-5-5")).toBeNull();
    expect(priceOf("anthropic", "claude-sonnet-5-5")).not.toBeNull();
    const deps = { breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true } as unknown as WriterHoldDeps;
    const chain = [{ providerId: "anthropic", model: "claude-sonnet-5-5" }, { providerId: "codex", model: "gpt-6-luna" }];
    expect((await walkWriterChain(chain, { hostId: "h", settings: { "money.strict": "on" } }, deps)).free?.member.providerId).toBe("codex");
    expect((await walkWriterChain(chain, { hostId: "h", settings: { "money.strict": "off" } }, deps)).free?.member.providerId).toBe("anthropic");
  });

  it("[sma:m_ln_default_routing] the built-in vendor of a role: authors on Claude, the judges and the paperwork on GPT, a model of Gemini through 9router for the reviews; an unknown row falls back to the first row", () => {
    const pick = (row: string) => { const { providerId, model, effort, source, sourceKey } = roleDefaultModel(row); return { providerId, model, effort, source, sourceKey }; };
    expect(pick("planner")).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "default", sourceKey: null });
    expect(pick("auditor")).toEqual({ providerId: "codex", model: "gpt-6.1-sol", effort: "high", source: "default", sourceKey: null });
    expect(pick("docs-maintainer")).toMatchObject({ providerId: "codex", model: "gpt-6-luna", effort: "high" });
    expect(pick("code-critic")).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium" });
    expect(pick("pm-reader")).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", effort: "low" });
    expect(pick("no-such-row")).toEqual(pick(ROLE_TABLE[0]!.id));
  });

  it("[sma:m_ln_unavailable] a writer member the vendor cannot give is refused with the named cause (breaker, owner at the vendor, core cannot run it, switched off by the owner), never a bare failure, and the board line says it in words", async () => {
    const now = 1_000_000;
    const deps = (over: Partial<WriterHoldDeps> = {}) => ({ breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true, ...over }) as unknown as WriterHoldDeps;
    const input = { providerId: "codex", model: "gpt-6-luna", hostId: "h", settings: {} as Record<string, unknown> };
    expect(await writerHold(input, deps(), now)).toBeNull();
    const unsupported = await writerHold({ ...input, providerId: "devin", model: "d" }, deps({ coreHosts: () => false }), now);
    expect(unsupported).toEqual({ reason: "writer_provider_unavailable:core_unsupported:devin", until: null });
    expect(waitingWriterText(unsupported!, null)).toBe("Ждёт писателя: Devin не поддерживается этим ядром");
    const off = await writerHold({ ...input, settings: { "writer.models_off": ["codex/gpt-6-luna"] } }, deps(), now);
    expect(off?.reason).toMatch(/^writer_provider_unavailable:writer_off:/);
    expect(off?.reason).toContain("gpt-6-luna");
    expect(off!.until).toBeGreaterThan(now);
    expect(waitingWriterText(off!, off!.until, now)).toContain("выключен владельцем (writer.models_off)");
    const open = await writerHold(input, deps({ breaker: { snapshot: () => [{ key: "codex/gpt-6-luna", state: "open", failures: 3, openedAt: now - 1000 }] } as never }), now);
    expect(open?.reason).toBe("writer_provider_unavailable:breaker_open:codex/gpt-6-luna: 3 provider failures");
    expect(waitingWriterText(open!, open!.until, now)).toBe("Ждёт писателя: провайдер Codex временно недоступен после сбоев, проверка через 5 мин");
    // A closed breaker or one for another pair names nothing.
    expect(await writerHold(input, deps({ breaker: { snapshot: () => [{ key: "codex/gpt-6-luna", state: "closed", failures: 0, openedAt: null }, { key: "codex/other", state: "open", failures: 1, openedAt: now }] } as never }), now)).toBeNull();
    expect(waitingWriterReason(unsupported!)).toBe("waiting_writer:writer_provider_unavailable:core_unsupported:devin");
  });

  it("[sma:m_ln_verifier_default] a candidate is judged by another vendor than its maker: a Claude critic facing a Claude writer moves to the GPT peer the host offers; a GPT writer leaves the Claude critic; nothing offered keeps the critic", async () => {
    const catalog = (spec: Record<string, Record<string, string[]>>): CriticCatalog => ({
      provider: async (providerId) => (spec[providerId] ? { id: providerId, available: true, supportsServiceTier: false, serviceTiers: [] } : null),
      models: async (providerId) => Object.entries(spec[providerId] ?? {}).map(([model, efforts]) => ({ id: model, model, efforts })),
    });
    const host = catalog({ codex: { "gpt-6.1-sol": ["high"] }, "claude-code": { "claude-opus-5-5": ["high"] } });
    const input = { effort: "high", tier: "standard" as const };
    const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
    const sol = { providerId: "codex", model: "gpt-6.1-sol" };
    expect(await criticAcrossFamilies({ ...input, catalog: host, critic: opus, writer: { providerId: "claude-code", model: "claude-sonnet-5-5" } })).toEqual({ pair: sol, changed: true });
    expect(await criticAcrossFamilies({ ...input, catalog: host, critic: opus, writer: sol })).toEqual({ pair: opus, changed: false });
    expect(await criticAcrossFamilies({ ...input, catalog: host, critic: opus, writer: null })).toEqual({ pair: opus, changed: false });
    expect(await criticAcrossFamilies({ ...input, catalog: catalog({ "claude-code": { "claude-opus-5-5": ["high"] } }), critic: opus, writer: { providerId: "claude-code", model: "claude-sonnet-5-5" } })).toEqual({ pair: opus, changed: false });
  });
});

describe("the worker's personal layer", () => {
  const record = (over: Partial<CatalogRecord>): CatalogRecord => ({ name: "KEY", kind: "secret", value: null, access: null, ...over });

  it("[sma:m_pl_never] a check receives a secret under its own name and a login as NAME_USERNAME / _PASSWORD / _URL; an ssh or ftp record, even one holding a password or a private key, and a login without a password reach no session", () => {
    expect(envForRecord(record({ name: "STRIPE", value: "tok-1" }))).toEqual({ STRIPE: "tok-1" });
    expect(envForRecord(record({ name: "STRIPE", value: "" }))).toBeNull();
    expect(envForRecord(record({ name: "SHOP", kind: "login", access: { username: "qa", password: "pw", url: "https://shop.test" } })))
      .toEqual({ SHOP_USERNAME: "qa", SHOP_PASSWORD: "pw", SHOP_URL: "https://shop.test" });
    expect(envForRecord(record({ name: "SHOP", kind: "login", access: { username: "qa", host: "shop.test" } }))).toBeNull();
    for (const kind of ["ssh", "ftp"] as const) {
      expect(envForRecord(record({ name: "DEPLOY", kind, access: { host: "h", username: "u", password: "pw", privateKey: "-----BEGIN KEY-----" } })), kind).toBeNull();
      expect(envForRecord(record({ name: "DEPLOY", kind, value: "pw" })), kind).toBeNull();
    }
  });

  it("[sma:m_pl_compact] the capsule written before compaction keeps the last five asks cut to 300 characters, at most 30 files and 30 claims, and the trigger only when there is one", () => {
    const asks = Array.from({ length: 8 }, (_, index) => `ask-${index}-${"x".repeat(400)}`);
    const files = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`);
    const capsule = buildCapsule({ asks, files, claims: files.map((file) => `claim ${file}`), trigger: "precompact" });
    expect(capsule.asks).toHaveLength(5);
    expect(capsule.asks.map((ask) => ask.slice(0, 5))).toEqual(["ask-3", "ask-4", "ask-5", "ask-6", "ask-7"]);
    expect(capsule.asks.every((ask) => ask.length === 300)).toBe(true);
    expect(capsule.files).toEqual(files.slice(0, 30));
    expect(capsule.claims).toHaveLength(30);
    expect(capsule.trigger).toBe("precompact");
    expect("trigger" in buildCapsule({ asks: [], files: [], claims: [] })).toBe(false);
  });
});

describe("model and worker choice", () => {
  it("[sma:m_md_expected] every role of the table names a model the table offers with an effort it knows, and the pair a few roles are expected to run is exactly this one", () => {
    for (const row of ROLE_TABLE) {
      const option = roleModelOption(row.default.model);
      expect(option, `${row.id}: ${row.default.model} is not an option of the table`).toBeDefined();
      expect((ROLE_MODEL_EFFORTS as readonly string[]).includes(row.default.effort), `${row.id}: effort ${row.default.effort}`).toBe(true);
      if (option?.efforts) expect(option.efforts, row.id).toContain(row.default.effort);
    }
    const expected = (id: string) => { const row = ROLE_TABLE.find((item) => item.id === id)!; return `${roleModelOption(row.default.model)!.providerId}/${row.default.model}/${row.default.effort}`; };
    expect(expected("planner")).toBe("claude-code/claude-opus-5-5/high");
    expect(expected("copy-lead")).toBe("claude-code/claude-sonnet-5-5/high");
    expect(expected("errand")).toBe("claude-code/claude-sonnet-5-5/medium");
    expect(expected("pm-reader")).toBe("claude-code/claude-haiku-5-5/low");
    expect(expected("debugger")).toBe("codex/gpt-6.1-sol/high");
    expect(expected("api-recon")).toBe("codex/gpt-6.1-terra/high");
    expect(expected("plan-critic")).toBe("opencode2/router9/ag/gemini-3.8-flash-high/medium");
    expect(new Set(ROLE_TABLE.map((row) => row.id)).size).toBe(ROLE_TABLE.length);
  });
});
