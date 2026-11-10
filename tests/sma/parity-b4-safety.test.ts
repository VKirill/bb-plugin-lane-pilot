import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { recordEvidence, listEvidence } from "../../src/rooms/storage";
import { conventionGateHits } from "../../src/rooms/session-hooks/logic";
import { noteProtectionDisarm, rearmExpiredDisarms, renewDisarm, integrityReport } from "../../src/rooms/policy/protections";
import { createRun, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");

function guard(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const ran = spawnSync("python3", [GUARD], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const bashPayload = (command: string, cwd: string, extra: Record<string, unknown> = {}) =>
  ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess-test", ...extra });

describe("git airbag and the dependency-store guard", () => {
  it("[sma:k_lib_airbag] a destructive git command first saves the tree as a ref", () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-airbag-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: process.env.HOME ?? "" });
    expect(out.stderr + out.stdout).not.toContain("deny");
    const refs = spawnSync("git", ["for-each-ref", "refs/lane-airbag/"], { cwd: repo, encoding: "utf8" }).stdout;
    expect(refs).toContain("refs/lane-airbag/");
    const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", "refs/lane-airbag/" + refs.trim().split("refs/lane-airbag/")[1]!.split(/\s/)[0]], { cwd: repo, encoding: "utf8" }).stdout;
    expect(tree).toContain("tracked.txt");
    expect(tree).toContain("new.txt");
    const body = spawnSync("git", ["show", `${refs.trim().split(/\s/)[0]}:tracked.txt`], { cwd: repo, encoding: "utf8" }).stdout;
    expect(body).toBe("edited\n");
  });

  it("[sma:k_lib_reflex] a lesson trigger fires on the matching act and tires", () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-reflex-"));
    writeFileSync(join(dir, "REFLEXES.md"), "- WHEN prisma migrate → run it on a copy of the DB first\n");
    const env = { LANE_PILOT_ROLE: "writer", HOME: mkdtempSync(join(tmpdir(), "sma-reflex-home-")) };
    const fire = () => guard(bashPayload("npx prisma migrate dev", dir), env);
    const first = fire(), second = fire(), third = fire();
    expect(first.stdout + second.stdout).toContain("run it on a copy of the DB first");
    expect(third.stdout).not.toContain("run it on a copy");
    expect(guard(bashPayload("npm test", dir), env).stdout).not.toContain("reflex");
  });

  it("[sma:k_lib_depsguard] an install through a linked store is refused and a plain copy is not", () => {
    const a = mkdtempSync(join(tmpdir(), "sma-depa-"));
    const b = mkdtempSync(join(tmpdir(), "sma-depb-"));
    mkdirSync(join(a, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(b, "node_modules"));
    symlinkSync(join(a, "node_modules", "pkg"), join(b, "node_modules", "pkg"));
    const denied = guard(bashPayload("npm install left-pad", b), { LANE_PILOT_ROLE: "writer" });
    expect(denied.stdout + denied.stderr).toContain("dependency store");
    const c = mkdtempSync(join(tmpdir(), "sma-depc-"));
    mkdirSync(join(c, "node_modules"));
    const allowed = guard(bashPayload("npm install left-pad", c), { LANE_PILOT_ROLE: "writer" });
    expect(allowed.stdout + allowed.stderr).not.toContain("deps-guard");
    const edit = guard({ tool_name: "Edit", tool_input: { file_path: join(b, "node_modules", "pkg", "index.js") }, cwd: b, session_id: "sess-test" }, { LANE_PILOT_ROLE: "writer" });
    expect(edit.stdout + edit.stderr).toContain("dependency store");
  });
});

describe("evidence records and protections", () => {
  const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

  it("[sma:k_lib_evidence] a risky operation stores its reason and checks first", async () => {
    const { bb, harness } = open();
    const kv = bb.storage.kv as never;
    await recordEvidence(kv, { op: "revert", projectId: "p", target: "t1", why: "gate red on main anyway", checks: [{ name: "integration_gate", ok: true, detail: "skipped" }], by: "cli", at: 2 });
    await recordEvidence(kv, { op: "permit", projectId: "p", target: "h/abc", why: "scratch table", checks: [{ name: "ticket", ok: true }], by: "lane_pilot_permit", at: 3 });
    const rows = await listEvidence(kv, "p");
    expect(rows[0]!.op).toBe("permit");
    expect(rows[0]!.why).toBe("scratch table");
    expect(rows[1]!.why).toContain("gate red");
    expect((await listEvidence(kv, "p", { op: "revert" })).map((r) => r.op)).toEqual(["revert"]);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_evidence] the records list operation, reason and checks, newest first", async () => {
    const { bb, harness } = open();
    const kv = bb.storage.kv as never;
    await recordEvidence(kv, { op: "janitor", projectId: "p", target: "/wt/x", why: "owner gone", checks: [{ name: "no open attempt", ok: true }], by: "worktree-reconcile", at: 1 });
    const [row] = await listEvidence(kv, "p");
    expect([row!.op, row!.target, row!.by]).toEqual(["janitor", "/wt/x", "worktree-reconcile"]);
    expect(row!.checks[0]!.name).toBe("no open attempt");
    await harness.lifecycle.dispose();
  });

  it("[sma:k_lib_stpa] a protection off past its term comes back as a warning", () => {
    const { db, harness } = open();
    const t0 = Date.now() - 9 * 86_400_000;
    saveProjectSetting(db as never, "p", "plan_critique.mode", "advisory");
    // A manual disarm record at t0 (saveProjectSetting stamps now, so set it directly)
    db.prepare(`UPDATE lane_pilot_project_settings SET value=? WHERE project_id='p' AND binding_id='' AND key='protection.disarm.plan_critique.mode'`)
      .run(JSON.stringify({ key: "plan_critique.mode", by: "owner", at: t0, until: t0 + 7 * 86_400_000 }));
    const rearmed = rearmExpiredDisarms(db as never, "p");
    expect(rearmed).toEqual(["plan_critique.mode"]);
    const value = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id='p' AND key='plan_critique.mode'`).get() as { value: string };
    expect(JSON.parse(value.value)).toBe("advisory");
    const items = db.prepare(`SELECT what FROM lane_pilot_owner_item WHERE key LIKE 'protection-rearm:%'`).all() as Array<{ what: string }>;
    expect(items.length).toBe(1);
    void harness;
  });

  it("[sma:k_v_integrity] a disarmed protection lists hazard, term and renew needs a reason", () => {
    const { db, harness } = open();
    noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner" });
    const report = integrityReport(db as never, { "code_critique.mode": "advisory" }, "p");
    const row = report.find((r) => r.key === "code_critique.mode")!;
    expect(row.disarmed).toBe(true);
    expect(row.hazard).toContain("unchecked diff");
    expect("error" in renewDisarm(db as never, "p", "code_critique.mode", 30, "")).toBe(true);
    const renewed = renewDisarm(db as never, "p", "code_critique.mode", 30, "still auditing the critic");
    expect("record" in renewed && renewed.record.renewals!.length).toBe(1);
    void harness;
  });
});

describe("checkable hard rules", () => {
  it("[sma:k_lib_gates] a convention rule warns by default and blocks only in block mode", () => {
    const gate = { id: "no-console", pattern: "console\\.log", paths: ["src/**"] };
    const hit = conventionGateHits([gate], { "src/a.ts": "+console.log(1)\n" });
    expect(hit.warnings).toEqual(["no-console"]);
    expect(hit.blocks).toEqual([]);
    const blocked = conventionGateHits([{ ...gate, mode: "block" as const }], { "src/a.ts": "+console.log(1)\n" });
    expect(blocked.blocks).toEqual(["no-console"]);
    expect(conventionGateHits([gate], { "tests/a.ts": "+console.log(1)\n" }).warnings).toEqual([]);
    expect(conventionGateHits([gate], { "src/a.ts": "-console.log(1)\n" }).warnings).toEqual([]);
  });
});


describe("same rules as the person", () => {
  it("[sma:k_lib_rulesparity] a helper's merged settings carry the person's deny list only", async () => {
    const { claudeExecLine } = await import("../../src/rooms/native-agent/native-claude-host");
    const home = mkdtempSync(join(tmpdir(), "sma-rules-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      permissions: { deny: ["Bash(rm -rf:*)"], allow: ["Bash(*)"], defaultMode: "bypassPermissions" },
    }));
    const guardFile = join(home, "guard.json");
    writeFileSync(guardFile, JSON.stringify({ permissions: { deny: ["Bash(bb plugin remove:*)"] } }));
    const stub = join(home, "claude");
    writeFileSync(stub, "#!/bin/sh\nfor a in \"$@\"; do [ \"$p\" = \"--settings\" ] && cat \"$a\"; p=\"$a\"; done\n");
    spawnSync("chmod", ["+x", stub]);
    const run = (role: string) => spawnSync("sh", ["-c", claudeExecLine(stub, guardFile)], {
      encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", LANE_PILOT_ROLE: role },
    });
    const merged = JSON.parse(run("writer").stdout);
    expect(merged.permissions.deny).toEqual(expect.arrayContaining(["Bash(bb plugin remove:*)", "Bash(rm -rf:*)"]));
    expect(merged.permissions.allow ?? []).not.toContain("Bash(*)");
    expect(merged.permissions.defaultMode).not.toBe("bypassPermissions");
    const pm = JSON.parse(run("pm").stdout);
    expect(pm.permissions.deny).not.toContain("Bash(rm -rf:*)");
  });
});
