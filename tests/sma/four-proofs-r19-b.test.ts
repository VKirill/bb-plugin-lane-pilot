// Region 19 · Install, update, remove — batch b (n1498 … n1516). Every test runs the real install / update code against a temp home
// folder, a temp project folder or a scratch database and checks the files and rows afterwards, the person's own bytes included.
// Nothing here touches the real home. Nodes whose main claim lives in bb-core (the update check, the version report, the git range,
// the npm registry, the local source, the skill roots) are proved here only for Lane Pilot's own half; the core half is not proved.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { migrations } from "../../src/rooms/migrations";
import { applyInstalledGuard, isOwnedPmGuardApplied, ownedPmGuardPath } from "../../src/rooms/native-install/guard-apply";
import { nativeInstallOperation } from "../../src/rooms/native-install/native-install-host";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { sessionOverrideAgentsJson } from "../../src/rooms/native-agent/native-agent-definition";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { nativeAgentCliId } from "../../src/rooms/contracts/native-agent-id";
import { pmResumeInstructions, pmRulesPromptBlock } from "../../src/rooms/learning/pm-rules";
import { createRun, loadProjectSettings, openDatabase, savePrototypeConfig } from "../../src/rooms/plugin-db";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temp(prefix: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
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
type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
const commandsOf = (hooks: Hooks, event: string) => (hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

describe("what lives where in a project", () => {
  it("[sma:k_st_agents] roles reach a session as one --agents definition each (the compiled description and prompt), and nothing is written into the project's .claude/agents", async () => {
    const project = mkdtempSync(join(tmpdir(), "lp-r19b-agents-"));
    roots.push(project);
    put(join(project, ".claude/agents/mine.md"), "---\nname: mine\n---\nmy own role\n");
    const before = tree(project);
    const dest = mkdtempSync(join(tmpdir(), "lp-r19b-agents-dest-"));
    roots.push(dest);
    for (const id of ["dev-orchestrator", "copy-lead"]) {
      const compiled = compileMainAgentProfile(id);
      const json = JSON.parse(sessionOverrideAgentsJson({ agentId: id, edited: false, compiled })!) as Record<string, { description: string; prompt: string }>;
      expect(Object.keys(json)).toEqual([nativeAgentCliId(id)]);
      expect(json[nativeAgentCliId(id)]!.description).toBe(compiled.description);
      expect(json[nativeAgentCliId(id)]!.prompt).toBe(compiled.prompt);
    }
    // Building the session's hook settings next to the same project writes no role file there either; the person's role stays alone.
    await materializeNativeHookSession({ cwd: project, destDir: dest });
    expect(tree(project)).toEqual(before);
    expect(readdirSync(join(project, ".claude/agents"))).toEqual(["mine.md"]);
    expect(readFileSync(join(project, ".claude/agents/mine.md"), "utf8")).toBe("---\nname: mine\n---\nmy own role\n");
  });

  it("[sma:k_st_settings] the session's settings are a copy in the session folder: the person's settings and local settings stay byte for byte and their keys, hooks and local override all appear, the guard once", async () => {
    const project = mkdtempSync(join(tmpdir(), "lp-r19b-settings-"));
    const dest = mkdtempSync(join(tmpdir(), "lp-r19b-settings-dest-"));
    roots.push(project, dest);
    put(join(project, ".claude/settings.json"), JSON.stringify({ model: "claude-person", env: { KEEP_ME: "1" }, permissions: { allow: ["Bash(echo:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo person" }] }] } }, null, 2));
    put(join(project, ".claude/settings.local.json"), JSON.stringify({ model: "claude-local", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stopped" }] }] } }, null, 2));
    const before = tree(project);
    const result = await materializeNativeHookSession({ cwd: project, destDir: dest });
    expect(result.settingsPath).toBe(join(dest, "settings.json"));
    expect(tree(project)).toEqual(before);
    const merged = JSON.parse(readFileSync(result.settingsPath, "utf8")) as { model: string; env: unknown; permissions: unknown; hooks: Hooks };
    expect(merged.model).toBe("claude-local");
    expect(merged.env).toEqual({ KEEP_ME: "1" });
    expect(merged.permissions).toEqual({ allow: ["Bash(echo:*)"] });
    expect(commandsOf(merged.hooks, "Stop")).toEqual(["echo stopped"]);
    const pre = commandsOf(merged.hooks, "PreToolUse");
    expect(pre.some((command) => command.endsWith("-- echo person"))).toBe(true);
    expect(pre.filter((command) => command.includes("guard_shell.py"))).toHaveLength(1);
  });

  it("[sma:k_st_sma] the run state is rows in the plugin's own database (tables made by the migrations, foreign keys on), and a project folder gets no state folder", () => {
    const project = mkdtempSync(join(tmpdir(), "lp-r19b-state-"));
    roots.push(project);
    put(join(project, "README.md"), "the project\n");
    const before = tree(project);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "lprun-b1", "proj-b", "cli");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["lane_pilot_run", "lane_pilot_task", "lane_pilot_attempt", "lane_pilot_memory"]));
    expect(db.prepare("SELECT id, project_id, state FROM lane_pilot_run").all()).toEqual([{ id: "lprun-b1", project_id: "proj-b", state: "pending" }]);
    // The same database answers from a second handle: the state is in the store, not in the handle.
    expect((bb.storage.database().prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number }).n).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(tree(project)).toEqual(before);
    expect(existsSync(join(project, ".sma"))).toBe(false);
  });

  it("[sma:k_st_claudemd] the owner's rules reach the PM as a prompt block, whole rule lines in order; the project's CLAUDE.md gets no managed block and stays byte for byte", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const cwd = mkdtempSync(join(tmpdir(), "lp-r19b-claudemd-"));
    roots.push(cwd);
    put(join(cwd, "CLAUDE.md"), "person bytes\n");
    const before = tree(cwd);
    expect(pmRulesPromptBlock(db, "proj-b", [], 1600)).toBe("");
    const rule = (id: string, text: string, decidedAt: number) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`mem-${id}`, "proj-b", "", "core", "subagent", text, "[\"rule\"]", "s", 1);
      db.prepare("INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`r-${id}`, "proj-b", `s-${id}`, text, "owner", "accepted", 1, 1, "[]", `mem-${id}`, 1, 1, 1, decidedAt, "pm");
    };
    rule("old", "Never plan past the signed context, whatever the owner's hurry says", 1);
    rule("new", "Quote the contract wording when you ask the owner a question", 2);
    const block = pmRulesPromptBlock(db, "proj-b", [], 1600);
    const lines = block.split("\n");
    expect(lines[2]).toMatch(/^Rules the owner taught in this project/);
    expect(lines.slice(3)).toEqual(["- Quote the contract wording when you ask the owner a question", "- Never plan past the signed context, whatever the owner's hurry says"]);
    expect(block).not.toContain("lane-pilot:managed");
    expect(block).not.toContain("<!--");
    expect(tree(cwd)).toEqual(before);
  });

  it("[sma:k_lib_scaffold] the memory scaffold is the table with its kind and audience rules and an empty full-text index; no note is seeded and no MEMORY.md is written", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lp-r19b-scaffold-"));
    roots.push(cwd);
    const before = tree(cwd);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const columns = (db.prepare("PRAGMA table_info(lane_pilot_memory)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["id", "project_id", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at"]));
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts").get() as { n: number }).n).toBe(0);
    const insert = (id: string, kind: string, audience: string) => db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "p", kind, audience, "text", "[]", "s", 1);
    insert("a", "core", "owner");
    insert("b", "note", "subagent");
    expect(() => insert("c", "scribble", "owner")).toThrow(/CHECK/);
    expect(() => insert("d", "note", "stranger")).toThrow(/CHECK/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory").get() as { n: number }).n).toBe(2);
    expect(migrations.some((statement) => statement.includes("TAGS.md") || statement.includes("MEMORY.md"))).toBe(false);
    expect(tree(cwd)).toEqual(before);
  });

  it("[sma:k_lib_embed] the rules go into the prompt text, never spliced into a file: a CLAUDE.md with torn markers is not read or written, and a rule that does not fit whole is skipped, not cut", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const cwd = mkdtempSync(join(tmpdir(), "lp-r19b-embed-"));
    roots.push(cwd);
    put(join(cwd, "CLAUDE.md"), "person line\n<!-- lane-pilot:rules:start -->\n# lane-pilot:managed:start\ntorn, no end marker\n");
    const before = tree(cwd);
    const rule = (id: string, text: string, decidedAt: number) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`mem-${id}`, "proj-e", "", "core", "subagent", text, "[\"rule\"]", "s", 1);
      db.prepare("INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`r-${id}`, "proj-e", `s-${id}`, text, "owner", "accepted", 1, 1, "[]", `mem-${id}`, 1, 1, 1, decidedAt, "both");
    };
    expect(pmResumeInstructions(db, "proj-e", [])).toBeNull();
    rule("a", "Keep every diff under two hundred lines", 3);
    rule("b", "Ask before touching the lock file", 2);
    const text = pmResumeInstructions(db, "proj-e", [])!;
    expect(text.split("\n").slice(1)).toEqual(["- Keep every diff under two hundred lines", "- Ask before touching the lock file"]);
    expect(text).not.toContain("torn, no end marker");
    expect(tree(cwd)).toEqual(before);
  });
});

describe("the install and update door", () => {
  const door = () => {
    const calls: Array<{ method: string; action: unknown; requested: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: ((call: { method: string; input: { action?: string; requestedHostId?: string } }) => {
        calls.push({ method: call.method, action: call.input.action, requested: call.input.requestedHostId });
        return { status: "enabled", sourceSha: null, ownedFiles: 0, preservedFiles: 0 };
      }) as never,
    });
    (bb.server as unknown as { experimental_vkPluginLifecycle?: boolean }).experimental_vkPluginLifecycle = true;
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "p-up", hostId: "host-up", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" });
    return { bb, harness, db, calls };
  };

  it("[sma:k_up_confirm] without the one explicit yes the install returns «blocked», runs nothing on any machine and stores no receipt; with it the install runs", async () => {
    const { bb, harness, db, calls } = door();
    await plugin(bb);
    const blocked = await harness.behavior.callRpc("stack_install", { projectId: "p-up", confirmExternalOps: false });
    expect(blocked).toEqual({ schemaVersion: 1, action: "install", status: "blocked", reason: "Explicit installation confirmation is required; no operation was run." });
    expect(calls).toEqual([]);
    expect(loadProjectSettings(db, "p-up")["install.lastReceipt"]).toBeUndefined();
    expect(await bb.storage.kv.list("native-install:host:")).toEqual([]);
    const ok = await harness.behavior.callRpc("stack_install", { projectId: "p-up", confirmExternalOps: true });
    expect(ok).toEqual({ schemaVersion: 1, action: "install", status: "ok", native: { status: "enabled", sourceSha: null, ownedFiles: 0, preservedFiles: 0 } });
    expect(calls.length).toBeGreaterThan(0);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_up_apply] an update applies by re-running the standard installer on the project's machine only, and that installer is repeatable: the same bytes, an owner-edited guard kept", async () => {
    const { bb, harness, calls } = door();
    await plugin(bb);
    await harness.behavior.callRpc("stack_install", { projectId: "p-up", confirmExternalOps: true });
    expect(calls.filter((call) => call.method === "nativeInstall")).toEqual([{ method: "nativeInstall", action: "install", requested: "host-up" }]);
    expect(await bb.storage.kv.list("native-install:host:")).toEqual(["native-install:host:host-up"]);
    await harness.lifecycle.dispose();
    // The machine's side of that call: the same operation, run twice on a temp home, leaves the same bytes.
    const { root, home } = temp("lp-r19b-apply-");
    const managed = join(root, "managed");
    expect((await nativeInstallOperation({ root: managed, home, action: "install" })).status).toBe("enabled");
    const placed = join(home, ".agents/lane-pilot/pm/guard_shell.py");
    expect(sha(placed)).toBe(sha(GUARD));
    const once = tree(join(home, ".agents/lane-pilot"));
    expect((await nativeInstallOperation({ root: managed, home, action: "install" })).status).toBe("enabled");
    expect(tree(join(home, ".agents/lane-pilot"))).toEqual(once);
  });

  it("[sma:k_up_preserved] an update over a home that has the owner's memory, skills, state, settings and an edited guard changes none of them", async () => {
    const { root, home } = temp("lp-r19b-keep-");
    const managed = join(root, "managed");
    const person: Record<string, string> = {
      ".agents/memory/MEMORY.md": "person notes\n", ".agents/skills/shared/SKILL.md": "canon\n", ".agents/state/keep": "state\n",
      ".claude/settings.json": "{\n  // mine\n  \"theme\": \"owner\"\n}\n", ".agents/bin/mytool": "#!/bin/sh\necho mine\n",
    };
    for (const [name, text] of Object.entries(person)) put(join(home, name), text);
    expect((await nativeInstallOperation({ root: managed, home, action: "install" })).status).toBe("enabled");
    const guard = ownedPmGuardPath(home);
    expect(sha(guard)).toBe(sha(GUARD));
    const edited = `${readFileSync(guard, "utf8")}# the owner's local patch\n`;
    writeFileSync(guard, edited);
    expect((await nativeInstallOperation({ root: managed, home, action: "install" })).status).toBe("enabled");
    for (const [name, text] of Object.entries(person)) expect(readFileSync(join(home, name), "utf8"), name).toBe(text);
    expect(readFileSync(guard, "utf8")).toBe(edited);
  });

  it("[sma:k_up_verify_patches] the check of the reapplied guard says «applied» only for the file as bundled and exactly one hook entry; the owner's hook lines survive every reapply", async () => {
    const { home } = temp("lp-r19b-verify-");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    put(settingsPath, `{\n  // owner note\n  "theme": "mine",\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }] }\n    ]\n  }\n}\n`);
    const check = () => isOwnedPmGuardApplied({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const guardPath = ownedPmGuardPath(home);
    expect(await check()).toBe(false);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    expect(await check()).toBe(true);
    const owner = (text: string) => text.includes("// owner note") && text.includes('"theme": "mine"') && text.includes("bash /usr/local/bin/guardian-code.sh");
    expect(owner(readFileSync(settingsPath, "utf8"))).toBe(true);
    // A second copy of the guard entry is not «applied»: the check fails until a reapply repairs it, and the owner's lines are still there.
    const once = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, once.replace(`python3 '${guardPath}'`, `python3 '${guardPath}'" }, { "type": "command", "command": "python3 '${guardPath}'`));
    expect(await check()).toBe(false);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    expect(await check()).toBe(true);
    expect(readFileSync(settingsPath, "utf8").split(guardPath).length - 1).toBe(1);
    expect(owner(readFileSync(settingsPath, "utf8"))).toBe(true);
    // The owner took the entry out: not applied. The placed file differs from the bundle: not applied.
    writeFileSync(settingsPath, `{ "theme": "mine" }\n`);
    expect(await check()).toBe(false);
    writeFileSync(settingsPath, once);
    expect(await check()).toBe(true);
    writeFileSync(guardPath, "# changed\n");
    expect(await check()).toBe(false);
  });
});
