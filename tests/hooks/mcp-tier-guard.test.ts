import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TIER_RANK, TOOL_TIERS, type ToolTier } from "@lane-pilot/contracts";
import { prepareClaudeGuard } from "../../src/rooms/native-agent";
import { createClaudeGuardEnv } from "../../src/rooms/native-agent/server";
import { prepareClaudeGuardHost } from "../../src/rooms/host-worker";
import { classifyToolTier, loadToolTiers } from "../../src/rooms/specialist";
import { agentRequest } from "../../src/rooms/workflow/server/services/workflow-agent";
import { useGuardSync } from "../guard-pool";
import { hookEnv } from "../hook-env";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const POLICY_PATH = join(process.cwd(), "policy/ohmy-tool-tiers.json");
const runGuard = useGuardSync(GUARD);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function invokeMcp(toolName: string, env: Record<string, string> = {}, agentType = "errand") {
  return runGuard({
    input: JSON.stringify({
      agent_type: agentType,
      tool_name: toolName,
      tool_input: { dummy: "arg" },
      cwd: process.cwd(),
    }),
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
  });
}

describe("MCP tier runtime guard in guard_shell.py", () => {
  it("keeps Python _MCP_TIER_RANK equal to TIER_RANK via --print-ranks and all 16 pairs", () => {
    const res = spawnSync("python3", [GUARD, "--print-ranks"], { encoding: "utf8", env: hookEnv({}) });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(TIER_RANK);

    const policy = loadToolTiers();
    const probeByTier: Record<ToolTier, string> = { R: "", D: "", L: "", S: "" };
    for (const [server, srv] of Object.entries(policy.servers)) {
      for (const [tool, spec] of Object.entries(srv.tools)) {
        if (!probeByTier[spec.tier]) probeByTier[spec.tier] = `mcp__${server}__${tool}`;
      }
    }
    for (const tier of TOOL_TIERS) expect(probeByTier[tier]).not.toBe("");

    for (const stepEffect of TOOL_TIERS) {
      for (const toolTier of TOOL_TIERS) {
        const resPair = invokeMcp(probeByTier[toolTier], {
          LANE_PILOT_NODE_EFFECT: stepEffect,
          LANE_PILOT_TOOL_TIERS_FILE: POLICY_PATH,
        });
        const expectedAllow = TIER_RANK[toolTier] <= TIER_RANK[stepEffect];
        expect(resPair.status, `step=${stepEffect} tool=${toolTier}`).toBe(expectedAllow ? 0 : 2);
      }
    }
  });

  it("matches classifyToolTier for every server/tool in policy/ohmy-tool-tiers.json, underscore server names, and unknown tools", () => {
    const policy = loadToolTiers();
    const envWith = (effect: ToolTier) => ({
      LANE_PILOT_NODE_EFFECT: effect,
      LANE_PILOT_TOOL_TIERS_FILE: POLICY_PATH,
    });

    const pythonTierFor = (mcpName: string): ToolTier => {
      for (const candidate of TOOL_TIERS) {
        const res = invokeMcp(mcpName, envWith(candidate));
        if (res.status === 0) return candidate;
      }
      throw new Error(`No tier allowed ${mcpName}`);
    };

    for (const [server, srv] of Object.entries(policy.servers)) {
      for (const tool of Object.keys(srv.tools)) {
        const expected = classifyToolTier(server, tool);
        expect(pythonTierFor(`mcp__${server}__${tool}`), `${server}.${tool}`).toBe(expected);
        const underscored = server.replace(/-/g, "_");
        if (underscored !== server) {
          expect(pythonTierFor(`mcp__${underscored}__${tool}`), `${underscored}.${tool}`).toBe(expected);
        }
      }
      // Unknown tool on known server falls back to server default
      expect(pythonTierFor(`mcp__${server}__nonexistent_tool`), `${server}.default`).toBe(
        classifyToolTier(server, "nonexistent_tool"),
      );
    }

    // Unknown server falls back to default_unknown_tier ("L")
    expect(pythonTierFor("mcp__unknown_server__some_tool")).toBe(
      classifyToolTier("unknown_server", "some_tool"),
    );
  });

  it("denies effect=R on an L tool with exact message and stderr log, allows effect=L, and allows when unset", () => {
    const lTool = "mcp__mcp-yandex-direct__update_campaign_budget";
    const sTool = "mcp__mcp-yandex-direct__delete_campaign";

    const denied = invokeMcp(lTool, {
      LANE_PILOT_NODE_EFFECT: "R",
      LANE_PILOT_TOOL_TIERS_FILE: POLICY_PATH,
    });
    expect(denied.status).toBe(2);
    const body = JSON.parse(denied.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(body.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput?.permissionDecisionReason).toBe(
      `Lane Pilot: this step is declared effect=R; tool ${lTool} is tier L. Ask the PM to run it in a step with a higher effect or an owner gate.`,
    );
    expect(denied.stderr).toContain(`lane-pilot mcp-tier: denied tool=${lTool} tier=L step=R`);
    expect(denied.stderr).not.toContain("dummy");

    const allowed = invokeMcp(lTool, {
      LANE_PILOT_NODE_EFFECT: "L",
      LANE_PILOT_TOOL_TIERS_FILE: POLICY_PATH,
    });
    expect(allowed.status).toBe(0);

    const unset = invokeMcp(sTool, {});
    expect(unset.status).toBe(0);
  });

  it("treats every MCP tool as tier L when LANE_PILOT_TOOL_TIERS_FILE is missing or unreadable", () => {
    const rTool = "mcp__mcp-yandex-seo-ro__direct_get_campaigns";
    const missingFile = "/nonexistent/path/ohmy-tool-tiers.json";

    const deniedR = invokeMcp(rTool, {
      LANE_PILOT_NODE_EFFECT: "R",
      LANE_PILOT_TOOL_TIERS_FILE: missingFile,
    });
    expect(deniedR.status).toBe(2);
    expect(deniedR.stderr).toContain("cannot read tool tiers file");

    const deniedD = invokeMcp(rTool, {
      LANE_PILOT_NODE_EFFECT: "D",
      LANE_PILOT_TOOL_TIERS_FILE: missingFile,
    });
    expect(deniedD.status).toBe(2);

    const allowedL = invokeMcp(rTool, {
      LANE_PILOT_NODE_EFFECT: "L",
      LANE_PILOT_TOOL_TIERS_FILE: missingFile,
    });
    expect(allowedL.status).toBe(0);
  });
});

describe("MCP tier env propagation from workflow node to claude launcher", () => {
  it("propagates node.effect through agentRequest, createClaudeGuardEnv, and prepareClaudeGuard", async () => {
    const req = agentRequest(
      {
        workflow: { id: "wf-test", inputs: [], nodes: [], edges: [], outputs: [] },
        runId: "run_1",
        stepKey: "step_1",
        spawnKey: "spawn_1",
        mode: "standard",
        inputs: {},
        input: { with: {}, via: { mode: "none" } },
        goals: [],
        reground: false,
        render: (s: string) => s,
        runtime: { projectId: "p1", ctx: {} },
      } as never,
      {
        id: "fetch",
        type: "agent",
        role: "errand",
        effect: "R",
        prompt: "Read data",
        out: [],
      } as never,
    );
    expect(req.nodeEffect).toBe("R");

    const root = await mkdtemp(join(tmpdir(), "mcp-tier-launch-"));
    roots.push(root);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const cli = join(bin, "claude");
    await writeFile(cli, "#!/bin/sh\nexit 0\n");
    await chmod(cli, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${prevPath ?? ""}`;
    try {
      const dataDir = join(root, "data");
      const preparedWithEffect = await prepareClaudeGuard({ role: "errand", nodeEffect: "R", dataDir });
      const launcherWithEffect = preparedWithEffect.env.find((e) => e.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value;
      const scriptWithEffect = await readFile(launcherWithEffect, "utf8");
      expect(scriptWithEffect).toContain("export LANE_PILOT_NODE_EFFECT='R'");
      expect(scriptWithEffect).toContain(`export LANE_PILOT_TOOL_TIERS_FILE='${POLICY_PATH}'`);
      expect(preparedWithEffect.env).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "LANE_PILOT_NODE_EFFECT", value: "R" }),
          expect.objectContaining({ name: "LANE_PILOT_TOOL_TIERS_FILE", value: POLICY_PATH }),
        ]),
      );

      const preparedWithout = await prepareClaudeGuard({ role: "errand", dataDir });
      const launcherWithout = preparedWithout.env.find((e) => e.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value;
      expect(launcherWithout).not.toBe(launcherWithEffect);
      const scriptWithout = await readFile(launcherWithout, "utf8");
      expect(scriptWithout).not.toContain("LANE_PILOT_NODE_EFFECT");

      const debugLogs: string[] = [];
      const resolver = createClaudeGuardEnv({
        bb: {
          log: { debug: (msg: string) => debugLogs.push(msg), warn() {}, info() {} },
          storage: { kv: { get: async () => null } },
          sdk: {
            threads: {
              getPluginMetadata: async () => ({ role: "errand", lanePilotWorkflowNode: "fetch", nodeEffect: "R" }),
              get: async () => null,
            },
            environments: { get: async () => null },
          },
        } as never,
        db: {} as never,
        nativeHost: {
          call: async (method, input) => {
            expect(method).toBe("prepareClaudeGuard");
            return prepareClaudeGuardHost(input as never, { experimental_paths: { dataDir } } as never);
          },
        },
      });
      const envEntries = await resolver({ threadId: "thr_fetch", hostId: "local" });
      expect(envEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "LANE_PILOT_NODE_EFFECT", value: "R" }),
          expect.objectContaining({ name: "LANE_PILOT_TOOL_TIERS_FILE", value: POLICY_PATH }),
        ]),
      );
      expect(debugLogs).toContain("wf.launch node=fetch effect=R");
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
