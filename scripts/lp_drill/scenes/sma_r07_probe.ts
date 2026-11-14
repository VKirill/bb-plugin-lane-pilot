// Probe of scenes/sma_r07.py (Region 7 · Providers, models, accounts). It runs the REAL code of THIS checkout on stand-ins (a fake plugin host, a scratch
// HOME, a scratch database, a fake host call): no model, no provider API, no money, no hub. It prints what happened as one JSON line and judges nothing:
// the scene compares each value with the node card's expected result and prove()s it. A section that throws reports its error; the scene then fails
// only the nodes that read that section.
// To add a node of this region: add a section below (keep it independent: its own host, database and folder) and read it in sma_r07.py.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { breakerKey, createProviderBreaker } from "@lane-pilot/resilience";
import type { TaskV2 } from "../../../src/rooms/contracts";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt } from "../../../src/rooms/storage/attempts-store";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { createTask } from "../../../src/rooms/storage/tasks-store";
import { saveProjectSetting } from "../../../src/rooms/storage";
import { createSecrets, envForRecord } from "../../../src/rooms/secrets/server/secrets";
import { createWriterVerify } from "../../../src/rooms/writer/server/verify";
import { walkWriterChain, waitingWriterReason, waitingWriterText, writerHold, type WriterHoldDeps } from "../../../src/rooms/writer/server/writer-hold";
import { asWorker, grantCommands } from "../../../src/rooms/verification/worker-user";
import { credentialMaskPaths } from "../../../src/rooms/verification/sandbox";
import { poolReadiness } from "../../../src/rooms/stability/server/canary";
import { runWorktreeJanitor } from "../../../src/rooms/stability/server/worktree-janitor";
import { criticAcrossFamilies, type CriticCatalog } from "../../../src/rooms/critique/critic-pair";
import { buildCapsule } from "../../../src/rooms/session-hooks/logic";
import { isPaid } from "../../../src/rooms/money/logic";
import { spawnAsync } from "../../../packages/kit/src/spawn-async";
import { PROVIDER_CAPABILITIES, nativeProviderFamily } from "../../../packages/models/src/providers";
import { ROLE_MODEL_EFFORTS, ROLE_TABLE, roleDefaultModel, roleModelOption } from "../../../packages/models/src/role-models";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out: Record<string, unknown> = {};
const section = async (name: string, body: () => Promise<unknown> | unknown) => { try { out[name] = await body(); } catch (cause) { out[name] = { error: cause instanceof Error ? cause.message : String(cause) }; } };
const scratch = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sma-r07-${name}-`)));
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; delete process.env.CODEX_HOME;
  try { return await body(); } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.CODEX_HOME !== undefined) process.env.CODEX_HOME = saved.CODEX_HOME;
  }
}
const holdDeps = (over: Partial<WriterHoldDeps> = {}) => ({ breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true, ...over }) as unknown as WriterHoldDeps;

// n599: the real janitor pass over a fake hub with a real removeWorkerHome behind it: only a quiet final task of a strict project loses its home.
await section("codexHome", async () => {
  const { removeWorkerHome } = await import("../../../src/rooms/host-worker/handlers/machine");
  const home = scratch("codex-home");
  const owner = join(home, ".codex"); mkdirSync(owner, { recursive: true });
  writeFileSync(join(owner, "auth.json"), "{}");
  const homes = join(home, ".lane-pilot", "codex-homes");
  const keys = ["T-done", "A-done", "T-fresh", "T-plain"];
  for (const key of keys) { mkdirSync(join(homes, key), { recursive: true }); symlinkSync(join(owner, "auth.json"), join(homes, key, "auth.json")); }
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }]);
  const db = openDatabase(bb);
  const now = Date.now();
  const attempt = (id: string, runId: string, taskId: string, endedAt: number) => { createAttempt(db, { id, runId, taskId }); db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=?, created_at=? WHERE id=?").run(endedAt, endedAt, id); };
  createRun(db, "rs", "strict"); createRun(db, "rn", "plain");
  for (const [id, runId] of [["T-done", "rs"], ["T-fresh", "rs"], ["T-plain", "rn"]] as const) createTask(db, { id, runId, kind: "bb", contract: {} as never });
  attempt("A-done", "rs", "T-done", now - 3 * 86_400_000);
  attempt("A-fresh", "rs", "T-fresh", now - 10 * 3_600_000);
  attempt("A-plain", "rn", "T-plain", now - 3 * 86_400_000);
  saveProjectSetting(db, "strict", "worker.strict_user", "on");
  const removals: string[] = [];
  const ctx = { bb, db, log: () => undefined, isDisposed: () => false, host: { call: async (method: string, input: { key?: string }) => {
    if (method !== "removeWorkerHome") return { removed: [], kept: [] };
    removals.push(String(input.key));
    return removeWorkerHome({ requestedHostId: "h1", key: String(input.key) } as never, {} as never);
  } } } as never;
  await withHome(home, async () => { await runWorktreeJanitor(ctx, { cleanupStickyLaneWorktrees: async () => [], cleanupFinishedAttemptEnvironments: async () => [] } as never, now); });
  return { removals: [...removals].sort(), left: keys.filter((key) => existsSync(join(homes, key))), ownerLogin: existsSync(join(owner, "auth.json")) };
});

// n600: a new home is seeded with the owner's config trimmed to the role's profile and a link to the login.
await section("seed", async () => {
  const { prepareWorkerHome } = await import("../../../src/rooms/host-worker/handlers/machine");
  const home = scratch("seed");
  const owner = join(home, ".codex"); mkdirSync(owner, { recursive: true });
  writeFileSync(join(owner, "config.toml"), 'web_search = "cached"\n[features]\ngoals = true\n');
  writeFileSync(join(owner, "AGENTS.md"), "personal"); writeFileSync(join(owner, "auth.json"), "{}");
  return await withHome(home, async () => {
    const first = await prepareWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never);
    const again = await prepareWorkerHome({ requestedHostId: "h", key: "A-1" } as never, {} as never);
    const text = readFileSync(join(first.codexHome, "config.toml"), "utf8");
    return { seeded: first.seeded, again: again.seeded, goalsOff: text.includes("goals = false"), webOff: text.includes('web_search = "disabled"'), agentsMd: existsSync(join(first.codexHome, "AGENTS.md")), authLinked: lstatSync(join(first.codexHome, "auth.json")).isSymbolicLink() };
  });
});

// n602: the pool's readiness over the real writer walk: counts enabled workers and names the blocked one with its reason.
await section("pool", async () => {
  const breaker = createProviderBreaker({ cooldownMs: 600_000 });
  breaker.record(breakerKey("codex", "gpt-6-luna"), "exhausted", Date.now());
  breaker.record(breakerKey("codex", "gpt-6-luna"), "exhausted", Date.now());
  breaker.record(breakerKey("codex", "gpt-6-luna"), "exhausted", Date.now());
  const deps = holdDeps({ breaker: breaker as never });
  const chain = { projectId: "proj", hostId: "h", settings: {}, members: [{ providerId: "claude-code", model: "claude-sonnet-5-5" }, { providerId: "codex", model: "gpt-6-luna" }] };
  const ready = await poolReadiness([chain], (members, input) => walkWriterChain(members, input, deps));
  return { enabled: ready.enabled, blocked: ready.blocked.map((row) => ({ key: row.key, projectIds: row.projectIds, reason: row.reason })) };
});

// n603 and n617: a held member is refused with its named cause, never a bare failure.
await section("hold", async () => {
  const now = 1_000_000;
  const input = { providerId: "codex", model: "gpt-6-luna", hostId: "h", settings: {} as Record<string, unknown> };
  const open = await writerHold(input, holdDeps({ breaker: { snapshot: () => [{ key: "codex/gpt-6-luna", state: "open", failures: 3, openedAt: now - 1000 }] } as never }), now);
  const unsupported = await writerHold({ ...input, providerId: "devin", model: "d" }, holdDeps({ coreHosts: () => false }), now);
  const off = await writerHold({ ...input, settings: { "writer.models_off": ["codex/gpt-6-luna"] } }, holdDeps(), now);
  const walk = await walkWriterChain([{ providerId: "codex", model: "gpt-6-luna" }], { hostId: "h", settings: {} }, holdDeps({ breaker: { snapshot: () => [{ key: "codex/gpt-6-luna", state: "open", failures: 3, openedAt: now - 1000 }] } as never }), now);
  return { parked: waitingWriterReason(walk.shortest!.hold), free: walk.free ?? null, unsupported: unsupported?.reason, unsupportedText: waitingWriterText(unsupported!, null), off: off?.reason, offText: waitingWriterText(off!, off!.until, now), openText: waitingWriterText(open!, open!.until, now), none: await writerHold(input, holdDeps(), now) };
});

// n604: a project with worker.strict_user on sends its check to the host as the worker user.
await section("strict", async () => {
  const root = scratch("strict");
  const task = { schema_version: 2, id: "t", title: "t", risk: "low", lane: "writer", project_cwd: root, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "tests", verification: [{ command: "node plain.js", cwd: root }] } as unknown as TaskV2;
  const run = async (settings: Record<string, string>) => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "P", key, value);
    const calls: Array<Record<string, unknown>> = [];
    const host = { call: async (method: string, input: Record<string, unknown>) => { if (method === "runSandboxedCommand") calls.push(input); return { hostId: "h", backend: "linux-bubblewrap", workspacePath: root, cwd: root, exitCode: 0, policySha256: "a".repeat(64), stdout: "ok\n", stderr: "" }; } };
    const verify = createWriterVerify({ bb, db, host, runPolicyFor: () => ({ pools: { verification: 2 } }), secrets: createSecrets({ bb }) } as never, { runWriterPool: { acquire: async () => () => undefined } } as never);
    await verify.runVerification({ hostId: "h", projectId: "P" } as never, task);
    return calls.map((call) => ("asUser" in call ? String(call.asUser) : null));
  };
  return { named: await run({ "worker.strict_user": "on", "worker.user": "ci-bot" }), defaulted: await run({ "worker.strict_user": "on" }), off: await run({}) };
});

// n606 and n608: the launch as the worker, the credential stores a check cannot read, the rights the worker's run folder carries.
await section("worker", async () => {
  const home = scratch("mask");
  for (const dir of [".ssh", ".aws", ".gnupg", ".config/gh"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".netrc"), "x");
  const rel = (list: string[]) => list.map((path) => path.slice(home.length + 1)).sort();
  const masked = credentialMaskPaths(home), withSsh = credentialMaskPaths(home, { sshKeys: true });
  return { launch: asWorker("lp-worker", "/usr/bin/bwrap", ["bash"], ["PATH", "TOKEN", "PATH"]), masked: { dirs: rel(masked.dirs), files: rel(masked.files) }, sshOpen: rel(withSsh.dirs),
    darwin: grantCommands("darwin", "lp-worker", "owner", "/run/dir").map((step) => `${step.args[1]} ${step.args[2].split(" allow ")[0]}`), linux: grantCommands("linux", "lp-worker", "owner", "/run/dir")[0]!.args[2] };
});

// n610: every process of a check dies with it: the group is killed on a timeout, a normal finish signals nothing.
await section("job", async () => {
  const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  const timedOut = await spawnAsync("/bin/bash", ["-c", "sleep 30 & sleep 30"], { group: true, timeout: 300 });
  await new Promise((done) => setTimeout(done, 500));
  const timedOutAlive = alive(timedOut.pid!);
  const normal = await spawnAsync("/bin/bash", ["-c", "sleep 30 & exit 0"], { group: true });
  const normalAlive = alive(normal.pid!);
  try { process.kill(-normal.pid!, "SIGKILL"); } catch { /* gone */ }
  return { timeoutCode: (timedOut.error as { code?: string } | undefined)?.code ?? null, timedOutAlive, normalStatus: normal.status, normalAlive };
});

// n611, n613, n614, n624: the vendor lanes and the role table.
await section("lanes", async () => {
  const pick = (row: string) => { const { providerId, model, effort } = roleDefaultModel(row); return `${providerId}/${model}/${effort}`; };
  return { claude: { family: nativeProviderFamily("claude-code"), windows: PROVIDER_CAPABILITIES["claude-code"]?.publishesUsageWindows, hooks: PROVIDER_CAPABILITIES["claude-code"]?.supportsHookSettings, codexWindows: PROVIDER_CAPABILITIES["codex"]?.publishesUsageWindows ?? null },
    paid: ["openlux", "anthropic", "openai", "api", "api-acme"].filter(isPaid), subscription: ["claude-code", "codex", "opencode2"].filter((id) => !isPaid(id)),
    routing: { planner: pick("planner"), auditor: pick("auditor"), docs: pick("docs-maintainer"), codeCritic: pick("code-critic"), pmReader: pick("pm-reader") },
    table: { roles: ROLE_TABLE.length, unknownModel: ROLE_TABLE.filter((row) => !roleModelOption(row.default.model)).map((row) => row.id), unknownEffort: ROLE_TABLE.filter((row) => !(ROLE_MODEL_EFFORTS as readonly string[]).includes(row.default.effort)).map((row) => row.id) } };
});

// n618: a critic of the writer's own vendor is replaced by the other vendor's model the host offers.
await section("critic", async () => {
  const catalog: CriticCatalog = { provider: async (id) => ({ id, available: true, supportsServiceTier: false, serviceTiers: [] }), models: async (id) => (id === "codex" ? [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", efforts: ["high"] }] : [{ id: "claude-opus-5-5", model: "claude-opus-5-5", efforts: ["high"] }]) };
  const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
  const input = { effort: "high", tier: "standard" as const, catalog };
  return { claudeWriter: await criticAcrossFamilies({ ...input, critic: opus, writer: { providerId: "claude-code", model: "claude-sonnet-5-5" } }), gptWriter: await criticAcrossFamilies({ ...input, critic: opus, writer: { providerId: "codex", model: "gpt-6.1-sol" } }) };
});

// n619 and n623: the launcher's own Python merge over a layer file (the text is read from the checkout's source), run as a helper.
await section("merge", async () => {
  const dir = scratch("merge");
  mkdirSync(join(dir, "gdir/hooks"), { recursive: true }); mkdirSync(join(dir, "home/.claude"), { recursive: true });
  writeFileSync(join(dir, "gdir/hooks/guard_shell.py"), "x"); writeFileSync(join(dir, "present.py"), "x");
  writeFileSync(join(dir, "home/.claude/settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"], allow: ["Bash(*)"], defaultMode: "bypassPermissions" } }));
  writeFileSync(join(dir, "gdir/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "guard" }] }] } }));
  const layer = { enabledPlugins: { "x@x": false }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "core" }, { type: "command", command: "python3 /definitely/missing/hook.py" }, { type: "command", command: `python3 ${join(dir, "present.py")}` }] }] } };
  writeFileSync(join(dir, "layer.json"), JSON.stringify(layer));
  const extracted = spawnSync("node", ["-e", `const fs=require('fs');const m=fs.readFileSync('src/rooms/native-agent/native-claude-host.ts','utf8').match(/const MERGE_SETTINGS_PY = (\\[[\\s\\S]*?\\])\\.join/)[1];fs.writeFileSync('${dir}/merge.py',eval(m).join('\\n'));`], { cwd: ROOT, encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`the merge text was not found: ${extracted.stderr}`);
  writeFileSync(join(dir, "show.sh"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then cat "$2"; fi; shift; done\n`);
  spawnSync("chmod", ["+x", join(dir, "show.sh")]);
  const ran = spawnSync("python3", [join(dir, "merge.py"), join(dir, "show.sh"), join(dir, "gdir/settings.json"), "-h", "--", "--settings", join(dir, "layer.json")], { encoding: "utf8", env: { ...process.env, HOME: join(dir, "home"), LANE_PILOT_ROLE: "writer" } });
  const merged = JSON.parse(ran.stdout || "{}") as { hooks?: { PreToolUse?: Array<{ hooks: Array<{ command: string }> }> }; permissions?: { deny?: string[]; allow?: string[] }; enabledPlugins?: unknown; autoMemoryEnabled?: boolean };
  return { status: ran.status, stderr: ran.stderr.trim(), commands: (merged.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks.map((hook) => hook.command)), deny: merged.permissions?.deny ?? null, allow: merged.permissions?.allow ?? null, plugins: merged.enabledPlugins ?? null, dir };
});

// n620: which catalog records can reach a check's environment.
await section("keys", () => {
  const ssh = { name: "DEPLOY", kind: "ssh" as const, value: null, access: { host: "h", username: "u", password: "pw", privateKey: "-----BEGIN-----" } };
  return { secret: envForRecord({ name: "STRIPE", kind: "secret", value: "tok", access: null }), login: envForRecord({ name: "SHOP", kind: "login", value: null, access: { username: "qa", password: "pw", url: "https://s.test" } }), ssh: envForRecord(ssh), ftp: envForRecord({ ...ssh, kind: "ftp" }) };
});

// n621: the guard's permit gate: a dangerous call files a ticket, a grant for exactly that call is used once.
await section("permit", () => {
  const dir = scratch("permit");
  const ran = spawnSync("python3", ["-c", `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("guard_shell", ${JSON.stringify(join(ROOT, "lane-stack/hooks/guard_shell.py"))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.PERMIT_DIR = __import__("pathlib").Path(${JSON.stringify(dir)})
p = {"session_id": "s1", "cwd": ${JSON.stringify(dir)}}
cmd = "sqlite3 app.db 'DROP TABLE sessions'"
os.environ["LANE_PILOT_ROLE"] = "writer"
first = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
folder = list(mod.PERMIT_DIR.glob("s1"))[0]
digest = next(folder.glob("*.ticket.json")).name.split(".")[0]
(folder / f"{digest}.answer.json").write_text(json.dumps({"decision": "allow"}))
second = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
third = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
print(json.dumps({"first": "Permit ticket" in (first or ""), "second": second, "third": "Permit ticket" in (third or "")}))
`], { encoding: "utf8" });
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}");
});

// n622: the capsule written before compaction.
await section("capsule", () => {
  const capsule = buildCapsule({ asks: Array.from({ length: 8 }, (_, index) => `ask-${index}-${"x".repeat(400)}`), files: Array.from({ length: 40 }, (_, index) => `f${index}`), claims: Array.from({ length: 40 }, (_, index) => `c${index}`), trigger: "precompact" });
  return { asks: capsule.asks.length, firstAsk: capsule.asks[0]!.slice(0, 5), askLength: capsule.asks[0]!.length, files: capsule.files.length, claims: capsule.claims.length, trigger: capsule.trigger };
});

console.log(JSON.stringify(out)); // guardian: allow (the scene reads this line)
process.exit(0);
