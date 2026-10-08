import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/database";
import { forgetSecrets } from "@lane-pilot/kit";
import { errandAccountLines, errandPrompt } from "../../src/server/errands";

// Test values only: none of them is a real credential.
const PRIVATE_KEY = "-----BEGIN TEST KEY-----\nQUJDREVGR0hJSktMTU5PUA\nUVJTVFVWV1hZWjAxMjM0NTY3\n-----END TEST KEY-----";
const projectId = "errand-project";
const pmThreadId = "errand-pm";
const runId = "errand-run";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; forgetSecrets(); });

describe("accounts for a deploy errand (J7)", () => {
  it("names each account with how to use its kind without leaving a key in a repository", () => {
    const lines = errandAccountLines([{ name: "OVH_SSH", kind: "ssh" }, { name: "BEGET_FTP", kind: "ftp" }]).join("\n");
    expect(lines).toContain("- OVH_SSH (ssh)");
    expect(lines).toContain("mktemp -d");
    expect(lines).toContain("chmod 600");
    expect(lines).toContain("outside every repository");
    expect(lines).toContain("- BEGET_FTP (ftp)");
    expect(lines).toContain("never on the command line");
    expect(errandAccountLines([])).toEqual([]);
    expect(errandPrompt({ task: "Deploy the build to the server", browserHostId: null, authorized: true, accounts: [{ name: "OVH_SSH", kind: "ssh" }] })).toContain("read each with `env_get`");
  });

  function setup(catalog: Array<{ name: string; kind: "ssh" | "ftp" | "secret"; access?: Record<string, unknown> }>) {
    const spawned: Array<Record<string, unknown>> = [];
    let helperOutput = "";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : {},
          spawn: async (args: unknown) => { spawned.push(args as Record<string, unknown>); return { id: "errand-thread" }; },
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-pm", sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async () => ({ output: helperOutput }),
        },
        environments: { get: async () => ({ id: "env-pm", hostId: "local-host", path: process.cwd(), status: "ready" }) },
        plugins: { callRpc: async ({ method, input }: { method: string; input: { name?: string } }) => {
          if (method === "env_list") return { variables: catalog.map(({ name, kind }) => ({ name, kind })) };
          const row = catalog.find((candidate) => candidate.name === input.name)!;
          return { name: row.name, kind: row.kind, value: null, access: row.access ?? null };
        } },
      } as never,
    });
    return { bb, harness, spawned, say: (text: string) => { helperOutput = text; } };
  }

  it("starts nothing for an account that is missing or not allowed, and says what to do", async () => {
    const { bb, harness, spawned } = setup([{ name: "OVH_SSH", kind: "ssh", access: { host: "h", username: "deploy", privateKey: PRIVATE_KEY } }]);
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId, "cli");
    setRunThread(db, runId, pmThreadId);
    const call = async (params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_errand", params, { threadId: pmThreadId, projectId }))) as Record<string, any>;
    const args = { task: "Deploy the build to the server over SSH", authorized: true, accounts: ["OVH_SSH", "GONE_FTP"] };
    // An empty secrets.allow allows what the errand names; the owner restricted it here.
    saveProjectSetting(db, projectId, "secrets.allow", "OTHER_KEY");
    const notAllowed = await call(args);
    expect(notAllowed).toMatchObject({ state: "blocked", reason: "waiting_secret:OVH_SSH,GONE_FTP" });
    expect(JSON.stringify(notAllowed.fix)).toContain("secrets.allow");
    expect(spawned).toEqual([]);
    saveProjectSetting(db, projectId, "secrets.allow", "OVH_SSH, GONE_FTP");
    const missing = await call(args);
    expect(missing.reason).toBe("waiting_secret:GONE_FTP");
    expect(JSON.stringify(missing.fix)).toContain("env_request");
    expect(spawned).toEqual([]);
  });

  it("names the allowed account to the helper and masks the key if the helper prints it", async () => {
    const { bb, harness, spawned, say } = setup([{ name: "OVH_SSH", kind: "ssh", access: { host: "h", username: "deploy", privateKey: PRIVATE_KEY } }]);
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId, "cli");
    setRunThread(db, runId, pmThreadId);
    saveProjectSetting(db, projectId, "secrets.allow", "OVH_SSH");
    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;
    const started = await call("lane_pilot_errand", { task: "Deploy the build to the server over SSH", authorized: true, accounts: ["OVH_SSH"] });
    expect(started).toMatchObject({ threadId: "errand-thread", state: "running" });
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("- OVH_SSH (ssh)");
    expect(prompt).not.toContain("QUJDREVGR0hJSktMTU5PUA");
    say(`Deployed. I ran ssh with the key:\n${PRIVATE_KEY}\nERRAND: done`);
    const waited = await call("lane_pilot_wait_errand", { threadId: "errand-thread", timeoutSec: 5 });
    expect(waited.state).toBe("done");
    expect(waited.output).not.toContain("QUJDREVGR0hJSktMTU5PUA");
    expect(waited.output).toContain("***");
  });
});
