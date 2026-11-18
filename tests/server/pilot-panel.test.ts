import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { coreRequiredSessionAdvertisement } from "../../src/rooms/contracts";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  PILOT_AGENTS_START,
  PILOT_CONFIG_REL_PATH,
  PILOT_DELEGATION_CONTEXT_REL_PATH,
  PILOT_PROJECT_SKILLS,
} from "../../src/rooms/pilot-panel";
import { pilotReadinessSteps } from "../../src/rooms/pilot-panel/readiness";
import {
  bootstrapProjectForPilot,
  createPilotPanelService,
} from "../../src/rooms/pilot-panel/server";
import {
  inspectProjectPilotWorkspace,
  materializeProjectPilotSetup,
  parseMarkdownPlan,
} from "../../src/rooms/pilot-panel/server/project-skills";

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-pilot-panel-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createPanelHarness(
  rootPath: string,
  opts: {
    providerId?: string;
    threadStatus?: "idle" | "active" | "error";
    envPathOverride?: string;
    sendDelivery?: "sent" | "queued";
  } = {},
) {
  const sentMessages: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const advertised = coreRequiredSessionAdvertisement();
  const providerId = opts.providerId ?? "claude-code";
  const threadStatus = opts.threadStatus ?? "idle";
  const envPath = opts.envPathOverride ?? rootPath;
  const sendDelivery = opts.sendDelivery ?? (threadStatus === "active" ? "queued" : "sent");

  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "Demo Repo",
          sources: [{ id: "src_1", hostId: "host_local", path: rootPath, isDefault: true }],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          projectId: "proj_demo",
          hostId: "host_local",
          path: envPath,
        }),
        list: async () => [{ id: "env_demo", projectId: "proj_demo", hostId: "host_local", path: envPath }],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          projectId: "proj_demo",
          environmentId: "env_demo",
          providerId,
          status: threadStatus,
          runtime: { displayStatus: threadStatus },
          pendingQuestionsCount: 0,
        }),
        getPluginMetadata: async () => ({}),
        list: async () => [
          {
            id: "thr_worker_1",
            title: "LP · auth · Task 1",
            status: "active",
            providerId: "claude-code",
          },
        ],
        send: async (payload: Record<string, unknown>) => {
          if (payload.mode !== "queue-if-active") {
            throw new Error(`Invalid send mode: ${String(payload.mode)}`);
          }
          if ("executionInputSources" in payload) {
            throw new Error("Unexpected executionInputSources in threads.send");
          }
          sentMessages.push(payload);
          return sendDelivery === "queued"
            ? { ok: true, delivery: "queued", queuedMessage: { id: "q_1" } }
            : { ok: true, delivery: "sent" };
        },
      },
      providers: {
        list: async () => [
          { id: "claude-code", displayName: "Claude Code", available: true },
          { id: "codex", displayName: "Codex", available: true },
        ],
      },
      files: {
        read: async ({ path }: { hostId: string; path: string }) => {
          if (!existsSync(path)) {
            const err = new Error(`ENOENT: ${path}`) as Error & { code?: string };
            err.code = "ENOENT";
            throw err;
          }
          const buf = readFileSync(path);
          return { content: buf.toString("utf8"), sha256: sha(buf) };
        },
        write: async ({
          path,
          content,
          expectedSha256,
          createParents,
        }: {
          hostId: string;
          path: string;
          content: string;
          expectedSha256?: string | null;
          createParents?: boolean;
        }) => {
          if (expectedSha256 === null && existsSync(path)) {
            return { outcome: "sha_mismatch", currentSha256: sha(readFileSync(path)) };
          }
          if (typeof expectedSha256 === "string") {
            const existing = existsSync(path) ? sha(readFileSync(path)) : null;
            if (existing !== expectedSha256) {
              return { outcome: "sha_mismatch", currentSha256: existing };
            }
          }
          if (createParents) mkdirSync(dirname(path), { recursive: true });
          const next = Buffer.from(content, "utf8");
          writeFileSync(path, next);
          return { outcome: "written", sha256: sha(next) };
        },
      },
    } as never,
  });

  (bb as unknown as { agents: Record<string, unknown> }).agents = {
    experimental_vkRequiredSessionPolicy: () => advertised,
  };

  const host = {
    call: async (_method: string, params: { cwd: string; command: string }) => {
      const out = execFileSync("bash", ["-lc", params.command], {
        cwd: params.cwd,
        encoding: "utf8",
      });
      return { exitCode: 0, stdout: out, stderr: "", timedOut: false };
    },
  };

  const db = openDatabase(bb);
  const ctx = {
    bb,
    db,
    host,
    log: (msg: string) => logs.push(msg),
    realtime: { notify: () => undefined },
  } as never;

  return { ctx, bb, db, sentMessages, logs };
}

describe("project-local Pilot skills & readiness service", () => {
  it("installs all 11 standardized skills into .bb/skills/ and preserves owner + project-folders blocks in AGENTS.md", async () => {
    const rootPath = createTempWorkspace();
    const existingAgents = [
      "# Owner Guidelines",
      "",
      "Keep all custom invariants.",
      "",
      "<!-- bb-project-folders:agents:start -->",
      "Managed by project-folders.",
      "<!-- bb-project-folders:agents:end -->",
      "",
    ].join("\n");
    writeFileSync(join(rootPath, "AGENTS.md"), existingAgents, "utf8");

    const { ctx } = createPanelHarness(rootPath);
    const first = await materializeProjectPilotSetup(ctx, {
      hostId: "host_local",
      rootPath,
      projectName: "Demo Repo",
    });

    expect(first.installedSkills).toHaveLength(PILOT_PROJECT_SKILLS.length);
    expect(first.installedSkills).toContain("lp-project-setup");
    expect(first.installedSkills).toContain("lp-plan");
    expect(first.installedSkills).toContain("lp-implement");
    expect(first.installedSkills).toContain("lp-verify");
    expect(first.installedSkills).toContain("lane-pilot");

    for (const skillName of PILOT_PROJECT_SKILLS) {
      expect(existsSync(join(rootPath, ".bb/skills", skillName, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(rootPath, ".bb/skills/lane-pilot/references/subagent-delegation.md"))).toBe(true);
    expect(existsSync(join(rootPath, ".agents/pilot/config.json"))).toBe(true);
    expect(existsSync(join(rootPath, ".agents/pilot/DESCRIPTION.md"))).toBe(true);
    expect(existsSync(join(rootPath, ".agents/pilot/ARCHITECTURE.md"))).toBe(true);
    expect(existsSync(join(rootPath, ".agents/pilot/rules/base.md"))).toBe(true);

    const agentsAfter = readFileSync(join(rootPath, "AGENTS.md"), "utf8");
    expect(agentsAfter).toContain("Keep all custom invariants.");
    expect(agentsAfter).toContain("<!-- bb-project-folders:agents:start -->");
    expect(agentsAfter).toContain(PILOT_AGENTS_START);

    // Second run is idempotent: 0 newly installed or updated skills, and config.json bytes + custom commands stay untouched.
    const cfgPath = join(rootPath, PILOT_CONFIG_REL_PATH);
    const customCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    customCfg.commands = { typecheck: "npm run typecheck", test: "npm test" };
    writeFileSync(cfgPath, `${JSON.stringify(customCfg, null, 2)}\n`, "utf8");
    const cfgBeforeSecond = readFileSync(cfgPath, "utf8");

    const second = await materializeProjectPilotSetup(ctx, {
      hostId: "host_local",
      rootPath,
      projectName: "Demo Repo",
    });
    expect(second.installedSkills).toEqual([]);
    expect(second.updatedSkills).toEqual([]);
    expect(readFileSync(cfgPath, "utf8")).toBe(cfgBeforeSecond);

    // parseMarkdownPlan ignores fenced code block checkboxes, and pilotReadinessSteps marks quality/ci skippable.
    const parsedPlan = parseMarkdownPlan("plan.md", "# Title\n```md\n- [x] ignored\n```\n- [ ] real\n");
    expect(parsedPlan.tasks).toHaveLength(1);
    expect(pilotReadinessSteps({
      configured: true, skillsSynced: true, missingOrOutdatedSkills: [],
      hasDescription: true, hasRulesBase: true, hasAgentsMd: true, hasArchitecture: true, files: {},
    }, ["quality", "ci"]).every((s) => s.state !== "todo")).toBe(true);

    const inspected = await inspectProjectPilotWorkspace(ctx, { hostId: "host_local", rootPath });
    expect(inspected.configured).toBe(true);
    expect(inspected.skillStates.every((s) => s.state === "synced")).toBe(true);
    // Starter templates contain PILOT_STARTER_MARKER, so context/architecture remain todo until filled.
    expect(inspected.hasDescription).toBe(false);
    expect(inspected.hasArchitecture).toBe(false);
  });

  it("tracks readiness steps, parses .agents/pilot/plans/*.md, saves bb-subthreads delegation on standard tier, and dispatches prompts on default tier", async () => {
    const rootPath = createTempWorkspace();
    const { ctx, sentMessages } = createPanelHarness(rootPath);
    const service = createPilotPanelService(ctx, {
      activate: async () => ({ runId: "lprun_demo", threadId: "thr_pm_demo", reused: false }),
    });

    // Unprepared workspace: step 1 (install) is todo.
    const before = await service.status({ threadId: "thr_chat_1" });
    expect(before.readiness[0]).toMatchObject({ id: "install", state: "todo" });
    expect(before.projectSkills.synced).toBe(0);

    // Prepare via server action (no LLM turn spent).
    const prep = await service.runAction({
      threadId: "thr_chat_1",
      actionId: "prepare-project",
      fingerprint: before.fingerprint,
      requestId: "req_prepare_1",
    });
    expect(prep.sent).toBe(true);
    expect(sentMessages).toHaveLength(0);

    // Add a plan file and fill context docs.
    mkdirSync(join(rootPath, ".agents/pilot/plans"), { recursive: true });
    writeFileSync(
      join(rootPath, ".agents/pilot/plans/feature-auth.md"),
      [
        "# Feature Auth Plan",
        "",
        "- [x] Task 1: Add schema",
        "- [-] Task 2: Wire service",
        "- [ ] Task 3: Add tests",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(rootPath, ".agents/pilot/DESCRIPTION.md"),
      "# Demo Repo\n\nTypeScript monorepo with Vitest, npm test, and strict tsc checks across packages.\n",
      "utf8",
    );
    writeFileSync(
      join(rootPath, ".agents/pilot/rules/base.md"),
      "# Base Conventions\n\nKeep domain modules pure and verify every change with targeted vitest suites.\n",
      "utf8",
    );

    const savedDel = await service.setDelegation("thr_chat_1", {
      mode: "bb-subthreads",
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
      reasoning: "high",
    });
    expect(savedDel.choice).toEqual({
      mode: "bb-subthreads",
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
      reasoning: "high",
    });
    const delDoc = readFileSync(join(rootPath, PILOT_DELEGATION_CONTEXT_REL_PATH), "utf8");
    expect(delDoc).toContain("--service-tier 'default'");
    expect(delDoc).toContain("--parent-self");

    await service.setReadinessSkip("thr_chat_1", "ci", true);
    const after = await service.status({ threadId: "thr_chat_1" });
    expect(after.readiness.find((s) => s.id === "install")?.state).toBe("done");
    expect(after.readiness.find((s) => s.id === "context")?.state).toBe("done");
    expect(after.readiness.find((s) => s.id === "ci")?.state).toBe("skipped");
    expect(after.plans.selected?.title).toBe("Feature Auth Plan");
    expect(after.plans.selected?.tasks.map((t) => t.state)).toEqual(["done", "in_progress", "todo"]);
    expect(after.delegation.children[0]).toMatchObject({
      id: "thr_worker_1",
      title: "LP · auth · Task 1",
      cleanSession: true,
    });

    // Dispatching `/lp-implement` sends a message with queue-if-active mode and agent-only context.
    const sent = await service.runAction({
      threadId: "thr_chat_1",
      actionId: "implement",
      targetPlan: after.plans.selected?.path,
      fingerprint: after.fingerprint,
      requestId: "req_impl_1",
    });
    expect(sent.sent).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.mode).toBe("queue-if-active");
    const parts = sentMessages[0]?.input as Array<{ text: string; visibility?: string }>;
    expect(parts[0]?.text).toContain("/lp-implement");
    expect(parts[1]?.visibility).toBe("agent-only");

    // Switching delegation to `self` removes the managed delegation block cleanly.
    await service.setDelegation("thr_chat_1", { mode: "self" });
    expect(readFileSync(join(rootPath, PILOT_DELEGATION_CONTEXT_REL_PATH), "utf8")).toBe("");
  });

  it("handles setup-context (/lp-project-setup) across claude-code, codex, and acp-antigravity, auto-materializing skills and queueing on active chats", async () => {
    // 1. Direct setup-context on unprepared workspace with codex ($lp-project-setup)
    const codexRoot = createTempWorkspace();
    const codexH = createPanelHarness(codexRoot, { providerId: "codex" });
    const codexSvc = createPilotPanelService(codexH.ctx);
    const snapCodex = await codexSvc.status({ threadId: "thr_codex" });
    const setupRes = await codexSvc.runAction({
      threadId: "thr_codex",
      actionId: "setup-context",
      fingerprint: snapCodex.fingerprint,
      requestId: "req_codex_setup",
    });
    expect(setupRes.sent).toBe(true);
    expect(existsSync(join(codexRoot, ".bb/skills/lp-project-setup/SKILL.md"))).toBe(true);
    const codexParts = codexH.sentMessages[0]?.input as Array<{ text: string; visibility?: string }>;
    expect(codexParts[0]?.text).toBe("$lp-project-setup");
    expect(codexParts[1]?.text).toContain(".bb/skills/lp-project-setup/SKILL.md");

    // 2. Active thread on acp-antigravity with thread-storage env path falls back to project.sources and queues non-slash prompt
    const agyRoot = createTempWorkspace();
    const agyH = createPanelHarness(agyRoot, {
      providerId: "acp-antigravity",
      threadStatus: "active",
      envPathOverride: "/home/ubuntu/.bb-machines/demo.getbb.app/thread-storage",
      sendDelivery: "queued",
    });
    const agySvc = createPilotPanelService(agyH.ctx);
    const snapAgy = await agySvc.status({ threadId: "thr_agy" });
    expect(snapAgy.project.rootPath).toBe(agyRoot);
    const agyRes = await agySvc.runAction({
      threadId: "thr_agy",
      actionId: "setup-context",
      fingerprint: snapAgy.fingerprint,
      requestId: "req_agy_setup",
    });
    expect(agyRes).toMatchObject({ sent: true, queued: true });
    const agyParts = agyH.sentMessages[0]?.input as Array<{ text: string; visibility?: string }>;
    expect(agyParts[0]?.text).not.toMatch(/^[/$]/);
    expect(agyParts[0]?.text).toContain("lp-project-setup");
  });

  it("auto-bootstraps an unprepared workspace via bootstrapProjectForPilot without throwing", async () => {
    const rootPath = createTempWorkspace();
    const { ctx } = createPanelHarness(rootPath);
    const res = await bootstrapProjectForPilot(ctx, {
      projectId: "proj_demo",
      hostId: "host_local",
      workspacePath: rootPath,
    });
    expect(res?.installedSkills).toHaveLength(PILOT_PROJECT_SKILLS.length);
    expect(existsSync(join(rootPath, ".bb/skills/lp-implement/SKILL.md"))).toBe(true);
  });

  it("keeps src/rooms/pilot-panel/bundled-skills.json in exact parity with skills/ and package.json", () => {
    const out = execFileSync("npx", ["tsx", "scripts/sync-bundled-pilot-skills.ts", "--check"], {
      cwd: join(__dirname, "../.."),
      encoding: "utf8",
    });
    expect(out).toContain("bundled-skills.json fresh");
  });
});
