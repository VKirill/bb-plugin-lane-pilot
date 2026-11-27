import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  CREDENTIAL_DIRS,
  CREDENTIAL_FILES,
  resolveCredentialPaths,
} from "../src/rooms/verification";
import { credentialMaskPaths } from "../src/rooms/verification/sandbox";
import {
  buildWriterIsolationSettings,
  prepareClaudeGuard,
} from "../src/rooms/native-agent/claude-guard-launch";
import { createClaudeGuardEnv } from "../src/rooms/native-agent/server/services/claude-guard-env";
import { createBbShimEnv, createRoleMarkerEnv, writerPushBlockEnv } from "../src/rooms/native-agent/server/services/helper-bb-shim";
import { createAttempt, createRun, createTask, getReasoningTrace, openDatabase, saveReasoningTrace } from "../src/rooms/plugin-db";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeClaudeBin(root: string): Promise<{ binDir: string; command: string }> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const command = join(binDir, "claude");
  await writeFile(command, "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n", { mode: 0o755 });
  await chmod(command, 0o755);
  return { binDir, command };
}

function readMergedSettingsPath(launcherStdout: string): string {
  const args = launcherStdout.trim().split("\n");
  const idx = args.indexOf("--settings");
  if (idx === -1 || !args[idx + 1]) throw new Error(`missing --settings in launcher output: ${launcherStdout}`);
  return args[idx + 1]!;
}

describe("writer credential isolation", () => {
  it("keeps one canonical credential list incl. .ssh, .claude.json, .bb, .config/gh and resolved ~/.codex + ~/.claude symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-cred-list-"));
    roots.push(root);
    const home = join(root, "home");
    const externalCodex = join(root, "ssd", "codex");
    const externalClaude = join(root, "ssd", "claude");
    await mkdir(home, { recursive: true });
    await mkdir(externalCodex, { recursive: true });
    await mkdir(externalClaude, { recursive: true });
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(join(home, ".bb"), { recursive: true });
    await mkdir(join(home, ".config", "gh"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "{}");
    await writeFile(join(externalCodex, "auth.json"), "{}");
    await writeFile(join(externalClaude, ".credentials.json"), "{}");
    await symlink(externalCodex, join(home, ".codex"));
    await symlink(externalClaude, join(home, ".claude"));

    const realCodex = await realpath(externalCodex);
    const realClaude = await realpath(externalClaude);
    const resolved = resolveCredentialPaths(home, { existingOnly: true });

    expect(CREDENTIAL_DIRS).toEqual(expect.arrayContaining([".ssh", ".bb", ".config/gh", ".codex", ".claude"]));
    expect(CREDENTIAL_FILES).toEqual(expect.arrayContaining([".claude.json", ".codex/auth.json", ".claude/.credentials.json"]));

    expect(resolved.dirs).toEqual(expect.arrayContaining([
      join(home, ".ssh"),
      join(home, ".bb"),
      join(home, ".config/gh"),
      join(home, ".codex"),
      realCodex,
      join(home, ".claude"),
      realClaude,
    ]));
    expect(resolved.files).toEqual(expect.arrayContaining([
      join(home, ".claude.json"),
      join(home, ".codex/auth.json"),
      join(realCodex, "auth.json"),
      join(home, ".claude/.credentials.json"),
      join(realClaude, ".credentials.json"),
    ]));

    // sandbox.ts uses the exact same list.
    expect(credentialMaskPaths(home)).toEqual(resolved);
    expect(credentialMaskPaths(home, { sshKeys: true }).dirs).not.toContain(join(home, ".ssh"));
  });

  it("keeps scripts/lp-worker-user.sh credential probe list in 1:1 parity with credential-paths.ts and creates a dedicated group", () => {
    const sh = readFileSync(join(process.cwd(), "scripts/lp-worker-user.sh"), "utf8");
    const match = /for rel in ([^;]+); do/.exec(sh);
    expect(match).not.toBeNull();
    const shPaths = match![1]!.trim().split(/\s+/);
    expect(shPaths).toEqual([...CREDENTIAL_DIRS, ...CREDENTIAL_FILES]);
    expect(sh).toContain('dscl . -create "/Groups/$USER_NAME"');
    expect(sh).not.toContain("PrimaryGroupID 20");
  });

  it("writer settings carry Read/Edit denies and sandbox with allowUnsandboxedCommands:false, while PM and helpers do not", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-writer-settings-"));
    roots.push(root);
    const { binDir } = await fakeClaudeBin(root);
    const dataDir = join(root, "data");
    const worktree = join(root, "worktree");
    const taskHome = join(worktree, ".agents", "tasks", "t-42");
    await mkdir(taskHome, { recursive: true });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
    try {
      const readSettings = async (role: string, extraArgs: string[] = []) => {
        const prepared = await prepareClaudeGuard({
          role,
          cwd: worktree,
          ...(role === "writer" || role === "emergency-writer" ? { taskHome } : {}),
          dataDir,
        });
        const launcher = prepared.env.find((e) => e.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value;
        const ran = spawnSync(launcher, ["-p", "hi", ...extraArgs], {
          encoding: "utf8",
          env: { ...process.env, SSH_AUTH_SOCK: "/tmp/owner-agent.sock" },
        });
        expect(ran.status).toBe(0);
        const merged = JSON.parse(readFileSync(readMergedSettingsPath(ran.stdout), "utf8")) as {
          permissions?: { deny?: string[] };
          sandbox?: {
            enabled?: boolean;
            allowUnsandboxedCommands?: boolean;
            filesystem?: { allowWrite?: string[]; denyRead?: string[] };
          };
        };
        return { prepared, launcher, merged };
      };

      for (const writerRole of ["writer", "emergency-writer"]) {
        const coreLayer = JSON.stringify({ permissions: { deny: ["WebFetch"] } });
        const { prepared, launcher, merged } = await readSettings(writerRole, ["--settings", coreLayer]);
        expect(prepared.isolation).toEqual({
          denies: expect.any(Number),
          sandbox: true,
        });
        expect(prepared.isolation!.denies).toBeGreaterThan(0);

        const deny = merged.permissions?.deny ?? [];
        expect(deny).toContain("WebFetch");
        expect(deny.some((r) => r.startsWith("Read(//") && r.includes(".ssh/**)"))).toBe(true);
        expect(deny.some((r) => r.startsWith("Edit(//") && r.includes(".ssh/**)"))).toBe(true);
        expect(deny.some((r) => r.startsWith("Read(//") && r.includes(".claude.json)"))).toBe(true);
        expect(deny.some((r) => r.startsWith("Edit(//") && r.includes(".bb/**)"))).toBe(true);
        expect(deny.some((r) => r.startsWith("Read(//") && r.includes(".config/gh/**)"))).toBe(true);

        expect(merged.sandbox?.enabled).toBe(true);
        expect(merged.sandbox?.allowUnsandboxedCommands).toBe(false);
        expect(merged.sandbox?.filesystem?.allowWrite).toEqual(expect.arrayContaining([
          worktree,
          taskHome,
        ]));
        expect(merged.sandbox?.filesystem?.denyRead?.some((p) => p.endsWith("/.ssh"))).toBe(true);
        expect(merged.sandbox?.filesystem?.denyRead?.some((p) => p.endsWith("/.claude.json"))).toBe(true);

        const launcherScript = await readFile(launcher, "utf8");
        expect(launcherScript).toContain("unset SSH_AUTH_SOCK");
      }

      for (const nonWriter of ["pm", "errand", "code-critic"]) {
        const { prepared, launcher, merged } = await readSettings(nonWriter);
        expect(prepared.isolation).toEqual({ denies: 0, sandbox: false });
        expect(merged.sandbox).toBeUndefined();
        const deny = merged.permissions?.deny ?? [];
        expect(deny.some((r) => r.includes(".bb/**"))).toBe(false);
        expect(deny.some((r) => r.includes(".claude.json"))).toBe(false);
        const launcherScript = await readFile(launcher, "utf8");
        expect(launcherScript).not.toContain("unset SSH_AUTH_SOCK");
      }
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("buildWriterIsolationSettings builds Read/Edit denies and sandbox paths from one home", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-iso-builder-"));
    roots.push(root);
    const home = join(root, "home");
    const targetCodex = join(root, "ext", "codex");
    const targetClaude = join(root, "ext", "claude");
    const worktree = join(root, "wt");
    const taskHome = join(worktree, ".agents", "tasks", "t-1");
    const tempDir = join(root, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(targetCodex, { recursive: true });
    await mkdir(targetClaude, { recursive: true });
    await mkdir(taskHome, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    await symlink(targetCodex, join(home, ".codex"));
    await symlink(targetClaude, join(home, ".claude"));

    const realCodex = await realpath(targetCodex);
    const realClaude = await realpath(targetClaude);
    const iso = buildWriterIsolationSettings({ cwd: worktree, taskHome, home, tempDir });

    expect(iso.sandbox.enabled).toBe(true);
    expect(iso.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(iso.sandbox.filesystem.allowWrite).toContain(worktree);
    expect(iso.sandbox.filesystem.allowWrite).toContain(taskHome);
    expect(iso.sandbox.filesystem.allowWrite).toContain(tempDir);
    expect(iso.sandbox.filesystem.denyRead).toContain(realCodex);
    expect(iso.sandbox.filesystem.denyRead).toContain(realClaude);
    expect(iso.permissions.deny).toContain(`Read(//${realCodex.replace(/^\/+/, "")}/**)`);
    expect(iso.permissions.deny).toContain(`Edit(//${realClaude.replace(/^\/+/, "")}/**)`);
  });

  it("writer env carries push-blocking entries that prevent git push authentication, while PM/helpers do not", async () => {
    expect(writerPushBlockEnv("pm")).toEqual([]);
    expect(writerPushBlockEnv("code-critic")).toEqual([]);

    const writerEnv = writerPushBlockEnv("writer");
    const envMap = Object.fromEntries(writerEnv.map((e) => [e.name, e.value]));
    expect(envMap).toEqual({
      GIT_SSH_COMMAND: "/usr/bin/false",
      GIT_ASKPASS: "/usr/bin/false",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      SSH_AUTH_SOCK: "",
    });
    expect(writerPushBlockEnv("emergency-writer")).toEqual(writerEnv);

    // Role marker env for Claude Code includes push-blocking entries for writers only.
    const marker = createRoleMarkerEnv({
      bb: { sdk: { threads: { getPluginMetadata: async () => ({ role: "writer" }) } } },
    } as never);
    const claudeWriterEntries = await marker({ threadId: "thr_w", hostId: "mini" });
    expect(claudeWriterEntries.map((e) => e.name)).toEqual(expect.arrayContaining(Object.keys(envMap)));

    const criticMarker = createRoleMarkerEnv({
      bb: { sdk: { threads: { getPluginMetadata: async () => ({ role: "code-critic" }) } } },
    } as never);
    const claudeCriticEntries = await criticMarker({ threadId: "thr_c", hostId: "mini" });
    expect(claudeCriticEntries.map((e) => e.name)).not.toContain("GIT_SSH_COMMAND");

    // Functional git check: writer env clears credential helpers (ignores ~/.git-credentials store) and blocks ssh push.
    const root = await mkdtemp(join(tmpdir(), "lp-git-push-block-"));
    roots.push(root);
    const fakeHome = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(fakeHome, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(fakeHome, ".gitconfig"), "[credential]\n\thelper = store\n");
    await writeFile(join(fakeHome, ".git-credentials"), "https://user:secret-token@example.com\n");
    const baseEnv = { ...process.env, HOME: fakeHome, ...envMap };
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8", env: baseEnv }).status).toBe(0);
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, env: baseEnv });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo, env: baseEnv });
    await writeFile(join(repo, "a.txt"), "hello\n");
    spawnSync("git", ["add", "a.txt"], { cwd: repo, env: baseEnv });
    expect(spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8", env: baseEnv }).status).toBe(0);

    const credFill = spawnSync("git", ["credential", "fill"], {
      cwd: repo,
      encoding: "utf8",
      input: "protocol=https\nhost=example.com\n\n",
      env: baseEnv,
    });
    expect(credFill.status).not.toBe(0);
    expect(credFill.stdout).not.toContain("secret-token");
    const sshPush = spawnSync("git", ["push", "ssh://git@example.com/org/repo.git", "HEAD"], { cwd: repo, encoding: "utf8", env: baseEnv });
    expect(sshPush.status).not.toBe(0);
  });

  it("logs writer.isolation and warns + annotates ReasoningTrace when provider does not accept sandbox keys", async () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({
            role: "writer",
            attemptId: "att_1",
            laneTaskDir: "/tmp/wt/.agents/tasks/t-1",
          }),
          get: async () => ({ environmentId: "env_1" }),
        },
        environments: { get: async () => ({ path: "/tmp/wt" }) },
      },
    } as never);
    bb.log.info = (msg: string) => { infos.push(msg); };
    bb.log.warn = (msg: string) => { warns.push(msg); };
    const db = openDatabase(bb);
    createRun(db, "run_1", "proj_1", "bb", null);
    createTask(db, { id: "t-1", runId: "run_1", kind: "bb", contract: { id: "t-1", title: "Task 1" } });
    createAttempt(db, { id: "att_1", runId: "run_1", taskId: "t-1" });
    saveReasoningTrace(db, {
      planSha256: "a".repeat(64),
      sourceLength: 10,
      requestedReasoningLevel: "medium",
      effectiveReasoningLevel: "medium",
      fallbackReason: null,
      providerId: "codex",
      model: "gpt-5",
      serviceTier: "default",
      requestedServiceTier: "default",
      runId: "run_1",
      attemptId: "att_1",
      threadId: null,
    });

    // Non-Claude provider (codex): sandbox=off, WARN + ReasoningTrace annotated.
    const shim = createBbShimEnv({
      bb,
      db,
      host: { call: async () => ({ dir: "/data/bb-shim", path: "/data/bb-shim:/usr/bin" }) },
    } as never);
    await shim({ threadId: "thr_codex", hostId: "mini" }, "codex");
    expect(infos.some((l) => l.includes("writer.isolation attempt=att_1 denies=0 sandbox=off push_env=on"))).toBe(true);
    expect(warns.some((l) => l.includes("provider=codex does not accept sandbox keys"))).toBe(true);
    expect(getReasoningTrace(db, "att_1")?.isolation).toEqual({
      role: "writer",
      providerId: "codex",
      denies: 0,
      sandbox: false,
      pushEnv: true,
      warning: "provider codex does not accept sandbox keys",
    });

    // Claude provider with sandbox=on: INFO denies=n sandbox=on push_env=on, no WARN.
    infos.length = 0;
    warns.length = 0;
    const claudeGuard = createClaudeGuardEnv({
      bb,
      db,
      nativeHost: {
        call: async () => ({
          env: [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/data/claude", reason: "guard" }],
          isolation: { denies: 26, sandbox: true },
        }),
      },
    });
    await claudeGuard({ threadId: "thr_claude", hostId: "mini" });
    expect(infos.some((l) => l.includes("writer.isolation attempt=att_1 denies=26 sandbox=on push_env=on"))).toBe(true);
    expect(warns).toEqual([]);
    expect(getReasoningTrace(db, "att_1")?.isolation).toEqual({
      role: "writer",
      providerId: "claude-code",
      denies: 26,
      sandbox: true,
      pushEnv: true,
    });
    db.close();
  });
});
