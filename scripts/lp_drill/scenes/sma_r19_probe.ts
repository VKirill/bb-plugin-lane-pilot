// What the region scene sma_r19.py cannot ask in Python: the real install, update and removal code of the commit under drill, run against TEMP home
// folders and a scratch database (no real home, no model, no hub write, no network). Prints one JSON line of observed values. It judges nothing: the
// scene compares each value with the node card's expected result and prove()s it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { isOffered, loadWorkflowStore } from "../../../packages/workflow-engine/src";
import { stackRpc } from "../../../src/rooms/native-install/server/rpc/stack";
import { registerCli } from "../../../src/rooms/tools/server/cli";
import { createCore } from "../../../src/rooms/core/server/core";
import { migrations } from "../../../src/rooms/migrations";
import { NATIVE_HOOK_SOURCES } from "../../../src/rooms/contracts/server";
import { BUILTIN_SOURCES } from "../../../src/rooms/workflow/builtin";
import { removeClaudeLaneLeftovers, stripClaudeLaneSettings } from "../../../src/rooms/native-install/claude-lane-leftovers";
import { applyInstalledGuard, isOwnedPmGuardApplied, ownedPmGuardPath } from "../../../src/rooms/native-install/guard-apply";
import { experimental_vkLifecycle } from "../../../src/rooms/native-install/native-install-lifecycle";
import { nativeInstallOperation } from "../../../src/rooms/native-install/native-install-host";
import { hashBytes, planJson, safeTarget, transitionOwned, type NativeInstallManifest } from "../../../src/rooms/native-install/native-install-owned";
import { materializeNativeHookSession } from "../../../src/rooms/native-agent/native-session-hooks";
import { sessionOverrideAgentsJson } from "../../../src/rooms/native-agent/native-agent-definition";
import { compileMainAgentProfile } from "../../../src/rooms/native-agent/agent-profile";
import { employeeRoleLines, recordRoleLine, withRoleLines } from "../../../src/rooms/native-agent/employee-lessons";
import { excludeBookkeeping } from "../../../src/rooms/verification/server/bookkeeping-exclude";
import { pmResumeInstructions, pmRulesPromptBlock } from "../../../src/rooms/learning/pm-rules";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createRun, loadProjectSettings, savePrototypeConfig, setRunThread } from "../../../src/rooms/storage";
import { runWorkflowTool } from "../../../src/rooms/workflow/server/workflow-tools";
import type { Services } from "../../../server";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const read = (path: string) => readFileSync(path, "utf8");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, tree(path, base));
    else out[relative(base, path)] = sha(path);
  }
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Settings = { theme?: string; hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };

function laneHome() {
  const home = join(tmp("r19-"), "home");
  mkdirSync(home, { recursive: true });
  put(join(home, ".claude/settings.json"), `{\n  // the person's own note\n  "theme": "owner",\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }, { "type": "command", "command": "python3 ${home}/.agents/hooks/guard_shell.py" }] }\n    ],\n    "Stop": [\n      { "hooks": [{ "type": "command", "command": "python3 ${home}/.agents/hooks/sma_hooks.py" }] },\n      { "hooks": [{ "type": "command", "command": "node /opt/gitnexus/hook.js" }] }\n    ]\n  }\n}\n`);
  put(join(home, ".codex/config.toml"), `# person's codex note\nmodel = "gpt"\n\n[plugins."codex-lane@claude-lane-stack"]\nenabled = true\n\n[skills]\n# person skills note\npath = "/home/p/skills"\n`);
  put(join(home, ".agents/hooks/guard_shell.py"), "# lane guard\n");
  put(join(home, ".agents/hooks/sma_hooks.py"), "# lane hooks\n");
  for (const name of ["lane-ctl", "lane-foo", "lane-memory"]) put(join(home, ".agents/bin", name), "#!/bin/sh\n");
  put(join(home, ".agents/bin/mytool"), "#!/bin/sh\necho mine\n");
  put(join(home, ".local/share/claude-lane-stack-installed/install.sh"), "# old installer\n");
  for (const name of ["lane-writer.md", "lane-critic.md", "lane-reviewer.md"]) put(join(home, ".config/opencode/agents", name), `# ${name}\n`);
  put(join(home, ".config/opencode/agents/custom.md"), "my own agent\n");
  put(join(home, ".agents/memory/MEMORY.md"), "person notes\n");
  put(join(home, ".agents/skills/shared/SKILL.md"), "canon\n");
  put(join(home, ".agents/state/keep"), "state\n");
  return home;
}
const corpus = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => /^\.agents\/(memory|skills|state)\//.test(name)));

async function main() {
  const out: Record<string, unknown> = {};

  // n1464 / n1468 / n1469 / n1496: one apply on a home the old installer left behind.
  {
    const home = laneHome();
    const before = tree(home);
    const report = await removeClaudeLaneLeftovers({ home, apply: true });
    const settings = read(join(home, ".claude/settings.json"));
    const parsed = JSON.parse(settings.replace(/\/\/.*\n/, "")) as Settings;
    const again = await removeClaudeLaneLeftovers({ home, apply: true });
    out.n1464 = { theme: parsed.theme, commentKept: settings.includes("// the person's own note"), pre: parsed.hooks!.PreToolUse![0]!.hooks.map((h) => h.command), stop: parsed.hooks!.Stop!.map((g) => g.hooks.map((h) => h.command)), codexKept: !read(join(home, ".codex/config.toml")).includes("codex-lane") && read(join(home, ".codex/config.toml")).includes("person skills note"), again: again.changed };
    out.n1468 = { moved: report.moved.map((p) => relative(home, p)).sort(), bin: readdirSync(join(home, ".agents/bin")), agents: readdirSync(join(home, ".config/opencode/agents")) };
    out.n1469 = { corpusSame: same(corpus(tree(home)), corpus(before)), files: Object.keys(corpus(before)).length };
    out.n1496 = { moved: report.moved.includes(join(home, ".local/share/claude-lane-stack-installed")), gone: !existsSync(join(home, ".local/share/claude-lane-stack-installed")), backup: read(join(report.backupDir!, ".local__share__claude-lane-stack-installed/install.sh")) };
  }

  // n1465 / n1466: a dry run, then four ways of not saying yes, change no byte; the plan lists the commands and the moves.
  {
    const home = laneHome();
    const before = tree(home);
    const plan = await removeClaudeLaneLeftovers({ home });
    const planned = { apply: plan.apply, settings: plan.settings.map((s) => s.replace(home, "~")), hasMoves: plan.moved.includes(join(home, ".agents/hooks")), untouched: same(tree(home), before) };
    const attempts: boolean[] = [];
    for (const apply of [undefined, false, "yes" as unknown as boolean, 1 as unknown as boolean]) {
      const r = await removeClaudeLaneLeftovers({ home, apply });
      attempts.push(r.apply === false && same(tree(home), before));
    }
    out.n1465 = planned;
    const yes = await removeClaudeLaneLeftovers({ home, apply: true });
    out.n1466 = { notYes: attempts, yes: yes.apply, moved: !existsSync(join(home, ".agents/bin/lane-ctl")) };
  }

  // n1467: the verb on a fake machine whose host side is the real handler pointed at a temp home.
  {
    const home = laneHome();
    const asked: unknown[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", experimental_callHostRpc: (async (call: { method: string; input: { apply?: boolean } }) => { asked.push(call.input.apply); return removeClaudeLaneLeftovers({ home, apply: call.input.apply === true }); }) as never });
    registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
    const before = tree(home);
    const dry = JSON.parse((await harness.behavior.runCli(["remove-claude-lane-leftovers", "host-a"])).stdout) as { apply: boolean };
    const dryUntouched = same(tree(home), before);
    const done = JSON.parse((await harness.behavior.runCli(["remove-claude-lane-leftovers", "host-a", "--apply"])).stdout) as { apply: boolean };
    out.n1467 = { dry: dry.apply, dryUntouched, applied: done.apply, gone: !existsSync(join(home, ".agents/bin/lane-ctl")), asked };
    await harness.lifecycle.dispose();
  }

  // n1470: the managed block in a file of the person: added, cut with the person's lines byte for byte, torn markers refused.
  {
    const root = tmp("r19-blocks-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const managed = join(root, "managed");
    mkdirSync(managed, { recursive: true });
    const manifest = (): NativeInstallManifest => ({ schemaVersion: 1, home, sourceSha: "a".repeat(40), state: "prepared", files: [], json: [], blocks: [{ path: "CLAUDE.md", text: "where memory is" }], preserved: [], createdConfigs: [], createdDirs: [] });
    const mine = "# my project\n\nline one\nline two without newline";
    put(join(home, "CLAUDE.md"), mine);
    await transitionOwned(managed, manifest(), "enable");
    await transitionOwned(managed, manifest(), "remove");
    const restored = read(join(home, "CLAUDE.md"));
    const refused: boolean[] = [];
    for (const torn of ["person line\n# lane-pilot:managed:start\norphaned without an end\n", "person line\norphaned without a start\n# lane-pilot:managed:end\n"]) {
      put(join(home, "CLAUDE.md"), torn);
      let threw = false;
      try { await transitionOwned(managed, manifest(), "enable"); } catch { threw = true; }
      refused.push(threw && read(join(home, "CLAUDE.md")) === torn);
    }
    out.n1470 = { restored: restored === `${mine}\n`, refused };
  }

  // n1471: only the entries that run a file of ~/.agents/hooks go; foreign ones, an emptied group and an emptied event are handled.
  {
    const home = "/home/p";
    const text = JSON.stringify({ theme: "owner", hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: `python3 ${home}/.agents/hooks/guard_shell.py` }, { type: "command", command: "python3 ~/.agents/hooks/a.py" }, { type: "command", command: "python3 $HOME/.agents/hooks/b.py" },
        { type: "command", command: "python3 ${HOME}/.agents/hooks/c.py" }, { type: "command", command: "bash /usr/local/bin/guardian-code.sh" }, { type: "command", command: `python3 ${home}/.agents/hooks-other/d.py` }] }],
      SessionStart: [{ hooks: [{ type: "command", command: `python3 ${home}/.agents/hooks/sma_hooks.py` }] }],
      Stop: [{ hooks: [{ type: "command", command: "node /opt/gitnexus/hook.js" }] }] } });
    const result = stripClaudeLaneSettings(text, home);
    const parsed = JSON.parse(result.text) as Settings;
    out.n1471 = { removed: result.removed.length, pre: parsed.hooks!.PreToolUse![0]!.hooks.map((h) => h.command), sessionStart: parsed.hooks!.SessionStart ?? null, stop: parsed.hooks!.Stop![0]!.hooks[0]!.command, theme: parsed.theme };
  }

  // n1472: the person's own status line comes back from the installer's record, exactly; with no record the key goes and nothing is guessed.
  {
    const home = join(tmp("r19-sl-"), "home");
    const wrapped = JSON.stringify({ statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` } });
    const record = { type: "command", command: "node /opt/my-line.js --fancy", padding: 2 };
    put(join(home, ".claude/settings.json"), wrapped);
    put(join(home, ".agents/state/statusline.prev.json"), JSON.stringify(record));
    await removeClaudeLaneLeftovers({ home, apply: true });
    const restored = JSON.parse(read(join(home, ".claude/settings.json"))) as { statusLine?: unknown };
    const none = JSON.parse(stripClaudeLaneSettings(wrapped, home).text) as { statusLine?: unknown };
    out.n1472 = { restored: restored.statusLine, withoutRecord: none.statusLine ?? null };
  }

  // n1473: removing the plugin runs remove on every registered machine: owned files and keys go, the person's stay, the registry row is dropped.
  {
    const root = tmp("r19-self-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const managed = join(root, "managed");
    put(join(managed, "payload/tool"), "owned");
    put(join(home, "settings.jsonc"), '// keep comment\n{"foreign": true}\n');
    put(join(home, ".agents/bin/personal"), "mine");
    const manifest: NativeInstallManifest = { schemaVersion: 1, home, sourceSha: "c".repeat(40), state: "prepared", files: [{ path: ".agents/lane-pilot/bin/tool", payload: "payload/tool", mode: 0o755, hash: hashBytes("owned") }], json: await planJson(home, "settings.jsonc", { hooks: { Start: ["lane"] } }), blocks: [], preserved: [], createdConfigs: [], createdDirs: [] };
    await transitionOwned(managed, manifest, "enable");
    const store = new Map<string, unknown>([["native-install:host:h1", { hostId: "h1" }]]);
    const kv = { list: async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix)), get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } };
    await experimental_vkLifecycle({ action: "remove", kv: kv as never, signal: new AbortController().signal, callHost: async (args) => nativeInstallOperation({ root: managed, home, action: (args.input as { action: "remove" }).action }) });
    const settings = read(join(home, "settings.jsonc"));
    store.set("native-install:host:h2", { hostId: "h2" });
    let stopped = "";
    try { await experimental_vkLifecycle({ action: "remove", kv: kv as never, signal: new AbortController().signal, callHost: async () => { throw new Error("machine offline"); } }); } catch (e) { stopped = (e as Error).message; }
    out.n1473 = { ownedGone: !existsSync(join(home, ".agents/lane-pilot/bin/tool")), rootGone: !existsSync(managed), foreign: settings.includes("// keep comment") && settings.includes('"foreign": true'), ownedKeyGone: !settings.includes('"Start"'), personal: read(join(home, ".agents/bin/personal")), rowsAfterRemove: [...store.keys()].filter((k) => k !== "native-install:host:h2"), stopped, kept: [...store.keys()] };
  }

  // n1474 / n1477: install into an empty home with the person's files; status reads what is on disk.
  {
    const root = tmp("r19-npx-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    put(join(home, ".claude/settings.json"), '{ "theme": "owner" }\n');
    put(join(home, "CLAUDE.md"), "my notes\n");
    const managed = join(root, "managed");
    const before = tree(home);
    const absent = (await nativeInstallOperation({ root: managed, home, action: "status" })).status;
    const installed = (await nativeInstallOperation({ root: managed, home, action: "install" })).status;
    const guardSame = sha(ownedPmGuardPath(home)) === sha(GUARD);
    const after = tree(home);
    const personOnly = Object.fromEntries(Object.entries(after).filter(([n]) => !n.startsWith(".agents/")));
    const again = (await nativeInstallOperation({ root: managed, home, action: "install" })).status;
    out.n1474 = { installed, guardSame, personSame: same(personOnly, before), repeatSame: same(tree(home), after) && again === "enabled" };
    const statusOn = (await nativeInstallOperation({ root: managed, home, action: "status" })).status;
    const { rmSync } = await import("node:fs");
    rmSync(ownedPmGuardPath(home));
    const statusOff = (await nativeInstallOperation({ root: managed, home, action: "status" })).status;
    out.n1477 = { before: absent, after: statusOn, guardGone: statusOff };
  }

  // n1476: an owned path must stay inside the home.
  {
    const home = tmp("r19-safe-");
    const reasons: string[] = [];
    mkdirSync(join(home, "real-agents"));
    symlinkSync(join(home, "real-agents"), join(home, "linked-agents"));
    for (const name of ["../outside/tool", "/etc/passwd", "linked-agents/bin/tool"]) { try { await safeTarget(home, name); reasons.push("accepted"); } catch (e) { reasons.push((e as Error).message.replace(home, "~").slice(0, 40)); } }
    out.n1476 = { reasons, real: (await safeTarget(home, "real-agents/bin/tool")) === join(home, "real-agents/bin/tool") };
  }

  // n1478 / n1479 / n1486 / n1497: a session's hook files, from the bundle, in the session folder; a project hook copied beside them.
  {
    const project = tmp("r19-proj-");
    const dest = tmp("r19-sess-");
    put(join(project, "tools/check.py"), "print('project check')\n");
    put(join(project, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 ./tools/check.py --strict" }, { type: "command", command: "python3 ./../outside.py" }] }] } }));
    const before = tree(project);
    const { settingsPath } = await materializeNativeHookSession({ cwd: project, destDir: dest });
    const settings = JSON.parse(read(settingsPath)) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    const bash = settings.hooks.PreToolUse!.find((g) => g.matcher === "Bash")!.hooks.map((h) => h.command);
    const copied = join(dest, "hooks/orig-0-check.py");
    out.n1478 = { calls: bash[0]!.endsWith(`python3 ${copied} --strict`), copied: read(copied), outside: bash[1]!.includes("python3 ./../outside.py"), origs: readdirSync(join(dest, "hooks")).filter((n) => n.startsWith("orig-")), projectSame: same(tree(project), before) };
    const all = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    const missing = all.flatMap((c) => [...c.matchAll(/'([^']+)'/g)].map((m) => m[1]!)).filter((f) => !existsSync(f));
    out.n1479 = { commands: all.length, missing, guardLine: all.find((c) => c.includes("guard_shell.py")) === `python3 '${join(dest, "hooks/inject_agent_type.py")}' -- python3 '${join(dest, "hooks/guard_shell.py")}'` };
    out.n1486 = { events: Object.keys(settings.hooks).sort(), onceEach: ["SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStop", "PostToolUse", "SessionEnd"].every((e) => same(settings.hooks[e]!.flatMap((g) => g.hooks.map((h) => h.command)), [`node '${join(dest, "hooks/session-hook.mjs")}'`])) };
    const bundled = ["guard_shell.py", "inject_agent_type.py", "lib_payload.py"].map((name) => read(join(dest, "hooks", name)) === NATIVE_HOOK_SOURCES[name]);
    put(join(dest, "hooks/guard_shell.py"), "# stale\n");
    await materializeNativeHookSession({ destDir: dest });
    out.n1497 = { bundled, refreshed: read(join(dest, "hooks/guard_shell.py")) === NATIVE_HOOK_SOURCES["guard_shell.py"] };
  }

  // n1480 / n1481: roles become definitions; the owner's lines follow a new role text.
  {
    const dev = compileMainAgentProfile("dev-orchestrator");
    const lead = compileMainAgentProfile("copy-lead");
    const defs = [["dev-orchestrator", dev], ["copy-lead", lead]].map(([id, compiled]) => { const json = JSON.parse(sessionOverrideAgentsJson({ agentId: id as string, edited: false, compiled: compiled as typeof dev })!) as Record<string, { description: string; prompt: string }>; const d = Object.values(json)[0]!; return d.description === (compiled as typeof dev).description && d.prompt === (compiled as typeof dev).prompt; });
    out.n1480 = { defs, distinct: dev.prompt !== lead.prompt };
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    await recordRoleLine(bb.storage.kv, "proj", "dev-orchestrator", "2026-11-01: never touch the lock file");
    await recordRoleLine(bb.storage.kv, "proj", "dev-orchestrator", "2026-11-03: keep the diff small");
    const lines = await employeeRoleLines(bb, "proj", "dev-orchestrator");
    const edited = compileMainAgentProfile("copy-lead", { prompt: "an edited role text" });
    out.n1481 = { lines, tail: withRoleLines(edited, lines).prompt.slice(edited.prompt.length), unchanged: withRoleLines(dev, []) === dev };
  }

  // n1482 / n1483: the offered list; a published graph starts by id, a fragment is refused.
  {
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES.map((s) => ({ name: s.name, value: { ...(s.value as object), status: "published" } })) });
    const all = store.list().map((i) => i.workflow);
    const offered = all.filter(isOffered).map((w) => w.id);
    out.n1482 = { offered: offered.length, all: all.length, code: offered.includes("code-review"), fragment: offered.includes("lp.build"), pipeline: offered.includes("lp-task-pipeline"), rule: all.every((w) => isOffered(w) === (!w.internal && !w.startedBy)) };
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "lprun-r19", "proj-r19", "cli");
    setRunThread(db, "lprun-r19", "pm-r19");
    const started: string[] = [];
    const engine = { start: (input: { workflow: { id: string } }) => { started.push(input.workflow.id); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; }, get: () => null, snapshot: () => null };
    const deps = { db, store: async () => store, engine: () => engine as never, runtime: (input: object) => ({ ctx: {} as never, services: {} as never, ...input }), warn: () => undefined } as never;
    const ctx = { threadId: "pm-r19", projectId: "proj-r19" };
    const ran = JSON.parse(await runWorkflowTool(deps, { workflowId: "companion", inputs: { goal: "x" } }, ctx)) as { status: string };
    const refused = JSON.parse(await runWorkflowTool(deps, { workflowId: "lp.build", inputs: {} }, ctx)) as { status: string };
    out.n1483 = { ran: ran.status, refused: refused.status, started };
  }

  // n1487 / n1488 / n1489 / n1490: the guard hook in a workspace's settings.
  {
    const home = join(tmp("r19-guard-"), "it's a home");
    mkdirSync(home, { recursive: true });
    const guard = ownedPmGuardPath(home);
    const ws = join(home, "pm");
    const file = join(ws, ".claude/settings.json");
    put(file, `{\n  // owner note\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/first.sh" }] },\n      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/second.sh" }] }\n    ]\n  }\n}\n`);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: ws });
    const once = read(file);
    const parsed = JSON.parse(once.replace(/\/\/.*\n/, "")) as Settings;
    const command = parsed.hooks!.PreToolUse!.at(-1)!.hooks[0]!.command;
    const echoed = spawnSync("sh", ["-c", `set -- ${command.replace(/^python3 /, "")}; printf '%s' "$1"`], { cwd: "/", encoding: "utf8" }).stdout;
    out.n1487 = { command, resolves: echoed === guard && existsSync(echoed) };
    out.n1489 = { matchers: parsed.hooks!.PreToolUse!.map((g) => g.matcher), comment: once.includes("// owner note") };
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: ws });
    out.n1489 = { ...(out.n1489 as object), repeatSame: read(file) === once };
    // The stale copies are checked on a home without a quote in its name (the quoting variants below are written by hand).
    const home2 = join(tmp("r19-stale-"), "home");
    mkdirSync(home2, { recursive: true });
    const guard2 = ownedPmGuardPath(home2);
    const ws2 = join(home2, "pm");
    const file2 = join(ws2, ".claude/settings.json");
    const q = (value: string) => `'${value}'`;
    put(file2, `{\n  // owner note\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 ${q(guard2)}", "timeout": 5 }] },\n      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 \\"${guard2}\\"", "timeout": 9 }, { "type": "command", "command": "echo person" }] },\n      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 ${guard2}", "timeout": 11 }] }\n    ]\n  }\n}\n`);
    await applyInstalledGuard({ homeDir: home2, guardSourcePath: GUARD, pmWorkspacePath: ws2 });
    const cut = read(file2);
    out.n1490 = { copies: cut.split(guard2).length - 1, firstKept: cut.includes('"timeout": 5') && !cut.includes('"timeout": 9') && !cut.includes('"timeout": 11'), person: cut.includes("echo person") && cut.includes("// owner note") };
    const refused: boolean[] = [];
    for (const broken of ["{ not json\n", "[]\n", '{ "hooks": "nope" }\n', '{ "hooks": { "PreToolUse": {} } }\n']) {
      put(file, broken);
      let threw = false;
      try { await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: ws }); } catch { threw = true; }
      refused.push(threw && read(file) === broken);
    }
    out.n1488 = { refused };
  }

  // n1492: the bookkeeping lines go into .git/info/exclude after the person's last line, once; no .gitignore.
  {
    const repo = tmp("r19-dirs-");
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".git/info/exclude"), "# my own\nbuild/");
    const run = async (input: { command: string; cwd: string }) => { const ran = spawnSync("sh", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" }); return { exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" }; };
    const added = await excludeBookkeeping(run, "h1", repo, () => undefined);
    const text = read(join(repo, ".git/info/exclude"));
    const second = await excludeBookkeeping(run, "h1", repo, () => undefined);
    out.n1492 = { added: added.length, text, second, repeatSame: read(join(repo, ".git/info/exclude")) === text, gitignore: existsSync(join(repo, ".gitignore")) };
  }

  // n1493: a database from before the memory table is brought forward and its notes are kept.
  {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    const fts = migrations.findIndex((s) => s.includes("lane_pilot_memory_fts USING fts5"));
    bb.storage.migrate(db, [...migrations.slice(0, fts + 1)]);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('old','p','note','owner','the old note','[\"zorblax\"]','s',1)").run();
    db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES('old','p','the old note','zorblax')").run();
    const oldHadStatus = (db.prepare("PRAGMA table_info(lane_pilot_memory)").all() as Array<{ name: string }>).some((c) => c.name === "status");
    bb.storage.migrate(db, [...migrations]);
    out.n1493 = {
      oldHadStatus, kept: db.prepare("SELECT content, status, trust FROM lane_pilot_memory WHERE id='old'").get(),
      ftsColumns: (db.prepare("PRAGMA table_info(lane_pilot_memory_fts)").all() as Array<{ name: string }>).map((c) => c.name),
      found: db.prepare("SELECT id FROM lane_pilot_memory_fts WHERE lane_pilot_memory_fts MATCH 'concepts:zorblax'").all(),
    };
  }

  // n1494: the PM rules reach the prompt block; a writer-only rule does not; no CLAUDE.md is written.
  {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const cwd = tmp("r19-rules-");
    put(join(cwd, "CLAUDE.md"), "person bytes\n");
    const before = tree(cwd);
    const none = pmResumeInstructions(db, "proj-r19", []);
    const rule = (id: string, text: string, audience: string) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`mem-${id}`, "proj-r19", "", "core", "subagent", text, "[\"rule\"]", "s", 1);
      db.prepare("INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`r-${id}`, "proj-r19", `s-${id}`, text, "owner", "accepted", 1, 1, "[]", `mem-${id}`, 1, 1, 1, 1, audience);
    };
    rule("pm", "Never plan past the signed context", "pm");
    rule("writer", "Writers keep tests next to code", "writer");
    const text = pmResumeInstructions(db, "proj-r19", []) ?? "";
    out.n1494 = { none, pm: text.includes("Never plan past the signed context"), writer: text.includes("Writers keep tests next to code"), claudeMdSame: same(tree(cwd), before) };
  }

  // n1495: a confirmed install returns and stores the receipt; a refusing machine is reported and the receipt stays.
  {
    let fail = false;
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", experimental_callHostRpc: ((_call: unknown) => { if (fail) throw new Error("machine refused the install"); return { status: "enabled", sourceSha: null, ownedFiles: 0, preservedFiles: 0 }; }) as never });
    (bb.server as unknown as { experimental_vkPluginLifecycle?: boolean }).experimental_vkPluginLifecycle = true;
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "p-done", hostId: "host-done", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" });
    const rpc = stackRpc(createCore(bb, db) as never);
    const blocked = await rpc.stack_install({ projectId: "p-done", confirmExternalOps: false }) as { status: string };
    const storedBlocked = loadProjectSettings(db, "p-done")["install.lastReceipt"] ?? null;
    const ok = await rpc.stack_install({ projectId: "p-done", confirmExternalOps: true }) as { status: string; native: { status: string } };
    const saved = JSON.parse(String(loadProjectSettings(db, "p-done")["install.lastReceipt"])) as { status: string; native: { status: string } };
    fail = true;
    let error = "";
    try { await rpc.stack_install({ projectId: "p-done", confirmExternalOps: true }); } catch (e) { error = (e as Error).message; }
    const afterFail = JSON.parse(String(loadProjectSettings(db, "p-done")["install.lastReceipt"])) as { status: string };
    out.n1495 = { blocked: blocked.status, storedBlocked, ok: ok.status, native: ok.native.status, saved: [saved.status, saved.native.status], error, afterFail: afterFail.status };
  }
  // ---- batch b (n1498 … n1516) ----
  const bTree = (dir: string) => tree(dir);
  const bRule = (db: ReturnType<typeof openDatabase>, project: string, id: string, text: string, decidedAt: number, audience: string) => {
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`mem-${id}`, project, "", "core", "subagent", text, "[\"rule\"]", "s", 1);
    db.prepare("INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`r-${id}`, project, `s-${id}`, text, "owner", "accepted", 1, 1, "[]", `mem-${id}`, 1, 1, 1, decidedAt, audience);
  };

  // n1498 roles ride in --agents; n1500 the session settings are a copy: nothing is written into the project.
  {
    const project = tmp("r19b-project-");
    put(join(project, ".claude/agents/mine.md"), "my own role\n");
    put(join(project, ".claude/settings.json"), JSON.stringify({ model: "claude-person", env: { KEEP_ME: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo person" }] }] } }));
    put(join(project, ".claude/settings.local.json"), JSON.stringify({ model: "claude-local" }));
    const before = bTree(project);
    const dest = tmp("r19b-session-");
    const compiled = compileMainAgentProfile("dev-orchestrator");
    const json = JSON.parse(sessionOverrideAgentsJson({ agentId: "dev-orchestrator", edited: false, compiled })!) as Record<string, { description: string; prompt: string }>;
    const result = await materializeNativeHookSession({ cwd: project, destDir: dest });
    const merged = JSON.parse(read(result.settingsPath)) as { model: string; env: unknown; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const pre = merged.hooks.PreToolUse!.flatMap((g) => g.hooks.map((h) => h.command));
    out.n1498 = { keys: Object.keys(json), description: json[Object.keys(json)[0]!]!.description === compiled.description, prompt: json[Object.keys(json)[0]!]!.prompt === compiled.prompt, projectSame: same(bTree(project), before), agents: readdirSync(join(project, ".claude/agents")) };
    out.n1500 = { inSession: result.settingsPath === join(dest, "settings.json"), projectSame: same(bTree(project), before), model: merged.model, env: merged.env, person: pre.some((c) => c.endsWith("-- echo person")), guards: pre.filter((c) => c.includes("guard_shell.py")).length };
  }

  // n1501 the state is rows in the plugin database, not a folder in the project.
  {
    const project = tmp("r19b-state-");
    put(join(project, "README.md"), "the project\n");
    const before = bTree(project);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "lprun-b1", "proj-b", "cli");
    out.n1501 = { runs: db.prepare("SELECT id, project_id, state FROM lane_pilot_run").all(), secondHandle: (bb.storage.database().prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number }).n, fk: db.pragma("foreign_keys", { simple: true }), projectSame: same(bTree(project), before), noSmaFolder: !existsSync(join(project, ".sma")) };
  }

  // n1502 / n1505 the rules go into the prompt; a CLAUDE.md with torn markers is left alone.
  {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const cwd = tmp("r19b-rules-");
    put(join(cwd, "CLAUDE.md"), "person line\n<!-- lane-pilot:rules:start -->\n# lane-pilot:managed:start\ntorn, no end marker\n");
    const before = bTree(cwd);
    const empty = pmRulesPromptBlock(db, "proj-b", [], 1600);
    bRule(db, "proj-b", "old", "Never plan past the signed context, whatever the owner's hurry says", 1, "pm");
    bRule(db, "proj-b", "new", "Quote the contract wording when you ask the owner a question", 2, "pm");
    const block = pmRulesPromptBlock(db, "proj-b", [], 1600);
    out.n1502 = { empty, lines: block.split("\n").slice(3), marker: block.includes("lane-pilot:managed") || block.includes("<!--"), claudeMdSame: same(bTree(cwd), before) };
    bRule(db, "proj-e", "a", "Keep every diff under two hundred lines", 3, "both");
    bRule(db, "proj-e", "b", "Ask before touching the lock file", 2, "both");
    const resume = pmResumeInstructions(db, "proj-e", []) ?? "";
    out.n1505 = { lines: resume.split("\n").slice(1), torn: resume.includes("torn, no end marker"), claudeMdSame: same(bTree(cwd), before) };
  }

  // n1504 the memory scaffold: the table with its kind and audience rules, an empty full-text index.
  {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const empty = [count("lane_pilot_memory"), count("lane_pilot_memory_fts")];
    const insert = (id: string, kind: string, audience: string) => { try { db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "p", kind, audience, "text", "[]", "s", 1); return "ok"; } catch (e) { return /CHECK/.test((e as Error).message) ? "refused" : (e as Error).message; } };
    out.n1504 = { empty, inserts: [insert("a", "core", "owner"), insert("b", "note", "subagent"), insert("c", "scribble", "owner"), insert("d", "note", "stranger")], after: count("lane_pilot_memory") };
  }

  // n1508 / n1509 the install door: no yes, nothing runs; a yes runs the install on the project's machine.
  {
    const calls: Array<{ method: string; action: unknown; requested: unknown }> = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", experimental_callHostRpc: ((call: { method: string; input: { action?: string; requestedHostId?: string } }) => { calls.push({ method: call.method, action: call.input.action, requested: call.input.requestedHostId }); return { status: "enabled", sourceSha: null, ownedFiles: 0, preservedFiles: 0 }; }) as never });
    (bb.server as unknown as { experimental_vkPluginLifecycle?: boolean }).experimental_vkPluginLifecycle = true;
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "p-up", hostId: "host-up", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" });
    const rpc = stackRpc(createCore(bb, db) as never);
    const blocked = await rpc.stack_install({ projectId: "p-up", confirmExternalOps: false }) as { status: string; reason: string };
    const callsBlocked = calls.length, stored = loadProjectSettings(db, "p-up")["install.lastReceipt"] ?? null;
    const ok = await rpc.stack_install({ projectId: "p-up", confirmExternalOps: true }) as { status: string; native: { status: string } };
    out.n1508 = { blocked: blocked.status, reason: blocked.reason, callsBlocked, stored, ok: ok.status };
    const home = join(tmp("r19b-apply-"), "home");
    mkdirSync(home, { recursive: true });
    const managed = join(home, "..", "managed");
    const first = await nativeInstallOperation({ root: managed, home, action: "install" });
    const afterFirst = tree(join(home, ".agents/lane-pilot"));
    const second = await nativeInstallOperation({ root: managed, home, action: "install" });
    out.n1509 = { calls, hosts: await bb.storage.kv.list("native-install:host:"), first: first.status, second: second.status, guardIsBundle: sha(ownedPmGuardPath(home)) === sha(GUARD), repeatSame: same(tree(join(home, ".agents/lane-pilot")), afterFirst) };
  }

  // n1515 an update over the owner's files changes none of them, an edited guard stays as the owner left it.
  {
    const home = join(tmp("r19b-keep-"), "home");
    mkdirSync(home, { recursive: true });
    const managed = join(home, "..", "managed");
    const person: Record<string, string> = { ".agents/memory/MEMORY.md": "person notes\n", ".agents/skills/shared/SKILL.md": "canon\n", ".agents/state/keep": "state\n", ".claude/settings.json": "{\n  // mine\n  \"theme\": \"owner\"\n}\n", ".agents/bin/mytool": "#!/bin/sh\necho mine\n" };
    for (const [name, text] of Object.entries(person)) put(join(home, name), text);
    await nativeInstallOperation({ root: managed, home, action: "install" });
    const guard = ownedPmGuardPath(home);
    const placed = sha(guard) === sha(GUARD);
    const edited = `${read(guard)}# the owner's local patch\n`;
    writeFileSync(guard, edited);
    const status = (await nativeInstallOperation({ root: managed, home, action: "install" })).status;
    out.n1515 = { placed, status, personSame: Object.entries(person).every(([name, text]) => read(join(home, name)) === text), guardKept: read(guard) === edited };
  }

  // n1516 the check of the reapplied guard: applied only for the bundled file and exactly one hook entry; the owner's lines survive.
  {
    const home = join(tmp("r19b-verify-"), "home");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    put(settingsPath, `{\n  // owner note\n  "theme": "mine",\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }] }\n    ]\n  }\n}\n`);
    const check = () => isOwnedPmGuardApplied({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const guardPath = ownedPmGuardPath(home);
    const owner = () => read(settingsPath).includes("// owner note") && read(settingsPath).includes("bash /usr/local/bin/guardian-code.sh");
    const steps: boolean[] = [await check()];
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    steps.push(await check());
    const once = read(settingsPath);
    writeFileSync(settingsPath, once.replace(`python3 '${guardPath}'`, `python3 '${guardPath}'" }, { "type": "command", "command": "python3 '${guardPath}'`));
    steps.push(await check());
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    steps.push(await check());
    const repaired = read(settingsPath).split(guardPath).length - 1;
    const ownerKept = owner();
    writeFileSync(guardPath, "# changed\n");
    steps.push(await check());
    out.n1516 = { steps, repaired, ownerKept };
  }
  return out;
}

process.stdout.write(`${JSON.stringify(await main())}\n`); // the probe's one result line
