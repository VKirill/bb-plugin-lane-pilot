import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskV2 } from "../../src/contracts";
import { hostContract } from "../../src/contracts";
import { listSecretIssuance, openDatabase, saveProjectSetting } from "../../src/database";
import { forgetSecrets } from "@lane-pilot/kit";
import { createSecrets, envForRecord, SecretsNotReadyError, secretProblem } from "../../src/rooms/secrets/server/secrets";
import { createWriterVerify } from "../../src/server/writer/verify";
import { runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";

// Test values only: none of them is a real credential.
const STRIPE = "test-stripe-Zq81xW0pLm";
const PASSWORD = "test-pass-Kd93LmQ2xV";

type Row = { name:string; kind:"secret" | "login" | "ssh" | "ftp"; value?:string | null; access?:Record<string, unknown> | null };
const CATALOG:Row[] = [
  { name:"STRIPE_TEST_KEY", kind:"secret", value:STRIPE },
  { name:"OTHER_KEY", kind:"secret", value:"test-other-1234567" },
  { name:"SHOP_LOGIN", kind:"login", value:null, access:{ username:"qa", password:PASSWORD, url:"https://shop.test" } },
  { name:"DEPLOY_SSH", kind:"ssh", value:null, access:{ host:"h", username:"u", privateKey:"test-private-key-material" } },
];
const fakeCatalog = (rows:Row[] = CATALOG, reads:string[] = []) => ({ plugins:{ callRpc: async ({ pluginId, method, input }:{ pluginId:string; method:string; input:{ name?:string } }) => {
  expect(pluginId).toBe("env-catalog");
  if (method === "env_list") return { variables:rows.map(({ name, kind }) => ({ name, kind })) };
  reads.push(input.name!);
  const row = rows.find((candidate) => candidate.name === input.name);
  if (!row) throw new Error("not found");
  return { value:null, access:null, ...row };
} } });

afterEach(() => forgetSecrets());

describe("Env Catalog client", () => {
  it("hands out only declared and allowed names, and never reads another", async () => {
    const reads:string[] = [];
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:fakeCatalog(CATALOG, reads) as never });
    const got = await createSecrets({ bb }).resolve({ declared:["STRIPE_TEST_KEY", "OTHER_KEY", "NOPE", "DEPLOY_SSH"], allowed:["STRIPE_TEST_KEY", "NOPE", "DEPLOY_SSH"] });
    expect(got.env).toEqual({ STRIPE_TEST_KEY:STRIPE });
    expect(got.denied).toEqual(["OTHER_KEY"]);
    expect(got.missing).toEqual(["NOPE"]);
    expect(got.wrongKind).toEqual(["DEPLOY_SSH"]);
    expect(reads).toEqual(["STRIPE_TEST_KEY"]);
    expect(secretProblem(got)).toEqual(["OTHER_KEY", "NOPE", "DEPLOY_SSH"]);
  });

  it("expands a login into user, password and url variables", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:fakeCatalog() as never });
    const got = await createSecrets({ bb }).resolve({ declared:["SHOP_LOGIN"], allowed:["SHOP_LOGIN"] });
    expect(got.byName.SHOP_LOGIN).toEqual({ SHOP_LOGIN_USERNAME:"qa", SHOP_LOGIN_PASSWORD:PASSWORD, SHOP_LOGIN_URL:"https://shop.test" });
    expect(envForRecord({ name:"X", kind:"ssh", value:null, access:{ privateKey:"k" } })).toBeNull();
  });

  it("feature test: without Env Catalog nothing is handed out and the answer says so", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ plugins:{ callRpc: async () => { throw new Error("plugin not found"); } } } as never });
    const secrets = createSecrets({ bb });
    expect(await secrets.list()).toBeNull();
    const got = await secrets.resolve({ declared:["A_KEY"], allowed:["A_KEY"] });
    expect(got).toMatchObject({ unavailable:true, env:{}, missing:["A_KEY"] });
    const bare = createFakePluginHost({ pluginId:"lane-pilot" });
    expect(await createSecrets({ bb:bare.bb }).list()).toBeNull();
  });
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "lp-secrets-")));
const task = (verification:TaskV2["verification"]):TaskV2 => ({
  schema_version:2, id:"t", title:"t", risk:"low", lane:"writer", project_cwd:root, read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.txt"], owns_paths:["a.txt"], never_touch:[], depends_on:[], objective:"x", acceptance:["x"], verify:"tests", verification,
});

function verifier(options:{ allow?:string; rows?:Row[]; printed?:string } = {}) {
  const calls:Array<{ method:string; input:Record<string, unknown>; options:Record<string, unknown> }> = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:fakeCatalog(options.rows) as never });
  const db = openDatabase(bb);
  if (options.allow !== undefined) saveProjectSetting(db, "P", "secrets.allow", options.allow);
  const host = { call: vi.fn(async (method:string, input:Record<string, unknown>, callOptions:Record<string, unknown>) => {
    calls.push({ method, input, options:callOptions });
    return { hostId:"h", backend:"macos-seatbelt", workspacePath:root, cwd:root, exitCode:1, policySha256:"a".repeat(64),
      stdout:`token is ${STRIPE}\n`, stderr:`bad ${PASSWORD} and ${Buffer.from(STRIPE).toString("base64")}` };
  }) };
  const ctx = { bb, db, host, runPolicyFor: () => ({ pools:{ verification:2 } }), secrets:createSecrets({ bb }) };
  const services = { runWriterPool:{ acquire: async () => () => undefined } };
  return { calls, db, verify:createWriterVerify(ctx as never, services as never) };
}
const config = { hostId:"h", projectId:"P" } as never;

describe("secrets in a check", () => {
  it("passes the declared secret to its own check only, as env, and masks what the check prints", async () => {
    const { calls, verify } = verifier({ allow:"STRIPE_TEST_KEY, SHOP_LOGIN" });
    const results = await verify.runVerification(config, task([
      { command:"node e2e.js", cwd:root, secrets:["STRIPE_TEST_KEY"] },
      { command:"node plain.js", cwd:root },
    ]), undefined, "thr-writer");
    const own = calls.filter((call) => call.input.command === "node e2e.js");
    // No BB terminal for a check with secrets (its command line and screen would carry them): a plain host call only.
    expect(own.map((call) => call.method)).toEqual(["runSandboxedCommand", "runSandboxedCommand"]);
    expect(own.every((call) => JSON.stringify(call.input.env) === JSON.stringify({ STRIPE_TEST_KEY:STRIPE }))).toBe(true);
    expect(calls.filter((call) => call.input.command === "node plain.js" && call.method === "runSandboxedCommand").every((call) => !("env" in call.input))).toBe(true);
    expect(JSON.stringify(results)).not.toContain(STRIPE);
    expect(JSON.stringify(results)).not.toContain(Buffer.from(STRIPE).toString("base64"));
    expect(results.find((row) => row.command === "node e2e.js")!.stdout).toBe("token is ***\n");
  });

  it("keeps a background check with secrets out of the host's job store", async () => {
    const { calls, verify } = verifier({ allow:"STRIPE_TEST_KEY" });
    await verify.runVerification(config, task([{ command:"node e2e.js", cwd:root, secrets:["STRIPE_TEST_KEY"] }]), undefined, undefined, { background:true, jobKey:"k" });
    expect(calls[0]!.options).not.toHaveProperty("job");
    expect(hostContract.runSandboxedCommand.input.safeParse(calls[0]!.input).success).toBe(true);
  });

  it("a secret the project list leaves out is not fetched, and the check does not run", async () => {
    const { calls, verify } = verifier({ allow:"OTHER_KEY" });
    const failure = await verify.runVerification(config, task([{ command:"node e2e.js", cwd:root, secrets:["STRIPE_TEST_KEY"] }])).catch((cause:unknown) => cause);
    expect(failure).toBeInstanceOf(SecretsNotReadyError);
    expect((failure as Error).message).toBe("waiting_secret:STRIPE_TEST_KEY");
    expect(calls).toEqual([]);
  });

  // Owner decision 2026-10-08: an empty list allows every name the task contract declares; a list only narrows.
  it("an empty secrets.allow lets the catalog entry the task names reach its check", async () => {
    const { verify, calls } = verifier();
    await expect(verify.runVerification(config, task([{ command:"x", cwd:root, secrets:["STRIPE_TEST_KEY"] }]))).resolves.toBeDefined();
    expect(calls.some((call) => call.method === "runSandboxedCommand")).toBe(true);
  });

  it("`*` allows any name", async () => {
    const { verify, calls } = verifier({ allow:"*" });
    await expect(verify.runVerification(config, task([{ command:"x", cwd:root, secrets:["STRIPE_TEST_KEY"] }]))).resolves.toBeDefined();
    expect(calls.some((call) => call.method === "runSandboxedCommand")).toBe(true);
  });

  it("journals who was given which name, never the value", async () => {
    const { verify, db } = verifier({ allow:"STRIPE_TEST_KEY" });
    await verify.runVerification(config, task([{ command:"node e2e.js", cwd:root, secrets:["STRIPE_TEST_KEY"] }]), "run-1", "thr-writer");
    const rows = listSecretIssuance(db, "P");
    // The fake host fails the check, so the flaky rerun hands the name out a second time: each run is one entry.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ consumer:"check", runId:"run-1", taskId:"t", threadId:"thr-writer", checkCommand:"node e2e.js", secretName:"STRIPE_TEST_KEY", hostId:"h" });
    expect(JSON.stringify(rows)).not.toContain(STRIPE);
  });

  it("a name outside a restricting secrets.allow waits", async () => {
    const { verify } = verifier({ allow:"OTHER_KEY" });
    await expect(verify.runVerification(config, task([{ command:"x", cwd:root, secrets:["STRIPE_TEST_KEY"] }]))).rejects.toThrow("waiting_secret:STRIPE_TEST_KEY");
  });
});

describe.runIf(process.platform === "darwin")("the sandbox on this machine", () => {
  it("gives the command the secret in its environment and masks it in the output", async () => {
    const result = await runSandboxedCommandOnHost({ requestedHostId:"h", workspacePath:root, cwd:root,
      command:'printf "%s" "$MY_TEST_SECRET"; printf "len=%s" "${#MY_TEST_SECRET}" >&2', env:{ MY_TEST_SECRET:STRIPE, PATH:"/evil" } });
    expect(result.stdout).toBe("***");
    expect(result.stderr).toBe(`len=${STRIPE.length}`);
  });
});
